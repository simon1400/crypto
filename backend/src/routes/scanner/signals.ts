import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { assertBudget } from '../../services/budget'
import { adjustVirtualBalance } from '../../services/virtualBalance'
import { OrderType } from '../../services/fees'
import { computePortionPnlFromEntry } from '../../services/tradeClose'
import { fetchCurrentPrice } from '../../services/market'
import { asyncHandler, handleBudgetError, parseIdParam, parsePagination } from '../_helpers'

const router = Router()

// Virtual trade-based status filters for scanner signals
const TRADE_STATUS_FILTERS: Record<string, string[]> = {
  PENDING: ['PENDING_ENTRY'],
  ACTIVE: ['OPEN', 'PARTIALLY_CLOSED'],
  FINISHED: ['CLOSED', 'SL_HIT'],
  CANCELLED: ['CANCELLED'],
}

// GET /api/scanner/signals — get saved signals with pagination
router.get('/signals', asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, 20, 50)
  const status = req.query.status as string | undefined
  const coin = req.query.coin as string | undefined
  const category = req.query.category as string | undefined
  const dateFrom = req.query.dateFrom as string | undefined
  const dateTo = req.query.dateTo as string | undefined

  // Check if this is a trade-based virtual filter
  const tradeFilter = status ? TRADE_STATUS_FILTERS[status] : undefined

  const where: any = {}
  if (status && !tradeFilter) {
    if (status.includes(',')) {
      where.status = { in: status.split(',') }
    } else {
      where.status = status
    }
  }
  // Trade-based filters only apply to TAKEN signals
  if (tradeFilter) {
    where.status = { in: ['TAKEN', 'PARTIALLY_CLOSED', 'CLOSED', 'SL_HIT'] }
  }
  if (coin) where.coin = { contains: coin.toUpperCase() }
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
    prisma.generatedSignal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: tradeFilter ? undefined : skip,
      take: tradeFilter ? undefined : limit,
    }),
    tradeFilter ? Promise.resolve(0) : prisma.generatedSignal.count({ where }),
  ])

  // Enrich TAKEN signals with linked Trade status
  const takenIds = data.filter(s => s.takenAt).map(s => s.id)
  const linkedTradesMap = new Map<number, { id: number; status: string; realizedPnl: number; closedPct: number; fees: number; fundingPaid: number }>()
  if (takenIds.length > 0) {
    const trades = await prisma.trade.findMany({
      where: {
        source: 'SCANNER',
        OR: takenIds.map(id => ({ notes: { startsWith: `Scanner signal #${id} ` } })),
      },
      select: { id: true, status: true, notes: true, realizedPnl: true, closedPct: true, fees: true, fundingPaid: true },
    })
    for (const t of trades) {
      const match = t.notes?.match(/Scanner signal #(\d+)/)
      if (match) linkedTradesMap.set(parseInt(match[1]), t)
    }
  }

  const enriched = data.map(s => ({
    ...s,
    linkedTrade: linkedTradesMap.get(s.id) || null,
  }))

  // Apply trade-based filter post-enrichment
  let filtered = enriched
  if (tradeFilter) {
    filtered = enriched.filter(s => {
      if (!s.linkedTrade) return false
      return tradeFilter.includes(s.linkedTrade.status)
    })
  }

  // Post-filter by category if requested (category стоит внутри marketContext JSON)
  if (category) {
    filtered = filtered.filter((s: any) => (s.marketContext as any)?.category === category)
  }

  const isPostFiltered = !!tradeFilter || !!category
  const paginatedData = isPostFiltered ? filtered.slice(skip, skip + limit) : filtered
  const finalTotal = isPostFiltered ? filtered.length : total

  res.json({
    data: paginatedData,
    total: finalTotal,
    page,
    totalPages: Math.ceil(finalTotal / limit),
  })
}, 'Scanner'))

// POST /api/scanner/signals/:id/take — mark signal as taken without creating a Trade
router.post('/signals/:id/take', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { amount } = req.body as { amount?: number }

  const signal = await prisma.generatedSignal.findUnique({ where: { id } })
  if (!signal) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }
  if (signal.status !== 'NEW') {
    res.status(400).json({ error: 'Signal already taken or closed' })
    return
  }

  const updated = await prisma.generatedSignal.update({
    where: { id },
    data: { status: 'TAKEN', amount: amount || 0, takenAt: new Date() },
  })
  res.json(updated)
}, 'Scanner'))

// POST /api/scanner/signals/:id/take-trade — take signal and create a tracked Trade
router.post('/signals/:id/take-trade', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { amount, modelType, leverage: customLeverage, orderType } = req.body as {
    amount: number
    modelType?: string
    leverage?: number
    orderType?: OrderType
  }

  if (!amount || amount <= 0) {
    res.status(400).json({ error: 'amount required (USDT)' })
    return
  }

  const signal = await prisma.generatedSignal.findUnique({ where: { id } })
  if (!signal) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }
  if (signal.status !== 'NEW') {
    res.status(400).json({ error: 'Signal already taken or closed' })
    return
  }

  const orderTypeNorm: OrderType = orderType === 'limit' ? 'limit' : 'market'

  // Бюджетный гард + расчёт entry fee
  let entryFee = 0
  try {
    const lev = Number(customLeverage) || signal.leverage
    const result = await assertBudget(Number(amount), lev, orderTypeNorm)
    entryFee = result.entryFee
  } catch (err) {
    if (handleBudgetError(err, res)) return
    throw err
  }

  // Pick entry model if specified
  const mc = signal.marketContext as any
  const models = (mc?.entryModels as any[]) || []
  const model = modelType
    ? models.find((m: any) => m.type === modelType && m.viable) || models[0]
    : models[0]

  const entry = model?.entry ?? signal.entry
  const stopLoss = model?.stopLoss ?? signal.stopLoss
  const leverage = customLeverage || model?.leverage || signal.leverage
  const tps = model?.takeProfits ?? signal.takeProfits as any[]

  // Build TP array with percent distribution
  const tpCount = tps.length
  const tpPercents = tpCount <= 1 ? [100]
    : tpCount === 2 ? [50, 50]
    : tpCount === 3 ? [40, 30, 30]
    : [30, 25, 25, 20]
  const takeProfits = tps.map((tp: any, i: number) => ({
    price: tp.price,
    percent: tpPercents[i] || Math.floor(100 / tpCount),
  }))

  await adjustVirtualBalance(-entryFee, `entry fee ${signal.coin} scanner ${orderTypeNorm}`)

  const isMarket = orderTypeNorm === 'market'

  // For market orders, use current price instead of limit entry
  let actualEntry = entry
  if (isMarket) {
    const coinSymbol = signal.coin.toUpperCase().replace('USDT', '') + 'USDT'
    const currentPrice = await fetchCurrentPrice(coinSymbol)
    if (currentPrice) actualEntry = currentPrice
  }

  const trade = await prisma.trade.create({
    data: {
      coin: signal.coin.toUpperCase().replace('USDT', '') + 'USDT',
      type: signal.type,
      leverage,
      entryPrice: actualEntry,
      amount,
      stopLoss,
      initialStop: isMarket ? stopLoss : undefined,
      currentStop: isMarket ? stopLoss : undefined,
      takeProfits,
      status: isMarket ? 'OPEN' : 'PENDING_ENTRY',
      openedAt: isMarket ? new Date() : undefined,
      source: 'SCANNER',
      entryOrderType: orderTypeNorm,
      fees: entryFee,
      notes: `Scanner signal #${signal.id} | ${signal.strategy} | Score: ${signal.score}${model ? ` | Model: ${model.type}` : ''}`,
    },
  })

  await prisma.generatedSignal.update({
    where: { id },
    data: { status: 'TAKEN', amount, takenAt: new Date() },
  })

  console.log(`[Scanner] Signal #${id} taken as Trade #${trade.id} (${trade.coin} ${trade.type} $${actualEntry}${isMarket && actualEntry !== entry ? ` market, limit was $${entry}` : ''}, ${leverage}x, $${amount})`)
  res.json({ trade, signal: { id, status: 'TAKEN' } })
}, 'Scanner'))

// POST /api/scanner/signals/:id/close — partial/full close at price
router.post('/signals/:id/close', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { price, percent } = req.body as { price: number; percent: number }
  if (!price || !percent) {
    res.status(400).json({ error: 'price and percent required' })
    return
  }

  const signal = await prisma.generatedSignal.findUnique({ where: { id } })
  if (!signal) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }
  if (['CLOSED', 'SL_HIT', 'EXPIRED', 'NEW'].includes(signal.status)) {
    res.status(400).json({ error: 'Signal cannot be closed in current status' })
    return
  }

  const closePrice = Number(price)
  const closePct = Number(percent)
  const newClosedPct = Math.min(100, signal.closedPct + closePct)

  const { pnlPercent, pnlUsdt } = computePortionPnlFromEntry(signal, closePrice, closePct)

  const closes = Array.isArray(signal.closes) ? [...(signal.closes as any[])] : []
  closes.push({
    price: closePrice,
    percent: closePct,
    pnl: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    closedAt: new Date().toISOString(),
  })

  const newRealizedPnl = Math.round((signal.realizedPnl + pnlUsdt) * 100) / 100
  const isFull = newClosedPct >= 100

  const updated = await prisma.generatedSignal.update({
    where: { id },
    data: {
      closes,
      closedPct: newClosedPct,
      realizedPnl: newRealizedPnl,
      status: isFull ? 'CLOSED' : 'PARTIALLY_CLOSED',
      closedAt: isFull ? new Date() : null,
    },
  })
  res.json(updated)
}, 'Scanner'))

// POST /api/scanner/signals/:id/sl-hit — stop loss hit
router.post('/signals/:id/sl-hit', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const signal = await prisma.generatedSignal.findUnique({ where: { id } })
  if (!signal) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }

  const remainingPct = 100 - signal.closedPct
  const { pnlPercent, pnlUsdt } = computePortionPnlFromEntry(signal, signal.stopLoss, remainingPct)

  const closes = Array.isArray(signal.closes) ? [...(signal.closes as any[])] : []
  closes.push({
    price: signal.stopLoss,
    percent: remainingPct,
    pnl: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    closedAt: new Date().toISOString(),
    isSL: true,
  })

  const updated = await prisma.generatedSignal.update({
    where: { id },
    data: {
      closes,
      closedPct: 100,
      realizedPnl: Math.round((signal.realizedPnl + pnlUsdt) * 100) / 100,
      status: 'SL_HIT',
      closedAt: new Date(),
    },
  })
  res.json(updated)
}, 'Scanner'))

// PUT /api/scanner/signals/:id/status — update signal status (manual expire)
router.put('/signals/:id/status', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { status } = req.body as { status: string }
  if (!['EXPIRED'].includes(status)) {
    res.status(400).json({ error: 'Use /take, /close, or /sl-hit endpoints instead' })
    return
  }

  const signal = await prisma.generatedSignal.update({ where: { id }, data: { status } })
  res.json(signal)
}, 'Scanner'))

// DELETE /api/scanner/signals/all — delete all signals
router.delete('/signals/all', asyncHandler(async (_req, res) => {
  const { count } = await prisma.generatedSignal.deleteMany({})
  res.json({ deleted: count })
}, 'Scanner'))

// DELETE /api/scanner/signals/unused — delete signals not taken (NEW, EXPIRED)
router.delete('/signals/unused', asyncHandler(async (_req, res) => {
  const { count } = await prisma.generatedSignal.deleteMany({
    where: { status: { in: ['NEW', 'EXPIRED'] } },
  })
  res.json({ deleted: count })
}, 'Scanner'))

// DELETE /api/scanner/signals/:id — delete a signal
router.delete('/signals/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return
  await prisma.generatedSignal.delete({ where: { id } })
  res.json({ ok: true })
}, 'Scanner'))

export default router
