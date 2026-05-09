/**
 * Variant-parameterised router factory for the Daily Breakout paper trader.
 *
 * Both /api/breakout-paper (variant A, prod) and /api/breakout-paper-b (variant B,
 * alternate sizing experiment) mount the same set of endpoints. This factory builds
 * a Router for a given variant, routing all DB reads/writes to the variant's
 * config + trade tables via the breakoutVariant helper.
 *
 * Variant A is allowed to mutate the shared BreakoutSignal table (legacy behavior:
 * DELETE /trades/:id also deletes the originating signal so the cron doesn't
 * re-open it). Variant B does NOT touch shared signals — deleting a B trade only
 * removes the B row; the signal stays for variant A.
 */

import { Router } from 'express'
import { prisma } from '../db/prisma'
import {
  runBreakoutPaperCycle, resetBreakoutPaperAccount, syncSignalStatus, forceOpenSignal,
} from '../services/dailyBreakoutPaperTrader'
import { loadHistorical } from '../scalper/historicalLoader'
import { fetchPricesBatch } from '../services/market'
import { BreakoutVariant, configModel, tradeModel } from '../services/breakoutVariant'

async function getCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch { return null }
}

function recalcFees(trade: any, feeRatePct: number): { feesPaidUsd: number; netPnlUsd: number } {
  const closes = ((trade.closes as any[]) ?? []) as Array<{ price: number; percent: number }>
  let feesPaidUsd = 0
  for (const c of closes) {
    const notional = trade.positionUnits * c.price * (c.percent / 100)
    feesPaidUsd += notional * (feeRatePct / 100)
  }
  const netPnlUsd = (trade.realizedPnlUsd ?? 0) - feesPaidUsd
  return { feesPaidUsd, netPnlUsd }
}

export function buildBreakoutPaperRouter(variant: BreakoutVariant): Router {
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any

  async function recomputeDepositAndStats(): Promise<void> {
    const cfg = await cm.findUnique({ where: { id: 1 } })
    if (!cfg) return
    const trades = await tm.findMany({
      where: {
        OR: [
          { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
          { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
        ],
      },
      select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
    })
    const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
    const closedOnly = trades.filter((t: any) => closedStatuses.has(t.status))
    const totalTrades = closedOnly.length
    const totalWins = closedOnly.filter((t: any) => t.netPnlUsd > 0).length
    const totalLosses = closedOnly.filter((t: any) => t.netPnlUsd < 0).length
    const totalPnLUsd = trades.reduce((a: number, t: any) => {
      const realizedNet = closedStatuses.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
      return a + realizedNet
    }, 0)
    const newDeposit = cfg.startingDepositUsd + totalPnLUsd
    const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
    const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0
    await cm.update({
      where: { id: 1 },
      data: {
        currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
        totalTrades, totalWins, totalLosses, totalPnLUsd,
      },
    })
  }

  const router = Router()

  router.get('/config', async (_req, res) => {
    try {
      const cfg = await cm.upsert({
        where: { id: 1 }, update: {}, create: { id: 1 },
      })
      res.json(cfg)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.put('/config', async (req, res) => {
    try {
      const {
        enabled, riskPctPerTrade, feesRoundTripPct, autoTrailingSL,
        targetMarginPct, marginGuardEnabled, marginGuardAutoClose,
        dailyLossLimitPct, weeklyLossLimitPct,
        maxConcurrentPositions, maxPositionsPerSymbol,
      } = req.body
      const cfg = await cm.update({
        where: { id: 1 },
        data: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(riskPctPerTrade !== undefined ? { riskPctPerTrade } : {}),
          ...(feesRoundTripPct !== undefined ? { feesRoundTripPct } : {}),
          ...(autoTrailingSL !== undefined ? { autoTrailingSL } : {}),
          ...(targetMarginPct !== undefined ? { targetMarginPct } : {}),
          ...(marginGuardEnabled !== undefined ? { marginGuardEnabled } : {}),
          ...(marginGuardAutoClose !== undefined ? { marginGuardAutoClose } : {}),
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
      const cfg = await resetBreakoutPaperAccount(startingDepositUsd, variant)
      res.json(cfg)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // wipe-all: variant A wipes shared signals (legacy behavior). Variant B only
  // wipes its own trades + resets its own config — never touches shared signals.
  router.post('/wipe-all', async (req, res) => {
    try {
      const { startingDepositUsd } = req.body as { startingDepositUsd?: number }
      const tradesDeleted = await tm.deleteMany({})
      let signalsDeleted = 0
      if (variant === 'A') {
        const r = await prisma.breakoutSignal.deleteMany({})
        signalsDeleted = r.count
      }
      const cfg = await resetBreakoutPaperAccount(startingDepositUsd, variant)
      res.json({
        ok: true,
        deletedTrades: tradesDeleted.count,
        deletedSignals: signalsDeleted,
        config: cfg,
      })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/cycle-now', async (_req, res) => {
    try {
      const result = await runBreakoutPaperCycle(variant)
      res.json(result)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/trades/live', async (_req, res) => {
    try {
      const trades = await tm.findMany({
        where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      })
      if (trades.length === 0) return res.json([])

      const symbols: string[] = trades.map((t: any) => String(t.symbol))
      const prices = await fetchPricesBatch(symbols)

      const result = await Promise.all(trades.map(async (t: any) => {
        const price: number | null = prices[t.symbol] ?? null
        if (price == null) {
          return { id: t.id, status: t.status, currentPrice: null, unrealizedPnl: 0, unrealizedPnlPct: 0 }
        }
        const fills = (t.closes as any[]) ?? []
        const closedPctSoFar = fills.reduce((a: number, c: any) => a + (c.percent ?? 0), 0)
        const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
        if (remainingFrac < 1e-6) {
          return { id: t.id, status: t.status, currentPrice: price, unrealizedPnl: 0, unrealizedPnlPct: 0, remainingUnrealizedPnl: 0, remainingUnrealizedPnlPct: 0 }
        }
        const isLong = t.side === 'BUY'
        const fillUnits = t.positionUnits * remainingFrac
        const unrealizedGross = (isLong ? price - t.entryPrice : t.entryPrice - price) * fillUnits
        const feesPaidUsd = t.feesPaidUsd ?? 0
        const feeRatePct = t.feesRoundTripPct ?? 0.08
        const exitFeesIfClosedNow = t.positionUnits * price * remainingFrac * (feeRatePct / 100)
        const totalUnrealized = (t.realizedPnlUsd ?? 0) + unrealizedGross - feesPaidUsd - exitFeesIfClosedNow
        const unrealizedPnlPct = t.depositAtEntryUsd > 0
          ? (totalUnrealized / t.depositAtEntryUsd) * 100 : 0
        const remainingUnrealized = unrealizedGross - exitFeesIfClosedNow
        const remainingUnrealizedPnlPct = t.depositAtEntryUsd > 0
          ? (remainingUnrealized / t.depositAtEntryUsd) * 100 : 0
        return {
          id: t.id, status: t.status, currentPrice: price,
          unrealizedPnl: Math.round(totalUnrealized * 100) / 100,
          unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
          remainingUnrealizedPnl: Math.round(remainingUnrealized * 100) / 100,
          remainingUnrealizedPnlPct: Math.round(remainingUnrealizedPnlPct * 100) / 100,
        }
      }))
      res.json(result)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/trades', async (req, res) => {
    try {
      const { status, symbol, limit = '100', offset = '0', orderBy = 'openedAt' } = req.query as Record<string, string>
      const where: any = {}
      if (status) where.status = { in: status.split(',') }
      if (symbol) where.symbol = symbol
      const order: any = orderBy === 'closedAt'
        ? [{ closedAt: 'desc' }, { openedAt: 'desc' }]
        : { openedAt: 'desc' }
      const [data, total] = await Promise.all([
        tm.findMany({
          where, orderBy: order,
          skip: parseInt(offset, 10) || 0,
          take: Math.min(parseInt(limit, 10) || 100, 500),
        }),
        tm.count({ where }),
      ])
      res.json({ data, total })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/stats', async (_req, res) => {
    try {
      const cfg = await cm.upsert({
        where: { id: 1 }, update: {}, create: { id: 1 },
      })
      const closed = await tm.findMany({
        where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        select: { netPnlUsd: true, openedAt: true, closedAt: true, symbol: true },
      })
      const winRate = closed.length > 0 ? closed.filter((t: any) => t.netPnlUsd > 0).length / closed.length : 0

      const allWithCloses = await tm.findMany({
        where: { NOT: { closes: { equals: [] } } },
        select: {
          symbol: true, closes: true, positionUnits: true,
          feesRoundTripPct: true, openedAt: true,
        },
      })

      const byDay: Record<string, number> = {}
      const bySymbolPnl: Record<string, number> = {}
      for (const t of allWithCloses) {
        const closesArr = ((t.closes as any[]) ?? []) as Array<{ price: number; percent: number; pnlUsd: number; closedAt: string }>
        const feeRatePct = t.feesRoundTripPct ?? cfg.feesRoundTripPct ?? 0
        for (const c of closesArr) {
          const notional = t.positionUnits * c.price * (c.percent / 100)
          const fee = notional * (feeRatePct / 100)
          const net = (c.pnlUsd ?? 0) - fee
          const day = (c.closedAt ? new Date(c.closedAt) : t.openedAt).toISOString().slice(0, 10)
          byDay[day] = (byDay[day] ?? 0) + net
          bySymbolPnl[t.symbol] = (bySymbolPnl[t.symbol] ?? 0) + net
        }
      }

      const equityCurve: Array<{ date: string; pnl: number; equity: number }> = []
      let running = cfg.startingDepositUsd
      for (const date of Object.keys(byDay).sort()) {
        running += byDay[date]
        equityCurve.push({ date, pnl: byDay[date], equity: running })
      }

      const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {}
      for (const t of closed) {
        bySymbol[t.symbol] = bySymbol[t.symbol] ?? { trades: 0, wins: 0, pnl: 0 }
        bySymbol[t.symbol].trades++
        if (t.netPnlUsd > 0) bySymbol[t.symbol].wins++
      }
      for (const sym of Object.keys(bySymbolPnl)) {
        bySymbol[sym] = bySymbol[sym] ?? { trades: 0, wins: 0, pnl: 0 }
        bySymbol[sym].pnl = bySymbolPnl[sym]
      }
      res.json({
        config: cfg, winRate,
        returnPct: cfg.startingDepositUsd > 0 ? ((cfg.currentDepositUsd - cfg.startingDepositUsd) / cfg.startingDepositUsd) * 100 : 0,
        bySymbol, equityCurve,
      })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/trades/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      res.json(trade)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.put('/trades/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })

      const {
        entryPrice, stopLoss, currentStop, initialStop, tpLadder,
        feesRoundTripPct, autoTrailingSL,
        status, closes, positionUnits, positionSizeUsd, riskUsd,
      } = req.body
      const data: any = {}
      const fills = (trade.closes as any[]) ?? []
      const noFillsYet = fills.length === 0

      if (typeof entryPrice === 'number' && entryPrice > 0) data.entryPrice = entryPrice
      if (typeof stopLoss === 'number' && stopLoss > 0) {
        data.stopLoss = stopLoss
        if (noFillsYet) data.initialStop = stopLoss
        data.currentStop = stopLoss
      }
      if (typeof initialStop === 'number' && initialStop > 0) data.initialStop = initialStop
      if (typeof currentStop === 'number' && currentStop > 0) data.currentStop = currentStop
      if (Array.isArray(tpLadder) && tpLadder.every(p => typeof p === 'number' && p > 0)) {
        data.tpLadder = tpLadder
      }
      if (feesRoundTripPct === null) data.feesRoundTripPct = null
      else if (typeof feesRoundTripPct === 'number' && feesRoundTripPct >= 0) data.feesRoundTripPct = feesRoundTripPct
      if (autoTrailingSL === null) data.autoTrailingSL = null
      else if (typeof autoTrailingSL === 'boolean') data.autoTrailingSL = autoTrailingSL
      if (typeof status === 'string') data.status = status
      if (Array.isArray(closes)) data.closes = closes
      if (typeof positionUnits === 'number' && positionUnits > 0) data.positionUnits = positionUnits
      if (typeof positionSizeUsd === 'number' && positionSizeUsd > 0) data.positionSizeUsd = positionSizeUsd
      if (typeof riskUsd === 'number' && riskUsd > 0) data.riskUsd = riskUsd

      if (noFillsYet && (data.entryPrice || data.stopLoss) && data.positionUnits === undefined) {
        const newEntry = data.entryPrice ?? trade.entryPrice
        const newSL = data.initialStop ?? trade.initialStop
        const slDist = Math.abs(newEntry - newSL)
        if (slDist > 0) {
          const positionUnits = trade.riskUsd / slDist
          data.positionUnits = positionUnits
          data.positionSizeUsd = newEntry * positionUnits
        }
      }
      if (data.closes) {
        const newCloses = data.closes as Array<any>
        const initialRisk = Math.abs((data.entryPrice ?? trade.entryPrice) - (data.initialStop ?? trade.initialStop))
        let realizedR = 0, realizedPnlUsd = 0
        for (const c of newCloses) {
          if (typeof c.pnlR === 'number') realizedR += c.pnlR
          else if (initialRisk > 0 && typeof c.price === 'number' && typeof c.percent === 'number') {
            const isLong = trade.side === 'BUY'
            const entry = data.entryPrice ?? trade.entryPrice
            realizedR += ((isLong ? c.price - entry : entry - c.price) / initialRisk) * (c.percent / 100)
          }
          if (typeof c.pnlUsd === 'number') realizedPnlUsd += c.pnlUsd
        }
        data.realizedR = realizedR
        data.realizedPnlUsd = realizedPnlUsd
      }
      const feesAffected = data.feesRoundTripPct !== undefined || data.closes !== undefined ||
                           data.positionUnits !== undefined || data.realizedPnlUsd !== undefined
      if (feesAffected) {
        const merged = { ...trade, ...data }
        const feeRate: number | null = merged.feesRoundTripPct ?? null
        let rate: number = feeRate ?? 0
        if (feeRate === null) {
          const cfg = await cm.findUnique({ where: { id: 1 } })
          rate = cfg ? cfg.feesRoundTripPct : 0
        }
        const { feesPaidUsd, netPnlUsd } = recalcFees(merged, rate)
        data.feesPaidUsd = feesPaidUsd
        data.netPnlUsd = netPnlUsd
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No valid fields' })
      }
      const updated = await tm.update({ where: { id }, data })
      if (['CLOSED', 'SL_HIT', 'EXPIRED'].includes(updated.status)) {
        await recomputeDepositAndStats()
      }
      res.json(updated)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.delete('/trades/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      // Variant A also deletes the originating signal so the cron doesn't re-open
      // the same trade. Variant B never touches shared signals — A still uses them.
      if (variant === 'A' && trade.signalId) {
        await prisma.breakoutSignal.deleteMany({ where: { id: trade.signalId } })
      }
      await tm.delete({ where: { id } })
      await recomputeDepositAndStats()
      res.json({ ok: true })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/trades/:id/close-market', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (['CLOSED', 'SL_HIT', 'EXPIRED'].includes(trade.status)) {
        return res.status(400).json({ error: `Already ${trade.status}` })
      }
      const price = await getCurrentPrice(trade.symbol)
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
        closedAt: new Date().toISOString(), reason: 'MANUAL',
      })
      const cfg = await cm.findUnique({ where: { id: 1 } })
      const feePct = trade.feesRoundTripPct ?? (cfg ? cfg.feesRoundTripPct : 0)
      const feeRate = feePct / 100
      const notional = trade.positionUnits * price * remainingFrac
      const newFeeUsd = notional * feeRate
      const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
      const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
      const netPnlUsd = realizedPnlUsd - totalFeesUsd
      const realizedR = trade.realizedR + pnlR

      await tm.update({
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
      // Variant A mirrors closure back to shared signal; B does not.
      if (variant === 'A' && trade.signalId) {
        await syncSignalStatus(trade.signalId, 'CLOSED', realizedR, price, new Date(), fills)
      }
      await recomputeDepositAndStats()
      const fresh = await tm.findUnique({ where: { id } })
      res.json(fresh)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/trades/:id/close-manual', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
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
        closedAt: new Date().toISOString(), reason: 'MANUAL',
      })
      const cfg = await cm.findUnique({ where: { id: 1 } })
      const feePct = trade.feesRoundTripPct ?? (cfg ? cfg.feesRoundTripPct : 0)
      const feeRate = feePct / 100
      const notional = trade.positionUnits * price * fillFrac
      const newFeeUsd = notional * feeRate
      const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
      const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
      const netPnlUsd = realizedPnlUsd - totalFeesUsd
      const realizedR = trade.realizedR + pnlR
      const newRemaining = remainingFrac - fillFrac
      const status = newRemaining < 1e-6 ? 'CLOSED' : trade.status

      await tm.update({
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
      if (variant === 'A' && trade.signalId) {
        const isTerminal = status === 'CLOSED'
        await syncSignalStatus(
          trade.signalId,
          status as any,
          realizedR,
          price,
          isTerminal ? new Date() : null,
          fills,
        )
      }
      await recomputeDepositAndStats()
      const fresh = await tm.findUnique({ where: { id } })
      res.json(fresh)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // === Signals view: same shared BreakoutSignal stream, but joined with this
  // variant's PaperTrade table so paperStatus / paperReason reflect the variant's
  // outcome (not just A's). The shared signal's own status/closes still come from
  // BreakoutSignal (only A mirrors them; for B these reflect "what would A's view be").
  router.get('/signals', async (req, res) => {
    try {
      const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
      const where: any = {}
      if (status) where.status = { in: status.split(',') }
      if (symbol) where.symbol = symbol
      const [signals, total] = await Promise.all([
        prisma.breakoutSignal.findMany({
          where, orderBy: { createdAt: 'desc' },
          skip: parseInt(offset, 10) || 0,
          take: Math.min(parseInt(limit, 10) || 100, 500),
        }),
        prisma.breakoutSignal.count({ where }),
      ])
      // Lookup variant's paper trades for these signals.
      const trades = await tm.findMany({
        where: { signalId: { in: signals.map(s => s.id) } },
        select: {
          id: true, signalId: true, status: true, leverage: true, marginUsd: true,
          realizedR: true, realizedPnlUsd: true, feesPaidUsd: true, netPnlUsd: true,
          closes: true, openedAt: true, closedAt: true, lastPriceCheck: true,
        },
      })
      const tradeBySigId = new Map<number, any>()
      for (const t of trades) tradeBySigId.set(t.signalId, t)

      // Overlay variant's view onto each signal: paperStatus from B's trade if
      // present (OPENED), or null if no B trade exists for that signal.
      const data = signals.map(s => {
        const t = tradeBySigId.get(s.id)
        if (variant === 'A') {
          // A: signal's own paperStatus is canonical (already mirrored).
          return s
        }
        // B: synthesize paperStatus / paperReason from B's trade row.
        if (t) {
          const lev = t.leverage ?? 0
          const mar = t.marginUsd ?? 0
          return {
            ...s,
            paperStatus: 'OPENED',
            paperReason: `lev ${lev.toFixed(1)}x · margin $${mar.toFixed(2)}`,
            paperUpdatedAt: t.openedAt,
            // expose the variant's trade-level status (OPEN/TP1_HIT/.../CLOSED)
            // so UI can show running outcome
            _tradeStatus: t.status,
            _tradeRealizedR: t.realizedR,
            _tradeNetPnlUsd: t.netPnlUsd,
          }
        }
        return { ...s, paperStatus: null, paperReason: null, paperUpdatedAt: null }
      })
      res.json({ data, total })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/signals/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const sig = await prisma.breakoutSignal.findUnique({ where: { id } })
      if (!sig) return res.status(404).json({ error: 'Not found' })
      const t = await tm.findFirst({ where: { signalId: id } })
      if (variant === 'A' || !t) {
        return res.json(sig)
      }
      const lev = t.leverage ?? 0
      const mar = t.marginUsd ?? 0
      res.json({
        ...sig,
        paperStatus: 'OPENED',
        paperReason: `lev ${lev.toFixed(1)}x · margin $${mar.toFixed(2)}`,
        paperUpdatedAt: t.openedAt,
        _tradeStatus: t.status,
        _tradeRealizedR: t.realizedR,
        _tradeNetPnlUsd: t.netPnlUsd,
      })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Force-open a SKIPPED signal in this variant. Bypasses guards (concurrent/margin/etc).
  router.post('/signals/:id/force-open', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const result = await forceOpenSignal(id, variant)
      if (!result.ok) return res.status(400).json(result)
      res.json(result)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
