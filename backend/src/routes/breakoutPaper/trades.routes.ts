import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { BreakoutVariant } from '../../services/breakoutVariant'
import {
  ACTIVE_STATUSES, CLOSED_STATUSES,
  computeUnrealizedForTrades, recomputeDepositAndStats, recalcFees,
} from './helpers'

export function registerTradesRoutes(router: Router, variant: BreakoutVariant, cm: any, tm: any): void {
  router.get('/trades/live', async (_req, res) => {
    try {
      const trades = await tm.findMany({
        where: { status: { in: [...ACTIVE_STATUSES] } },
      })
      const result = await computeUnrealizedForTrades(trades, variant)
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
      if (CLOSED_STATUSES.has(updated.status)) {
        await recomputeDepositAndStats(cm, tm)
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
      await recomputeDepositAndStats(cm, tm)
      res.json({ ok: true })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })
}
