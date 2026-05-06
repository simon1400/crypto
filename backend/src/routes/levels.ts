import { Router } from 'express'
import { prisma } from '../db/prisma'
import { runLevelsScanCycle, DEFAULT_SETUPS } from '../services/levelsLiveScanner'
import { runLevelsTrackerCycle } from '../services/levelsTracker'
import { loadHistorical } from '../scalper/historicalLoader'
import {
  precomputeLevelsV2, aggregateDailyToWeekly, DEFAULT_LEVELS_V2, type LevelV2,
} from '../scalper/levelsEngine2'

/** Get the latest 5m close for a symbol — used as "current market price" for manual close. */
async function getCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch (e) {
    return null
  }
}

const router = Router()

// GET /api/levels?status=NEW,ACTIVE&symbol=BTCUSDT&limit=100
router.get('/', async (req, res) => {
  try {
    const { market, status, symbol, side, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (market) where.market = market
    if (symbol) where.symbol = symbol
    if (side) where.side = side
    if (status) where.status = { in: status.split(',') }

    const [data, total] = await Promise.all([
      prisma.levelsSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.levelsSignal.count({ where }),
    ])
    res.json({ data, total })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/stats', async (_req, res) => {
  try {
    const all = await prisma.levelsSignal.findMany({
      where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT'] } },
    })
    const bySymbol: Record<string, { trades: number; wins: number; totalR: number }> = {}
    for (const s of all) {
      const sym = s.symbol
      if (!bySymbol[sym]) bySymbol[sym] = { trades: 0, wins: 0, totalR: 0 }
      bySymbol[sym].trades++
      bySymbol[sym].totalR += s.realizedR
      if (s.realizedR > 0) bySymbol[sym].wins++
    }
    const totalTrades = all.length
    const totalR = all.reduce((a, s) => a + s.realizedR, 0)
    const wins = all.filter((s) => s.realizedR > 0).length
    res.json({
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades > 0 ? wins / totalTrades : 0,
      totalR,
      expectancyR: totalTrades > 0 ? totalR / totalTrades : 0,
      bySymbol,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.levelsConfig.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1, enabled: false, symbolsEnabled: [],
        cronIntervalMin: 5, expiryHours: 24,
        notifyOnNew: true, notifyOnClose: true,
      },
    })
    res.json({ config: cfg, defaultSetups: DEFAULT_SETUPS })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const { enabled, symbolsEnabled, expiryHours, notifyOnNew, notifyOnClose } = req.body
    const cfg = await prisma.levelsConfig.upsert({
      where: { id: 1 },
      update: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(symbolsEnabled !== undefined ? { symbolsEnabled } : {}),
        ...(expiryHours !== undefined ? { expiryHours } : {}),
        ...(notifyOnNew !== undefined ? { notifyOnNew } : {}),
        ...(notifyOnClose !== undefined ? { notifyOnClose } : {}),
      },
      create: {
        id: 1,
        enabled: enabled ?? false,
        symbolsEnabled: symbolsEnabled ?? [],
        cronIntervalMin: 5,
        expiryHours: expiryHours ?? 24,
        notifyOnNew: notifyOnNew ?? true,
        notifyOnClose: notifyOnClose ?? true,
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/scan-now', async (_req, res) => {
  try {
    const result = await runLevelsScanCycle()
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/track-now', async (_req, res) => {
  try {
    const processed = await runLevelsTrackerCycle()
    res.json({ processed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const s = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!s) return res.status(404).json({ error: 'Not found' })
    res.json(s)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const updated = await prisma.levelsSignal.update({
      where: { id },
      data: { status: 'EXPIRED', closedAt: new Date() },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Edit a signal manually — adjust entry/SL/currentStop/tpLadder.
 * Useful when the bot's calculated entry doesn't match where the user actually entered,
 * or when the user wants to move SL/TP after the trade is open.
 *
 * NOTE: this does NOT recalculate realized R for already-filled TPs. Those stay as is.
 * Only future tracking uses the new prices.
 */
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const sig = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!sig) return res.status(404).json({ error: 'Not found' })

    const { entryPrice, stopLoss, currentStop, tpLadder, reason } = req.body
    const data: any = {}
    if (typeof entryPrice === 'number' && entryPrice > 0) data.entryPrice = entryPrice
    if (typeof stopLoss === 'number' && stopLoss > 0) {
      data.stopLoss = stopLoss
      // If we're editing initial SL while no fills happened yet, also update initialStop
      const closes = (sig.closes as any[]) ?? []
      if (closes.length === 0) data.initialStop = stopLoss
      data.currentStop = stopLoss
    }
    if (typeof currentStop === 'number' && currentStop > 0) data.currentStop = currentStop
    if (Array.isArray(tpLadder) && tpLadder.every((p) => typeof p === 'number' && p > 0)) {
      data.tpLadder = tpLadder
    }
    if (typeof reason === 'string') {
      data.reason = `${sig.reason} · [edited: ${reason}]`
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }
    const updated = await prisma.levelsSignal.update({ where: { id }, data })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Close the remaining position at current market price.
 * Records a 'MANUAL' close in `closes` log with R calculated from initialStop distance.
 */
router.post('/:id/close-market', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const sig = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!sig) return res.status(404).json({ error: 'Not found' })
    if (sig.status === 'CLOSED' || sig.status === 'SL_HIT' || sig.status === 'EXPIRED' || sig.status === 'CANCELLED') {
      return res.status(400).json({ error: `Already ${sig.status}` })
    }
    if (sig.status === 'PENDING' || sig.status === 'AWAITING_CONFIRM') {
      return res.status(400).json({ error: `Cannot close in ${sig.status} state — use cancel-pending` })
    }
    const price = await getCurrentPrice(sig.symbol)
    if (price === null) return res.status(503).json({ error: 'Could not fetch market price' })

    const closes = ((sig.closes as any[]) ?? []) as any[]
    const closedPctSoFar = closes.reduce((a, c) => a + (c.percent ?? 0), 0)
    const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
    if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Position fully closed' })

    const isLong = sig.side === 'BUY'
    const initialRisk = Math.abs(sig.entryPrice - sig.initialStop)
    const pnlR = ((isLong ? price - sig.entryPrice : sig.entryPrice - price) / initialRisk) * remainingFrac
    closes.push({
      price, percent: remainingFrac * 100, pnlR,
      closedAt: new Date().toISOString(),
      reason: 'MANUAL',
    })
    const realizedR = (sig.realizedR ?? 0) + pnlR
    const updated = await prisma.levelsSignal.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closes: closes as any,
        realizedR,
        closedAt: new Date(),
        lastPriceCheck: price,
        lastPriceCheckAt: new Date(),
      },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Close at a manually specified price (useful when user closed externally and wants
 * to record the actual fill price, not current market).
 * Body: { price: number, percent?: number (default = remaining) }
 */
router.post('/:id/close-manual', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const sig = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!sig) return res.status(404).json({ error: 'Not found' })
    if (sig.status === 'CLOSED' || sig.status === 'SL_HIT' || sig.status === 'EXPIRED' || sig.status === 'CANCELLED') {
      return res.status(400).json({ error: `Already ${sig.status}` })
    }
    if (sig.status === 'PENDING' || sig.status === 'AWAITING_CONFIRM') {
      return res.status(400).json({ error: `Cannot close in ${sig.status} state — use cancel-pending` })
    }
    const { price, percent } = req.body as { price?: number; percent?: number }
    if (typeof price !== 'number' || price <= 0) {
      return res.status(400).json({ error: 'price required' })
    }

    const closes = ((sig.closes as any[]) ?? []) as any[]
    const closedPctSoFar = closes.reduce((a, c) => a + (c.percent ?? 0), 0)
    const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
    if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Position fully closed' })

    const fillPct = typeof percent === 'number' ? Math.min(percent, remainingFrac * 100) : remainingFrac * 100
    const fillFrac = fillPct / 100
    const isLong = sig.side === 'BUY'
    const initialRisk = Math.abs(sig.entryPrice - sig.initialStop)
    const pnlR = ((isLong ? price - sig.entryPrice : sig.entryPrice - price) / initialRisk) * fillFrac
    closes.push({
      price, percent: fillPct, pnlR,
      closedAt: new Date().toISOString(),
      reason: 'MANUAL',
    })
    const realizedR = (sig.realizedR ?? 0) + pnlR
    const newRemaining = remainingFrac - fillFrac
    const status = newRemaining < 1e-6 ? 'CLOSED' : sig.status
    const updated = await prisma.levelsSignal.update({
      where: { id },
      data: {
        status,
        closes: closes as any,
        realizedR,
        ...(status === 'CLOSED' ? { closedAt: new Date() } : {}),
        lastPriceCheck: price,
        lastPriceCheckAt: new Date(),
      },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Cancel a PENDING or AWAITING_CONFIRM (LIMIT) signal manually.
 * Marks status as CANCELLED, sets closedAt.
 */
router.post('/:id/cancel-pending', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const sig = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!sig) return res.status(404).json({ error: 'Not found' })
    if (sig.status !== 'PENDING' && sig.status !== 'AWAITING_CONFIRM') {
      return res.status(400).json({ error: `Cannot cancel — status is ${sig.status}` })
    }
    const updated = await prisma.levelsSignal.update({
      where: { id },
      data: { status: 'CANCELLED', closedAt: new Date() },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/levels/key-levels/:symbol?market=CRYPTO&entryPrice=88.81
 * Returns the structural reference levels (PDH/PDL/PWH/PWL + nearest fractals) to draw
 * on the position chart. Filters to levels within ±5% of entryPrice (or ±5% of latest close).
 */
router.get('/key-levels/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol
    const entryPrice = parseFloat(req.query.entryPrice as string) || 0

    const m5  = await loadHistorical(symbol, '5m',  1, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', 1, 'bybit', 'linear')
    const h1  = await loadHistorical(symbol, '1h',  1, 'bybit', 'linear')
    const d1  = await loadHistorical(symbol, '1d',  3, 'bybit', 'linear')
    if (m5.length < 50) return res.json({ levels: [] })

    const w1 = aggregateDailyToWeekly(d1)
    const cfg = { ...DEFAULT_LEVELS_V2, fiboMode: 'off' as const }
    const pre = precomputeLevelsV2(m5, d1, w1, cfg, m15, h1)
    const lastIdx = m5.length - 1
    const refPrice = entryPrice > 0 ? entryPrice : m5[lastIdx].close
    const tolerance = refPrice * 0.05  // ±5% window

    const activeIdxs = pre.activeAt[lastIdx] ?? []
    const seen = new Set<string>()
    type Out = { price: number; label: string; kind: string }
    const out: Out[] = []
    const labelMap: Record<string, { kind: string; label: string }> = {
      PDH: { kind: 'PDH', label: 'PDH' },
      PDL: { kind: 'PDL', label: 'PDL' },
      PWH: { kind: 'PWH', label: 'PWH' },
      PWL: { kind: 'PWL', label: 'PWL' },
      FRACTAL_HIGH_H1: { kind: 'FRACTAL_H1', label: 'F H1' },
      FRACTAL_LOW_H1: { kind: 'FRACTAL_H1', label: 'F H1' },
      FRACTAL_HIGH_M15: { kind: 'FRACTAL_M15', label: 'F M15' },
      FRACTAL_LOW_M15: { kind: 'FRACTAL_M15', label: 'F M15' },
      FRACTAL_HIGH: { kind: 'FRACTAL_5M', label: 'F 5m' },
      FRACTAL_LOW: { kind: 'FRACTAL_5M', label: 'F 5m' },
    }
    for (const li of activeIdxs) {
      const lvl: LevelV2 = pre.levels[li]
      const meta = labelMap[lvl.source]
      if (!meta) continue
      // Skip 5m fractals — too noisy for the chart; user wants the meaningful ones.
      if (meta.kind === 'FRACTAL_5M') continue
      // ±5% filter
      if (Math.abs(lvl.price - refPrice) > tolerance) continue
      const key = `${meta.kind}:${lvl.price.toFixed(8)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ price: lvl.price, label: meta.label, kind: meta.kind })
    }
    // Sort by price
    out.sort((a, b) => a.price - b.price)
    res.json({ levels: out })
  } catch (e: any) {
    console.error('[key-levels]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
