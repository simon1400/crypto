import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { assertBudget } from '../../services/budget'
import { adjustVirtualBalance } from '../../services/virtualBalance'
import { OrderType, calcEntryFee } from '../../services/fees'
import { computePortionPnlFromEntry } from '../../services/tradeClose'
import { fetchPricesBatch } from '../../services/market'
import { asyncHandler, handleBudgetError, parseIdParam } from '../_helpers'

const router = Router()

const VALID_SOURCES = ['MANUAL', 'SIGNAL']

// POST /api/trades — создать сделку
router.post('/', asyncHandler(async (req, res) => {
  const { coin, type, leverage, entryPrice, amount, stopLoss, takeProfits, notes, fees, source, orderType } = req.body

  if (!coin || !type || !entryPrice || !amount || !stopLoss || !takeProfits?.length) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const tradeSource = source && VALID_SOURCES.includes(String(source).toUpperCase())
    ? String(source).toUpperCase()
    : 'MANUAL'

  const orderTypeNorm: OrderType = orderType === 'limit' ? 'limit' : 'market'
  const lev = Number(leverage) || 1

  // Бюджетный гард: проверка virtualBalance с учётом entry fee
  let entryFee = 0
  try {
    const result = await assertBudget(Number(amount), lev, orderTypeNorm)
    entryFee = result.entryFee
  } catch (err) {
    if (handleBudgetError(err, res)) return
    throw err
  }

  await adjustVirtualBalance(-entryFee, `entry fee ${coin} ${orderTypeNorm}`)

  const isMarket = orderTypeNorm === 'market'

  const trade = await prisma.trade.create({
    data: {
      coin: coin.toUpperCase().replace('USDT', '') + 'USDT',
      type: type.toUpperCase(),
      leverage: lev,
      entryPrice: Number(entryPrice),
      amount: Number(amount),
      stopLoss: Number(stopLoss),
      takeProfits,
      fees: entryFee + (Number(fees) || 0),
      notes: notes || null,
      source: tradeSource,
      entryOrderType: orderTypeNorm,
      status: isMarket ? 'OPEN' : 'PENDING_ENTRY',
      openedAt: isMarket ? new Date() : undefined,
    },
  })

  res.json(trade)
}, 'Trades'))

// PUT /api/trades/:id — обновить сделку
// Если меняются key params (entry/amount/leverage/type), пересчитывает P&L всех closes.
router.put('/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }

  const { coin, type, leverage, entryPrice, amount, stopLoss, takeProfits, notes, fees } = req.body
  const data: any = {}
  if (coin !== undefined) data.coin = coin.toUpperCase().replace('USDT', '') + 'USDT'
  if (type !== undefined) data.type = type.toUpperCase()
  if (leverage !== undefined) data.leverage = Number(leverage)
  if (entryPrice !== undefined) data.entryPrice = Number(entryPrice)
  if (amount !== undefined) data.amount = Number(amount)
  if (stopLoss !== undefined) data.stopLoss = Number(stopLoss)
  if (takeProfits !== undefined) data.takeProfits = takeProfits
  if (fees !== undefined) data.fees = Number(fees) || 0
  if (notes !== undefined) data.notes = notes || null

  // Пересчитать P&L закрытий если изменились ключевые параметры
  const newType = data.type || trade.type
  const newEntry = data.entryPrice ?? trade.entryPrice
  const newLeverage = data.leverage ?? trade.leverage
  const newAmount = data.amount ?? trade.amount
  const closes = Array.isArray(trade.closes) ? (trade.closes as any[]) : []

  if (closes.length > 0) {
    const pos = { type: newType, entry: newEntry, leverage: newLeverage, amount: newAmount }
    let totalPnl = 0
    data.closes = closes.map((c: any) => {
      const { pnlPercent, pnlUsdt } = computePortionPnlFromEntry(pos, c.price, c.percent)
      const pnl = Math.round(pnlUsdt * 100) / 100
      totalPnl += pnl
      return { ...c, pnl, pnlPercent: Math.round(pnlPercent * 100) / 100 }
    })
    data.realizedPnl = Math.round(totalPnl * 100) / 100
  }

  const updated = await prisma.trade.update({ where: { id }, data })
  res.json(updated)
}, 'Trades'))

// POST /api/trades/:id/fill-market — войти по рыночной цене (PENDING_ENTRY → OPEN)
router.post('/:id/fill-market', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }
  if (trade.status !== 'PENDING_ENTRY') {
    res.status(400).json({ error: 'Only PENDING_ENTRY trades can be filled' })
    return
  }

  const prices = await fetchPricesBatch([trade.coin])
  const price = prices[trade.coin]
  if (!price) {
    res.status(500).json({ error: 'Could not fetch current price' })
    return
  }

  // Пересчитать entry fee: была limit, теперь market
  const oldEntryFee = trade.fees
  const newEntryFee = await calcEntryFee(trade.amount, trade.leverage, 'market')
  const feeDiff = newEntryFee - oldEntryFee
  if (feeDiff > 0) {
    await adjustVirtualBalance(-feeDiff, `fill-market fee diff ${trade.coin} #${trade.id}`)
  }

  const updated = await prisma.trade.update({
    where: { id },
    data: {
      entryPrice: price,
      status: 'OPEN',
      openedAt: new Date(),
      entryOrderType: 'market',
      fees: newEntryFee,
    },
  })

  console.log(`[Trades] #${id} ${trade.coin} filled at market $${price}`)
  res.json(updated)
}, 'Trades'))

// DELETE /api/trades/all — удалить все сделки
router.delete('/all', asyncHandler(async (_req, res) => {
  const { count } = await prisma.trade.deleteMany({})
  res.json({ deleted: count })
}, 'Trades'))

// DELETE /api/trades/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }

  // Refund entry fee for trades that haven't been closed yet
  // (entry fee was deducted on creation but never returned through close P&L)
  if (['OPEN', 'PENDING_ENTRY', 'PARTIALLY_CLOSED'].includes(trade.status)) {
    // Estimate entry fee from stored fees minus exit fees from closes
    const closes = Array.isArray(trade.closes) ? (trade.closes as any[]) : []
    const exitFeesSum = closes.reduce((sum: number, c: any) => sum + (c.fee || 0), 0)
    const entryFee = trade.fees - exitFeesSum
    if (entryFee > 0) {
      await adjustVirtualBalance(entryFee, `refund entry fee on delete #${trade.id} ${trade.coin}`)
    }
  }

  await prisma.trade.delete({ where: { id } })
  res.json({ ok: true })
}, 'Trades'))

export default router
