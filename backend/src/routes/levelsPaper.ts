import { Router } from 'express'
import { prisma } from '../db/prisma'
import { runPaperCycle, resetPaperAccount } from '../services/levelsPaperTrader'
import { loadHistorical } from '../scalper/historicalLoader'
import { loadForexHistorical } from '../scalper/forexLoader'

async function getCurrentPrice(symbol: string, market: string): Promise<number | null> {
  try {
    const candles = market === 'FOREX'
      ? await loadForexHistorical(symbol, '5m', 1)
      : await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch (e) {
    return null
  }
}

/** Recompute deposit + stats after a manual close — keep config in sync. */
async function recomputeDepositAndStats(): Promise<void> {
  const cfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
  if (!cfg) return
  const closed = await prisma.levelsPaperTrade.findMany({
    where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
    select: { netPnlUsd: true, openedAt: true, closedAt: true },
  })
  const totalTrades = closed.length
  const totalWins = closed.filter((t) => t.netPnlUsd > 0).length
  const totalLosses = closed.filter((t) => t.netPnlUsd < 0).length
  const totalPnLUsd = closed.reduce((a, t) => a + t.netPnlUsd, 0)
  const newDeposit = cfg.startingDepositUsd + totalPnLUsd
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0
  await prisma.levelsPaperConfig.update({
    where: { id: 1 },
    data: { currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
            totalTrades, totalWins, totalLosses, totalPnLUsd },
  })
}

const router = Router()

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.levelsPaperConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const {
      enabled, riskPctPerTrade, feesRoundTripPct,
      dailyLossLimitPct, weeklyLossLimitPct,
      maxConcurrentPositions, maxPositionsPerSymbol,
    } = req.body
    const cfg = await prisma.levelsPaperConfig.update({
      where: { id: 1 },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(riskPctPerTrade !== undefined ? { riskPctPerTrade } : {}),
        ...(feesRoundTripPct !== undefined ? { feesRoundTripPct } : {}),
        ...(dailyLossLimitPct !== undefined ? { dailyLossLimitPct } : {}),
        ...(weeklyLossLimitPct !== undefined ? { weeklyLossLimitPct } : {}),
        ...(maxConcurrentPositions !== undefined ? { maxConcurrentPositions } : {}),
        ...(maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol } : {}),
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/reset', async (req, res) => {
  try {
    const { startingDepositUsd } = req.body
    const cfg = await resetPaperAccount(startingDepositUsd)
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/cycle-now', async (_req, res) => {
  try {
    const result = await runPaperCycle()
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/trades', async (req, res) => {
  try {
    const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (status) where.status = { in: status.split(',') }
    if (symbol) where.symbol = symbol
    const [data, total] = await Promise.all([
      prisma.levelsPaperTrade.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.levelsPaperTrade.count({ where }),
    ])
    res.json({ data, total })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/stats', async (_req, res) => {
  try {
    const cfg = await prisma.levelsPaperConfig.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    const closed = await prisma.levelsPaperTrade.findMany({
      where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
      select: { netPnlUsd: true, openedAt: true, closedAt: true, symbol: true },
    })
    const winRate = closed.length > 0 ? closed.filter((t) => t.netPnlUsd > 0).length / closed.length : 0

    // Equity curve — group closed trades by day
    const byDay: Record<string, number> = {}
    for (const t of closed) {
      const day = (t.closedAt ?? t.openedAt).toISOString().slice(0, 10)
      byDay[day] = (byDay[day] ?? 0) + t.netPnlUsd
    }
    const equityCurve: Array<{ date: string; pnl: number; equity: number }> = []
    let running = cfg.startingDepositUsd
    for (const date of Object.keys(byDay).sort()) {
      running += byDay[date]
      equityCurve.push({ date, pnl: byDay[date], equity: running })
    }

    // Per-symbol breakdown
    const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {}
    for (const t of closed) {
      bySymbol[t.symbol] = bySymbol[t.symbol] ?? { trades: 0, wins: 0, pnl: 0 }
      bySymbol[t.symbol].trades++
      bySymbol[t.symbol].pnl += t.netPnlUsd
      if (t.netPnlUsd > 0) bySymbol[t.symbol].wins++
    }

    res.json({
      config: cfg,
      winRate,
      returnPct: cfg.startingDepositUsd > 0 ? ((cfg.currentDepositUsd - cfg.startingDepositUsd) / cfg.startingDepositUsd) * 100 : 0,
      bySymbol,
      equityCurve,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/trades/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    res.json(trade)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Edit paper trade — adjust entry/SL/currentStop/tpLadder. Recalculates position size
 * if entry or SL change AND no fills yet, otherwise keeps existing position size.
 */
router.put('/trades/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })

    const { entryPrice, stopLoss, currentStop, tpLadder } = req.body
    const data: any = {}
    const fills = (trade.closes as any[]) ?? []
    const noFillsYet = fills.length === 0

    if (typeof entryPrice === 'number' && entryPrice > 0) data.entryPrice = entryPrice
    if (typeof stopLoss === 'number' && stopLoss > 0) {
      data.stopLoss = stopLoss
      if (noFillsYet) data.initialStop = stopLoss
      data.currentStop = stopLoss
    }
    if (typeof currentStop === 'number' && currentStop > 0) data.currentStop = currentStop
    if (Array.isArray(tpLadder) && tpLadder.every((p) => typeof p === 'number' && p > 0)) {
      data.tpLadder = tpLadder
    }
    // If editing entry/SL with no fills yet → recalc position size
    if (noFillsYet && (data.entryPrice || data.stopLoss)) {
      const newEntry = data.entryPrice ?? trade.entryPrice
      const newSL = data.initialStop ?? trade.initialStop
      const slDist = Math.abs(newEntry - newSL)
      if (slDist > 0) {
        const positionUnits = trade.riskUsd / slDist
        data.positionUnits = positionUnits
        data.positionSizeUsd = newEntry * positionUnits
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No valid fields' })
    }
    const updated = await prisma.levelsPaperTrade.update({ where: { id }, data })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/** Close paper trade at current market price. */
router.post('/trades/:id/close-market', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    if (['CLOSED', 'SL_HIT', 'EXPIRED'].includes(trade.status)) {
      return res.status(400).json({ error: `Already ${trade.status}` })
    }
    const price = await getCurrentPrice(trade.symbol, trade.market)
    if (price === null) return res.status(503).json({ error: 'Could not fetch price' })

    const fills = ((trade.closes as any[]) ?? []) as any[]
    const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
    const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
    if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Already closed' })

    const isLong = trade.side === 'BUY'
    const initialRisk = Math.abs(trade.entryPrice - trade.initialStop)
    const pnlR = ((isLong ? price - trade.entryPrice : trade.entryPrice - price) / initialRisk) * remainingFrac
    const fillUnits = trade.positionUnits * remainingFrac
    const pnlUsd = (isLong ? price - trade.entryPrice : trade.entryPrice - price) * fillUnits
    fills.push({
      price, percent: remainingFrac * 100, pnlR, pnlUsd,
      closedAt: new Date().toISOString(),
      reason: 'MANUAL',
    })
    // Apply fees on this fill
    const cfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
    const feeRate = cfg ? cfg.feesRoundTripPct / 100 : 0
    const notional = trade.positionUnits * price * remainingFrac
    const newFeeUsd = notional * feeRate
    const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
    const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
    const netPnlUsd = realizedPnlUsd - totalFeesUsd
    const realizedR = trade.realizedR + pnlR

    await prisma.levelsPaperTrade.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closes: fills as any,
        realizedR, realizedPnlUsd,
        feesPaidUsd: totalFeesUsd, netPnlUsd,
        closedAt: new Date(),
        lastPriceCheck: price,
        lastPriceCheckAt: new Date(),
      },
    })
    await recomputeDepositAndStats()
    const fresh = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    res.json(fresh)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/** Close paper trade at a manually specified price + percent. */
router.post('/trades/:id/close-manual', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    if (['CLOSED', 'SL_HIT', 'EXPIRED'].includes(trade.status)) {
      return res.status(400).json({ error: `Already ${trade.status}` })
    }
    const { price, percent } = req.body as { price?: number; percent?: number }
    if (typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'price required' })

    const fills = ((trade.closes as any[]) ?? []) as any[]
    const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
    const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
    if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Already closed' })

    const fillPct = typeof percent === 'number' ? Math.min(percent, remainingFrac * 100) : remainingFrac * 100
    const fillFrac = fillPct / 100
    const isLong = trade.side === 'BUY'
    const initialRisk = Math.abs(trade.entryPrice - trade.initialStop)
    const pnlR = ((isLong ? price - trade.entryPrice : trade.entryPrice - price) / initialRisk) * fillFrac
    const fillUnits = trade.positionUnits * fillFrac
    const pnlUsd = (isLong ? price - trade.entryPrice : trade.entryPrice - price) * fillUnits
    fills.push({
      price, percent: fillPct, pnlR, pnlUsd,
      closedAt: new Date().toISOString(),
      reason: 'MANUAL',
    })
    const cfg = await prisma.levelsPaperConfig.findUnique({ where: { id: 1 } })
    const feeRate = cfg ? cfg.feesRoundTripPct / 100 : 0
    const notional = trade.positionUnits * price * fillFrac
    const newFeeUsd = notional * feeRate
    const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
    const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
    const netPnlUsd = realizedPnlUsd - totalFeesUsd
    const realizedR = trade.realizedR + pnlR
    const newRemaining = remainingFrac - fillFrac
    const status = newRemaining < 1e-6 ? 'CLOSED' : trade.status

    await prisma.levelsPaperTrade.update({
      where: { id },
      data: {
        status,
        closes: fills as any,
        realizedR, realizedPnlUsd,
        feesPaidUsd: totalFeesUsd, netPnlUsd,
        ...(status === 'CLOSED' ? { closedAt: new Date() } : {}),
        lastPriceCheck: price,
        lastPriceCheckAt: new Date(),
      },
    })
    await recomputeDepositAndStats()
    const fresh = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    res.json(fresh)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
