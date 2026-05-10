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
  resetBreakoutPaperAccount, syncSignalStatus, forceOpenSignal,
  getRealisticRates, takerFillPrice, isMakerFill,
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

function recalcFees(trade: any, feeRatePct: number, realRates?: { takerPct: number; makerPct: number } | null): { feesPaidUsd: number; netPnlUsd: number } {
  const closes = ((trade.closes as any[]) ?? []) as Array<{ price: number; percent: number; reason?: string }>
  let feesPaidUsd = 0
  // Entry fee — realistic model only. Charges taker rate on actual entry notional.
  if (realRates) {
    const entryNotional = (trade.positionUnits ?? 0) * (trade.entryPrice ?? 0)
    feesPaidUsd += entryNotional * (realRates.takerPct / 100)
  }
  for (const c of closes) {
    const notional = (trade.positionUnits ?? 0) * c.price * (c.percent / 100)
    if (realRates) {
      const isMaker = c.reason === 'TP1' || c.reason === 'TP2' || c.reason === 'TP3'
      const rate = isMaker ? realRates.makerPct : realRates.takerPct
      feesPaidUsd += notional * (rate / 100)
    } else {
      feesPaidUsd += notional * (feeRatePct / 100)
    }
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
        feeTakerPct, feeMakerPct, slipTakerPct,
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
          ...(feeTakerPct !== undefined ? { feeTakerPct } : {}),
          ...(feeMakerPct !== undefined ? { feeMakerPct } : {}),
          ...(slipTakerPct !== undefined ? { slipTakerPct } : {}),
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
        // Exit fee estimate: under realistic model the remaining position would
        // be closed via market on SL/EXPIRED — taker rate. Use trade override
        // first, then config defaults, then fall back to legacy flat.
        const takerPct = t.feeTakerPct ?? null
        const feeRatePct = takerPct ?? t.feesRoundTripPct ?? 0.08
        const exitFeesIfClosedNow = t.positionUnits * price * remainingFrac * (feeRatePct / 100)
        // unrealizedPnl — только по нереализованному остатку. Реализованная часть
        // (realizedPnlUsd − feesPaidUsd) уже зачислена в currentDepositUsd через
        // applyDepositDelta в момент TP1/TP2 hit, повторно её прибавлять нельзя —
        // иначе equityWithOpen и плашка "+$X unrealized" задваивают TP1 partial closes.
        const remainingUnrealized = unrealizedGross - exitFeesIfClosedNow
        const remainingUnrealizedPnlPct = t.depositAtEntryUsd > 0
          ? (remainingUnrealized / t.depositAtEntryUsd) * 100 : 0
        return {
          id: t.id, status: t.status, currentPrice: price,
          unrealizedPnl: Math.round(remainingUnrealized * 100) / 100,
          unrealizedPnlPct: Math.round(remainingUnrealizedPnlPct * 100) / 100,
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
        // Pull realistic-model rates: per-trade override > config defaults.
        const cfgForRates = await cm.findUnique({ where: { id: 1 } })
        const takerPct = merged.feeTakerPct ?? cfgForRates?.feeTakerPct ?? null
        const makerPct = merged.feeMakerPct ?? cfgForRates?.feeMakerPct ?? null
        const realRates = (takerPct != null && makerPct != null)
          ? { takerPct, makerPct }
          : null
        const { feesPaidUsd, netPnlUsd } = recalcFees(merged, rate, realRates)
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
      const refPrice = await getCurrentPrice(trade.symbol)
      if (refPrice === null) return res.status(503).json({ error: 'Could not fetch price' })

      const fills = ((trade.closes as any[]) ?? []) as any[]
      const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
      const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
      if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Already closed' })

      // Manual market close = taker. Apply slip + taker fee under realistic model.
      const cfg = await cm.findUnique({ where: { id: 1 } })
      const takerPct = trade.feeTakerPct ?? cfg?.feeTakerPct ?? null
      const slipPct = trade.slipTakerPct ?? cfg?.slipTakerPct ?? null
      const isLong = trade.side === 'BUY'
      const slipFrac = (slipPct ?? 0) / 100
      const price = slipFrac > 0
        ? (isLong ? refPrice * (1 - slipFrac) : refPrice * (1 + slipFrac))
        : refPrice

      const initialRisk = Math.abs(trade.entryPrice - trade.initialStop)
      const pnlR = ((isLong ? price - trade.entryPrice : trade.entryPrice - price) / initialRisk) * remainingFrac
      const fillUnits = trade.positionUnits * remainingFrac
      const pnlUsd = (isLong ? price - trade.entryPrice : trade.entryPrice - price) * fillUnits
      const slipUsdNew = fillUnits * Math.abs(price - refPrice)
      fills.push({
        price, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date().toISOString(), reason: 'MANUAL',
      })

      // Fee — taker rate (realistic), or legacy flat fallback.
      const notional = fillUnits * price
      const newFeeUsd = takerPct != null
        ? notional * (takerPct / 100)
        : notional * ((trade.feesRoundTripPct ?? cfg?.feesRoundTripPct ?? 0) / 100)
      const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
      const totalSlipUsd = (trade.slipPaidUsd ?? 0) + slipUsdNew
      const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
      const netPnlUsd = realizedPnlUsd - totalFeesUsd
      const realizedR = trade.realizedR + pnlR

      await tm.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closes: fills as any,
          realizedR, realizedPnlUsd,
          feesPaidUsd: totalFeesUsd, slipPaidUsd: totalSlipUsd, netPnlUsd,
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
      // Manual close at user-supplied price = taker. Use taker rate under realistic
      // model, fall back to legacy flat rate otherwise. No slip applied — the user
      // already chose the price they want.
      const takerPct = trade.feeTakerPct ?? cfg?.feeTakerPct ?? null
      const notional = trade.positionUnits * price * fillFrac
      const newFeeUsd = takerPct != null
        ? notional * (takerPct / 100)
        : notional * ((trade.feesRoundTripPct ?? cfg?.feesRoundTripPct ?? 0) / 100)
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

  // Симуляция fill TP/SL «как будто это сделал движок» — для ручного тестирования
  // из модала. Повторяет логику dailyBreakoutPaperTrader: TP = maker fill (без slip),
  // split 50/30/20, авто-трейлинг SL (TP1→BE, TP2→TP1); SL = taker fill со slip.
  // Терминальные статусы: TP3 → CLOSED, SL после TP → CLOSED, SL без TP → SL_HIT.
  router.post('/trades/:id/simulate-fill', async (req, res) => {
    try {
      const SPLITS = [0.5, 0.3, 0.2]
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (['CLOSED', 'SL_HIT', 'EXPIRED'].includes(trade.status)) {
        return res.status(400).json({ error: `Already ${trade.status}` })
      }
      const { reason } = req.body as { reason?: 'TP1' | 'TP2' | 'TP3' | 'SL' }
      if (!reason || !['TP1', 'TP2', 'TP3', 'SL'].includes(reason)) {
        return res.status(400).json({ error: 'reason must be TP1|TP2|TP3|SL' })
      }

      const fills = ((trade.closes as any[]) ?? []) as any[]
      const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
      const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
      if (remainingFrac < 1e-6) return res.status(400).json({ error: 'Already fully closed' })

      const tpLadder = (trade.tpLadder as number[]).slice(0, 3)
      const isLong = trade.side === 'BUY'
      const entry = trade.entryPrice
      const initialRisk = Math.abs(entry - trade.initialStop)
      const positionUnits = trade.positionUnits
      const cfg = await cm.findUnique({ where: { id: 1 } })
      const realRates = getRealisticRates(trade, cfg as any)
      const slipFracExit = (realRates?.slipPct ?? 0) / 100

      // nextTpIdx = сколько TP уже взято (0/1/2). Определяем по уже сохранённым closes.
      const tpFillsCount = fills.filter(f => f.reason === 'TP1' || f.reason === 'TP2' || f.reason === 'TP3').length
      const nextTpIdx = tpFillsCount as 0 | 1 | 2

      let realizedR = trade.realizedR
      let realizedPnlUsd = trade.realizedPnlUsd
      let totalSlipUsd = trade.slipPaidUsd ?? 0
      let currentStop = trade.currentStop
      let status: string = trade.status
      let newRemainingFrac = remainingFrac

      const newFills: any[] = []

      if (reason === 'SL') {
        const slipFillPrice = takerFillPrice(currentStop, trade.side as any, 'exit', slipFracExit)
        const pnlR = ((isLong ? slipFillPrice - entry : entry - slipFillPrice) / initialRisk) * remainingFrac
        const fillUnits = positionUnits * remainingFrac
        const pnlUsd = (isLong ? slipFillPrice - entry : entry - slipFillPrice) * fillUnits
        realizedR += pnlR
        realizedPnlUsd += pnlUsd
        totalSlipUsd += fillUnits * Math.abs(slipFillPrice - currentStop)
        const fill = {
          price: slipFillPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
          closedAt: new Date().toISOString(), reason: 'SL',
        }
        fills.push(fill); newFills.push(fill)
        newRemainingFrac = 0
        status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      } else {
        // TP — должен идти строго по очереди (TP1 → TP2 → TP3). Иначе ошибка.
        const requestedIdx = reason === 'TP1' ? 0 : reason === 'TP2' ? 1 : 2
        if (requestedIdx !== nextTpIdx) {
          return res.status(400).json({
            error: `Cannot simulate ${reason} — next expected TP is TP${nextTpIdx + 1}`,
          })
        }
        if (requestedIdx >= tpLadder.length) {
          return res.status(400).json({ error: `TP${requestedIdx + 1} not in ladder` })
        }
        const tp = tpLadder[requestedIdx]
        const splitFrac = SPLITS[requestedIdx] ?? newRemainingFrac
        const fillFrac = Math.min(splitFrac, newRemainingFrac)
        const pnlR = ((isLong ? tp - entry : entry - tp) / initialRisk) * fillFrac
        const fillUnits = positionUnits * fillFrac
        const pnlUsd = (isLong ? tp - entry : entry - tp) * fillUnits
        realizedR += pnlR
        realizedPnlUsd += pnlUsd
        const fill = {
          price: tp, percent: fillFrac * 100, pnlR, pnlUsd,
          closedAt: new Date().toISOString(), reason,
        }
        fills.push(fill); newFills.push(fill)
        newRemainingFrac -= fillFrac

        // Auto-trailing SL: TP1→entry (BE), TP2→TP1, TP3→TP2.
        const trailEnabled = trade.autoTrailingSL ?? cfg?.autoTrailingSL ?? true
        if (trailEnabled) {
          if (requestedIdx === 0) currentStop = entry
          else currentStop = tpLadder[requestedIdx - 1]
        }

        status = newRemainingFrac <= 1e-6
          ? (requestedIdx === 2 ? 'TP3_HIT' : 'CLOSED')
          : (requestedIdx === 0 ? 'TP1_HIT' : 'TP2_HIT')
      }

      // Fees: maker для TP, taker для SL. Считаем только по newFills.
      let newFeesUsd = 0
      if (realRates) {
        for (const f of newFills) {
          const notional = positionUnits * f.price * (f.percent / 100)
          const rate = isMakerFill(f.reason) ? realRates.makerPct : realRates.takerPct
          newFeesUsd += notional * (rate / 100)
        }
      } else {
        const feeRatePct = trade.feesRoundTripPct ?? cfg?.feesRoundTripPct ?? 0
        for (const f of newFills) {
          const notional = positionUnits * f.price * (f.percent / 100)
          newFeesUsd += notional * (feeRatePct / 100)
        }
      }
      const totalFeesUsd = (trade.feesPaidUsd ?? 0) + newFeesUsd
      const netPnlUsd = realizedPnlUsd - totalFeesUsd
      const isTerminal = status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED'

      await tm.update({
        where: { id },
        data: {
          status, currentStop, realizedR, realizedPnlUsd,
          feesPaidUsd: totalFeesUsd, slipPaidUsd: totalSlipUsd, netPnlUsd,
          closes: fills as any,
          lastPriceCheck: newFills[0].price,
          lastPriceCheckAt: new Date(),
          ...(isTerminal ? { closedAt: new Date() } : {}),
        },
      })

      if (variant === 'A' && trade.signalId) {
        await syncSignalStatus(
          trade.signalId,
          status as any,
          realizedR,
          newFills[0].price,
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
