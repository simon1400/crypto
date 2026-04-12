import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { fetchPricesBatch } from '../../services/market'
import { closeTradePortion, cancelPendingTrade } from '../../services/tradeClose'
import { asyncHandler, parseIdParam } from '../_helpers'

const router = Router()

// POST /api/trades/:id/close — частичное/полное закрытие по указанной цене
router.post('/:id/close', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { price, percent } = req.body
  if (!price || !percent) {
    res.status(400).json({ error: 'price and percent required' })
    return
  }

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }
  if (['CLOSED', 'SL_HIT', 'CANCELLED'].includes(trade.status)) {
    res.status(400).json({ error: 'Trade already closed' })
    return
  }

  const result = await closeTradePortion(trade, {
    price: Number(price),
    percent: Number(percent),
  })
  res.json(result.updated)
}, 'Trades'))

// POST /api/trades/:id/sl-hit — стоп-лосс сработал (закрываем остаток по SL цене)
router.post('/:id/sl-hit', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }

  const result = await closeTradePortion(trade, {
    price: trade.stopLoss,
    percent: 100 - trade.closedPct,
    isSL: true,
    forceFullClose: true,
  })
  res.json(result.updated)
}, 'Trades'))

// POST /api/trades/:id/cancel — отменить pending сделку с причиной
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }
  if (trade.status !== 'PENDING_ENTRY') {
    res.status(400).json({ error: 'Only PENDING_ENTRY trades can be cancelled' })
    return
  }

  const { reason } = req.body || {}
  const result = await cancelPendingTrade(trade, reason || 'MANUAL_CANCEL')
  res.json(result)
}, 'Trades'))

// POST /api/trades/close-all — закрыть все открытые сделки по рынку
router.post('/close-all', asyncHandler(async (_req, res) => {
  const trades = await prisma.trade.findMany({
    where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ENTRY'] } },
  })

  if (!trades.length) {
    res.json({ closed: 0 })
    return
  }

  // Параллельно фетчим цены только для non-PENDING сделок
  const prices = await fetchPricesBatch(
    trades.filter(t => t.status !== 'PENDING_ENTRY').map(t => t.coin),
  )

  let closed = 0
  for (const trade of trades) {
    // PENDING_ENTRY — просто отменяем, возвращаем entry fee
    if (trade.status === 'PENDING_ENTRY') {
      console.log(`[Trades] close-all: cancelling PENDING trade #${trade.id} ${trade.coin}`)
      await cancelPendingTrade(trade)
      closed++
      continue
    }

    const price = prices[trade.coin]
    if (!price) continue
    if (trade.closedPct >= 100) continue

    await closeTradePortion(trade, {
      price,
      percent: 100 - trade.closedPct,
      forceFullClose: true,
      logContext: `close-all ${trade.coin} #${trade.id}`,
    })
    closed++
  }

  res.json({ closed })
}, 'Trades'))

export default router
