import { Router } from 'express'
import { prisma } from '../db/prisma'
import {
  runBreakoutPaperCycle, resetBreakoutPaperAccount, syncSignalStatus,
} from '../services/dailyBreakoutPaperTrader'
import { loadHistorical } from '../scalper/historicalLoader'
import { fetchPricesBatch } from '../services/market'

async function getCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch { return null }
}

async function recomputeDepositAndStats(): Promise<void> {
  const cfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
  if (!cfg) return
  // Берём все сделки с реализованной частью: полностью закрытые + открытые с partial closes (TP1_HIT/TP2_HIT и т.п.)
  const trades = await prisma.breakoutPaperTrade.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
  })
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
  const closedOnly = trades.filter(t => closedStatuses.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter(t => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter(t => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a, t) => {
    const realizedNet = closedStatuses.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
    return a + realizedNet
  }, 0)
  const newDeposit = cfg.startingDepositUsd + totalPnLUsd
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0
  await prisma.breakoutPaperConfig.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
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

const router = Router()

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutPaperConfig.upsert({
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
    const cfg = await prisma.breakoutPaperConfig.update({
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
    const cfg = await resetBreakoutPaperAccount(startingDepositUsd)
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/wipe-all', async (req, res) => {
  try {
    const { startingDepositUsd } = req.body as { startingDepositUsd?: number }
    const tradesDeleted = await prisma.breakoutPaperTrade.deleteMany({})
    const signalsDeleted = await prisma.breakoutSignal.deleteMany({})
    const cfg = await resetBreakoutPaperAccount(startingDepositUsd)
    res.json({
      ok: true,
      deletedTrades: tradesDeleted.count,
      deletedSignals: signalsDeleted.count,
      config: cfg,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/cycle-now', async (_req, res) => {
  try {
    const result = await runBreakoutPaperCycle()
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/trades/live', async (_req, res) => {
  try {
    const trades = await prisma.breakoutPaperTrade.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    if (trades.length === 0) return res.json([])

    const symbols = trades.map(t => t.symbol)
    const prices = await fetchPricesBatch(symbols)

    const result = await Promise.all(trades.map(async t => {
      const price: number | null = prices[t.symbol] ?? null
      if (price == null) {
        return { id: t.id, status: t.status, currentPrice: null, unrealizedPnl: 0, unrealizedPnlPct: 0 }
      }
      const fills = (t.closes as any[]) ?? []
      const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
      const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
      if (remainingFrac < 1e-6) {
        return { id: t.id, status: t.status, currentPrice: price, unrealizedPnl: 0, unrealizedPnlPct: 0 }
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
      return {
        id: t.id, status: t.status, currentPrice: price,
        unrealizedPnl: Math.round(totalUnrealized * 100) / 100,
        unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
      }
    }))
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
      prisma.breakoutPaperTrade.findMany({
        where, orderBy: { openedAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.breakoutPaperTrade.count({ where }),
    ])
    res.json({ data, total })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/stats', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutPaperConfig.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    // Полностью закрытые — для winRate и счётчика сделок по символу
    const closed = await prisma.breakoutPaperTrade.findMany({
      where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
      select: { netPnlUsd: true, openedAt: true, closedAt: true, symbol: true },
    })
    const winRate = closed.length > 0 ? closed.filter(t => t.netPnlUsd > 0).length / closed.length : 0

    // Для P&L (equity curve, bySymbol pnl) — итерируем по partial closes всех сделок,
    // включая ещё открытые с реализованной частью (TP1_HIT/TP2_HIT).
    const allWithCloses = await prisma.breakoutPaperTrade.findMany({
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

    // Кол-во и wins считаем только по полностью закрытым; pnl — net по всем partial closes.
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
    const trade = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    res.json(trade)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/trades/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
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
        const cfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
        rate = cfg ? cfg.feesRoundTripPct : 0
      }
      const { feesPaidUsd, netPnlUsd } = recalcFees(merged, rate)
      data.feesPaidUsd = feesPaidUsd
      data.netPnlUsd = netPnlUsd
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No valid fields' })
    }
    const updated = await prisma.breakoutPaperTrade.update({ where: { id }, data })
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
    const trade = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    // Delete the originating signal too — otherwise the paper cron re-opens this
    // trade on the next cycle (signal stays NEW/ACTIVE through the UTC day).
    await prisma.breakoutSignal.deleteMany({ where: { id: trade.signalId } })
    await prisma.breakoutPaperTrade.delete({ where: { id } })
    await recomputeDepositAndStats()
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/trades/:id/close-market', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
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
    const cfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
    const feePct = trade.feesRoundTripPct ?? (cfg ? cfg.feesRoundTripPct : 0)
    const feeRate = feePct / 100
    const notional = trade.positionUnits * price * remainingFrac
    const newFeeUsd = notional * feeRate
    const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
    const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
    const netPnlUsd = realizedPnlUsd - totalFeesUsd
    const realizedR = trade.realizedR + pnlR

    await prisma.breakoutPaperTrade.update({
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
    if (trade.signalId) {
      await syncSignalStatus(trade.signalId, 'CLOSED', realizedR, price, new Date(), fills)
    }
    await recomputeDepositAndStats()
    const fresh = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
    res.json(fresh)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/trades/:id/close-manual', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
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
    const cfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
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

    await prisma.breakoutPaperTrade.update({
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
    if (trade.signalId) {
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
    const fresh = await prisma.breakoutPaperTrade.findUnique({ where: { id } })
    res.json(fresh)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
