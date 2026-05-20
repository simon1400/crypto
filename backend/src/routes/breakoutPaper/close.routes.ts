import { Router } from 'express'
import {
  getRealisticRates, takerFillPrice, isMakerFill,
} from '../../services/dailyBreakoutPaper'
import { fetchPricesBatch } from '../../services/market'
import { BreakoutVariant } from '../../services/breakoutVariant'
import {
  CLOSED_STATUSES, ACTIVE_STATUSES,
  getCurrentPrice, buildTakerClose, mirrorToSignal, recomputeDepositAndStats,
} from './helpers'

const SPLITS = [0.5, 0.3, 0.2]

export function registerCloseRoutes(router: Router, variant: BreakoutVariant, cm: any, tm: any): void {
  // Bulk close — market-close every active trade (OPEN/TP1_HIT/TP2_HIT) of
  // this variant. Reuses the same accounting as single /trades/:id/close-market:
  // taker slip + taker fee on the remaining fraction, MANUAL fill record,
  // status=CLOSED, then full deposit/stats recompute at the end.
  router.post('/trades/close-all-market', async (_req, res) => {
    try {
      const active = await tm.findMany({
        where: { status: { in: [...ACTIVE_STATUSES] } },
      })
      if (active.length === 0) return res.json({ closed: 0, failed: 0, trades: [] })

      const symbols = Array.from(new Set(active.map((t: any) => t.symbol as string))) as string[]
      const prices = await fetchPricesBatch(symbols)
      const cfg = await cm.findUnique({ where: { id: 1 } })

      let closed = 0
      let failed = 0
      const closedIds: number[] = []

      for (const trade of active) {
        const refPrice = prices[trade.symbol]
        if (!refPrice || refPrice <= 0) { failed++; continue }
        const result = buildTakerClose({ trade, cfg, refPrice, applySlip: true })
        if (!result) { failed++; continue }

        await tm.update({
          where: { id: trade.id },
          data: {
            status: 'CLOSED',
            closes: result.fills as any,
            realizedR: result.realizedR,
            realizedPnlUsd: result.realizedPnlUsd,
            feesPaidUsd: result.feesPaidUsd,
            slipPaidUsd: result.slipPaidUsd,
            netPnlUsd: result.netPnlUsd,
            closedAt: new Date(),
            lastPriceCheck: result.fillPrice,
            lastPriceCheckAt: new Date(),
          },
        })
        await mirrorToSignal(variant, trade, 'CLOSED', result.realizedR, result.fillPrice, result.fills)
        closed++
        closedIds.push(trade.id)
      }

      await recomputeDepositAndStats(cm, tm)
      res.json({ closed, failed, ids: closedIds })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/trades/:id/close-market', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (CLOSED_STATUSES.has(trade.status)) {
        return res.status(400).json({ error: `Already ${trade.status}` })
      }
      const refPrice = await getCurrentPrice(trade.symbol)
      if (refPrice === null) return res.status(503).json({ error: 'Could not fetch price' })

      const cfg = await cm.findUnique({ where: { id: 1 } })
      const result = buildTakerClose({ trade, cfg, refPrice, applySlip: true })
      if (!result) return res.status(400).json({ error: 'Already closed' })

      await tm.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closes: result.fills as any,
          realizedR: result.realizedR,
          realizedPnlUsd: result.realizedPnlUsd,
          feesPaidUsd: result.feesPaidUsd,
          slipPaidUsd: result.slipPaidUsd,
          netPnlUsd: result.netPnlUsd,
          closedAt: new Date(),
          lastPriceCheck: result.fillPrice,
          lastPriceCheckAt: new Date(),
        },
      })
      await mirrorToSignal(variant, trade, 'CLOSED', result.realizedR, result.fillPrice, result.fills)
      await recomputeDepositAndStats(cm, tm)
      const fresh = await tm.findUnique({ where: { id } })
      res.json(fresh)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Manual close at user-supplied price. No slip applied — the user picked the
  // price. Status may stay TP1_HIT/TP2_HIT if partial; flips to CLOSED on full.
  router.post('/trades/:id/close-manual', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (CLOSED_STATUSES.has(trade.status)) {
        return res.status(400).json({ error: `Already ${trade.status}` })
      }
      const { price, percent } = req.body as { price?: number; percent?: number }
      if (typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'price required' })

      const cfg = await cm.findUnique({ where: { id: 1 } })
      const closeFrac = typeof percent === 'number' ? percent / 100 : 1
      const result = buildTakerClose({ trade, cfg, refPrice: price, applySlip: false, closeFrac })
      if (!result) return res.status(400).json({ error: 'Already closed' })

      // Partial close keeps the current TP-hit status; full close → CLOSED.
      const newStatus = result.status === 'CLOSED' ? 'CLOSED' : trade.status

      await tm.update({
        where: { id },
        data: {
          status: newStatus,
          closes: result.fills as any,
          realizedR: result.realizedR,
          realizedPnlUsd: result.realizedPnlUsd,
          feesPaidUsd: result.feesPaidUsd,
          netPnlUsd: result.netPnlUsd,
          ...(newStatus === 'CLOSED' ? { closedAt: new Date() } : {}),
          lastPriceCheck: price,
          lastPriceCheckAt: new Date(),
        },
      })
      await mirrorToSignal(variant, trade, newStatus, result.realizedR, price, result.fills)
      await recomputeDepositAndStats(cm, tm)
      const fresh = await tm.findUnique({ where: { id } })
      res.json(fresh)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Manual cancel of a PENDING_LIMIT row — UI calls this from the Pending tab.
  // Paper limits are virtual (DB-only), so cancelling is a row mutation: mark
  // CANCELLED_MANUAL + status CANCELLED. Also cancels the paired side of the
  // BUY+SELL placement on the same symbol/day so the user doesn't have to do
  // it twice — that's the same idempotent contract the engine uses when one
  // side fills (CANCELLED_OTHER_SIDE).
  router.post('/trades/:id/cancel-pending', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (trade.status !== 'PENDING_LIMIT') {
        return res.status(400).json({ error: `Cannot cancel — status is ${trade.status}` })
      }
      const now = new Date()
      const cancelData = {
        limitOrderState: 'CANCELLED_MANUAL',
        status: 'CANCELLED',
        closedAt: now,
      }
      await tm.update({ where: { id }, data: cancelData })

      // Pair side: same symbol, same placement day, still PENDING_LIMIT, opposite side
      const dayStart = new Date(trade.openedAt)
      dayStart.setUTCHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart)
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
      const paired = await tm.findFirst({
        where: {
          symbol: trade.symbol,
          status: 'PENDING_LIMIT',
          side: trade.side === 'BUY' ? 'SELL' : 'BUY',
          openedAt: { gte: dayStart, lt: dayEnd },
        },
      })
      if (paired) {
        await tm.update({ where: { id: paired.id }, data: cancelData })
      }
      res.json({ ok: true, cancelled: paired ? 2 : 1 })
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
      const id = parseInt(req.params.id, 10)
      const trade = await tm.findUnique({ where: { id } })
      if (!trade) return res.status(404).json({ error: 'Not found' })
      if (CLOSED_STATUSES.has(trade.status)) {
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
      const isTerminal = CLOSED_STATUSES.has(status)

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

      await mirrorToSignal(variant, trade, status, realizedR, newFills[0].price, fills)
      await recomputeDepositAndStats(cm, tm)
      const fresh = await tm.findUnique({ where: { id } })
      res.json(fresh)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })
}
