import { Router } from 'express'
import { prisma } from '../db/prisma'
import { asyncHandler, parseIdParam, parsePagination } from './_helpers'
import { computeUsdPnl, getInstrument } from '../scannerForex/instruments'

const router = Router()

// GET /api/forex-trades — list with pagination + filters
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req, 20, 100)
    const status = req.query.status as string | undefined
    const instrument = req.query.instrument as string | undefined
    const dateFrom = req.query.dateFrom as string | undefined
    const dateTo = req.query.dateTo as string | undefined

    const where: any = {}
    if (status) {
      if (status.includes(',')) where.status = { in: status.split(',') }
      else where.status = status
    }
    if (instrument) where.instrument = instrument.toUpperCase()
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setDate(end.getDate() + 1)
        where.createdAt.lt = end
      }
    }

    const [data, total] = await Promise.all([
      prisma.forexTrade.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.forexTrade.count({ where }),
    ])

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) })
  }, 'ForexTrades'),
)

// GET /api/forex-trades/stats — aggregate stats
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const dateFrom = req.query.dateFrom as string | undefined
    const dateTo = req.query.dateTo as string | undefined

    const where: any = {}
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setDate(end.getDate() + 1)
        where.createdAt.lt = end
      }
    }

    const trades = await prisma.forexTrade.findMany({
      where: { ...where, status: { in: ['CLOSED', 'SL_HIT', 'PARTIALLY_CLOSED'] } },
    })

    let totalUsdPnl = 0
    let totalPipsPnl = 0
    let wins = 0
    let losses = 0
    const byInstrument: Record<string, { count: number; usdPnl: number; pipsPnl: number }> = {}

    for (const t of trades) {
      totalUsdPnl += t.realizedUsdPnl
      totalPipsPnl += t.realizedPipsPnl
      if (t.realizedUsdPnl > 0) wins++
      else if (t.realizedUsdPnl < 0) losses++

      if (!byInstrument[t.instrument]) {
        byInstrument[t.instrument] = { count: 0, usdPnl: 0, pipsPnl: 0 }
      }
      byInstrument[t.instrument].count++
      byInstrument[t.instrument].usdPnl += t.realizedUsdPnl
      byInstrument[t.instrument].pipsPnl += t.realizedPipsPnl
    }

    const totalTrades = wins + losses
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0

    res.json({
      totalTrades: trades.length,
      wins,
      losses,
      winRate,
      totalUsdPnl: Math.round(totalUsdPnl * 100) / 100,
      totalPipsPnl: Math.round(totalPipsPnl * 10) / 10,
      byInstrument,
    })
  }, 'ForexTrades'),
)

// GET /api/forex-trades/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return
    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }
    res.json(trade)
  }, 'ForexTrades'),
)

// POST /api/forex-trades — create manual trade (not tied to scanner signal)
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      instrument,
      type,
      lots,
      entryPrice,
      stopLoss,
      takeProfits,
      notes,
    } = req.body as {
      instrument: string
      type: 'LONG' | 'SHORT'
      lots: number
      entryPrice: number
      stopLoss: number
      takeProfits?: { price: number; percent: number; rr?: number }[]
      notes?: string
    }

    if (!instrument || !type || !lots || !entryPrice || !stopLoss) {
      res.status(400).json({ error: 'instrument, type, lots, entryPrice, stopLoss are required' })
      return
    }
    if (!['LONG', 'SHORT'].includes(type)) {
      res.status(400).json({ error: 'type must be LONG or SHORT' })
      return
    }
    const instr = getInstrument(instrument.toUpperCase())
    if (!instr) {
      res.status(400).json({ error: `Unknown instrument: ${instrument}` })
      return
    }

    const trade = await prisma.forexTrade.create({
      data: {
        instrument: instrument.toUpperCase(),
        type,
        lots,
        entryPrice,
        stopLoss,
        initialStop: stopLoss,
        currentStop: stopLoss,
        takeProfits: (takeProfits || []) as any,
        status: 'OPEN',
        source: 'MANUAL',
        openedAt: new Date(),
        notes: notes || null,
      },
    })

    res.json(trade)
  }, 'ForexTrades'),
)

// POST /api/forex-trades/:id/close — partial or full close
router.post(
  '/:id/close',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { price, percent } = req.body as { price: number; percent: number }
    if (!price || !percent) {
      res.status(400).json({ error: 'price and percent required' })
      return
    }

    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }
    if (['CLOSED', 'SL_HIT', 'CANCELLED'].includes(trade.status)) {
      res.status(400).json({ error: 'Trade already closed' })
      return
    }

    const instr = getInstrument(trade.instrument)
    if (!instr) {
      res.status(400).json({ error: `Unknown instrument in stored trade: ${trade.instrument}` })
      return
    }

    const closePrice = Number(price)
    const closePct = Math.min(100 - trade.closedPct, Number(percent))
    if (closePct <= 0) {
      res.status(400).json({ error: 'Nothing left to close' })
      return
    }

    const portionLots = (trade.lots * closePct) / 100
    const { pipsPnl, usdPnl } = computeUsdPnl(instr, trade.type as 'LONG' | 'SHORT', trade.entryPrice, closePrice, portionLots)

    const closes = Array.isArray(trade.closes) ? [...(trade.closes as any[])] : []
    closes.push({
      price: closePrice,
      percent: closePct,
      pipsPnl,
      usdPnl,
      closedAt: new Date().toISOString(),
    })

    const newClosedPct = trade.closedPct + closePct
    const isFull = newClosedPct >= 99.99
    const newRealizedPips = Math.round((trade.realizedPipsPnl + pipsPnl) * 10) / 10
    const newRealizedUsd = Math.round((trade.realizedUsdPnl + usdPnl) * 100) / 100

    // Detect TP-hit timestamps (first close crossing each TP price)
    const tps = (trade.takeProfits as any[]) || []
    const updates: any = {}
    let tpReached = 0
    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i]
      if (!tp?.price) continue
      const tpHit = trade.type === 'LONG' ? closePrice >= tp.price : closePrice <= tp.price
      if (tpHit) tpReached = i + 1
    }
    if (tpReached >= 1 && !trade.tp1HitTimestamp) updates.tp1HitTimestamp = new Date()
    if (tpReached >= 2 && !trade.tp2HitTimestamp) updates.tp2HitTimestamp = new Date()
    if (tpReached >= 3 && !trade.tp3HitTimestamp) updates.tp3HitTimestamp = new Date()

    const updated = await prisma.forexTrade.update({
      where: { id },
      data: {
        closes,
        closedPct: Math.min(100, newClosedPct),
        realizedPipsPnl: newRealizedPips,
        realizedUsdPnl: newRealizedUsd,
        status: isFull ? 'CLOSED' : 'PARTIALLY_CLOSED',
        closedAt: isFull ? new Date() : null,
        exitReason: isFull ? 'MANUAL_EXIT' : undefined,
        timeInTradeMin: isFull && trade.openedAt
          ? Math.floor((Date.now() - trade.openedAt.getTime()) / 60000)
          : undefined,
        ...updates,
      },
    })

    // If full close → also update linked GeneratedSignal
    if (isFull && trade.signalId) {
      await prisma.generatedSignal
        .update({
          where: { id: trade.signalId },
          data: { status: 'CLOSED', closedAt: new Date(), closedPct: 100 },
        })
        .catch(() => {})
    }

    res.json(updated)
  }, 'ForexTrades'),
)

// POST /api/forex-trades/:id/sl-hit — stop loss triggered
router.post(
  '/:id/sl-hit',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }
    if (['CLOSED', 'SL_HIT', 'CANCELLED'].includes(trade.status)) {
      res.status(400).json({ error: 'Trade already closed' })
      return
    }

    const instr = getInstrument(trade.instrument)
    if (!instr) {
      res.status(400).json({ error: `Unknown instrument in stored trade: ${trade.instrument}` })
      return
    }

    const remainingPct = 100 - trade.closedPct
    const portionLots = (trade.lots * remainingPct) / 100
    const stopPrice = trade.currentStop ?? trade.stopLoss
    const { pipsPnl, usdPnl } = computeUsdPnl(
      instr,
      trade.type as 'LONG' | 'SHORT',
      trade.entryPrice,
      stopPrice,
      portionLots,
    )

    const closes = Array.isArray(trade.closes) ? [...(trade.closes as any[])] : []
    closes.push({
      price: stopPrice,
      percent: remainingPct,
      pipsPnl,
      usdPnl,
      closedAt: new Date().toISOString(),
      isSL: true,
    })

    const newRealizedPips = Math.round((trade.realizedPipsPnl + pipsPnl) * 10) / 10
    const newRealizedUsd = Math.round((trade.realizedUsdPnl + usdPnl) * 100) / 100

    const updated = await prisma.forexTrade.update({
      where: { id },
      data: {
        closes,
        closedPct: 100,
        realizedPipsPnl: newRealizedPips,
        realizedUsdPnl: newRealizedUsd,
        status: 'SL_HIT',
        closedAt: new Date(),
        exitReason: trade.stopMovedToBe ? 'BE_STOP' : 'INITIAL_STOP',
        timeInTradeMin: trade.openedAt
          ? Math.floor((Date.now() - trade.openedAt.getTime()) / 60000)
          : undefined,
      },
    })

    if (trade.signalId) {
      await prisma.generatedSignal
        .update({
          where: { id: trade.signalId },
          data: { status: 'SL_HIT', closedAt: new Date(), closedPct: 100 },
        })
        .catch(() => {})
    }

    res.json(updated)
  }, 'ForexTrades'),
)

// POST /api/forex-trades/:id/move-stop — move SL (to BE or trailing)
router.post(
  '/:id/move-stop',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { newStop, reason } = req.body as { newStop: number; reason?: string }
    if (!newStop) {
      res.status(400).json({ error: 'newStop required' })
      return
    }

    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }

    const isBe = Math.abs(newStop - trade.entryPrice) < (getInstrument(trade.instrument)?.pipSize ?? 0.0001) * 2

    const updated = await prisma.forexTrade.update({
      where: { id },
      data: {
        stopLoss: newStop,
        currentStop: newStop,
        stopMovedToBe: isBe,
        stopMoveReason: reason || (isBe ? 'TP1 hit → SL to BE' : 'Manual move'),
      },
    })
    res.json(updated)
  }, 'ForexTrades'),
)

// POST /api/forex-trades/:id/cancel — cancel without P&L (e.g. never filled)
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }
    if (['CLOSED', 'SL_HIT', 'CANCELLED'].includes(trade.status)) {
      res.status(400).json({ error: 'Trade already finalized' })
      return
    }

    const updated = await prisma.forexTrade.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        closedAt: new Date(),
        exitReason: 'CANCELLED',
      },
    })
    res.json(updated)
  }, 'ForexTrades'),
)

// PATCH /api/forex-trades/:id — edit notes / TPs
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { notes, takeProfits } = req.body as {
      notes?: string
      takeProfits?: { price: number; percent: number; rr?: number }[]
    }
    const data: any = {}
    if (notes !== undefined) data.notes = notes
    if (takeProfits !== undefined) data.takeProfits = takeProfits as any

    const updated = await prisma.forexTrade.update({ where: { id }, data })
    res.json(updated)
  }, 'ForexTrades'),
)

// DELETE /api/forex-trades/:id
// Удаляет сделку любого статуса. P&L "возвращается" автоматически —
// stats считается из ForexTrade.realizedUsdPnl, удалённой записи в выборке нет.
// Виртуальный баланс не трогаем — форекс-сделки изолированы от него (живут в MT5).
// Если это была последняя сделка привязанная к сигналу — сбрасываем сигнал в NEW.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const trade = await prisma.forexTrade.findUnique({ where: { id } })
    if (!trade) {
      res.status(404).json({ error: 'Forex trade not found' })
      return
    }

    await prisma.forexTrade.delete({ where: { id } })

    let signalReverted = false
    if (trade.signalId) {
      const remaining = await prisma.forexTrade.count({ where: { signalId: trade.signalId } })
      if (remaining === 0) {
        await prisma.generatedSignal
          .update({
            where: { id: trade.signalId },
            data: {
              status: 'NEW',
              takenAt: null,
              closedAt: null,
              closedPct: 0,
              amount: 0,
            },
          })
          .then(() => { signalReverted = true })
          .catch((err) => {
            console.warn(`[ForexTrades] Failed to revert signal #${trade.signalId} to NEW:`, err.message)
          })
      }
    }

    console.log(
      `[ForexTrades] Deleted #${id} (${trade.instrument} ${trade.type} ${trade.lots} lot, status=${trade.status})` +
      (signalReverted ? ` → signal #${trade.signalId} reverted to NEW` : ''),
    )
    res.json({ ok: true, signalReverted })
  }, 'ForexTrades'),
)

export default router
