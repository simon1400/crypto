import { Router, Request, Response } from 'express'
import { prisma } from '../db/prisma'

const router = Router()

// Кэш символов с биржи (обновляется раз в час)
let symbolsCache: string[] = []
let symbolsCacheTime = 0
const CACHE_TTL = 60 * 60 * 1000

async function loadSymbols(): Promise<string[]> {
  if (symbolsCache.length && Date.now() - symbolsCacheTime < CACHE_TTL) return symbolsCache
  try {
    const res = await fetch('https://api.mexc.com/api/v3/exchangeInfo')
    const data = await res.json() as { symbols: { symbol: string; status: string; quoteAsset: string }[] }
    symbolsCache = data.symbols
      .filter(s => s.status === 'ENABLED' && s.quoteAsset === 'USDT')
      .map(s => s.symbol.replace('USDT', ''))
      .sort()
    symbolsCacheTime = Date.now()
  } catch { /* keep old cache */ }
  return symbolsCache
}

// GET /api/trades/symbols?q=BTC — поиск монет
router.get('/symbols', async (req: Request, res: Response) => {
  try {
    const q = (String(req.query.q || '')).toUpperCase()
    const symbols = await loadSymbols()
    const filtered = q
      ? symbols.filter(s => s.startsWith(q)).slice(0, 30)
      : symbols.slice(0, 50)
    res.json(filtered)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/trades — список сделок с фильтрами
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, coin, page = '1', limit = '20' } = req.query
    const p = Math.max(1, Number(page))
    const l = Math.min(100, Math.max(1, Number(limit)))

    const where: any = {}
    if (status && status !== 'ALL') where.status = status
    if (coin) where.coin = { contains: String(coin).toUpperCase() }

    const [data, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: (p - 1) * l,
        take: l,
      }),
      prisma.trade.count({ where }),
    ])

    res.json({ data, total, page: p, totalPages: Math.ceil(total / l) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/trades/stats — статистика по сделкам
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const trades = await prisma.trade.findMany({
      where: { status: { not: 'CANCELLED' } },
    })

    const closed = trades.filter(t => ['CLOSED', 'SL_HIT', 'PARTIALLY_CLOSED'].includes(t.status) && t.closedPct > 0)
    const open = trades.filter(t => t.status === 'OPEN' || (t.status === 'PARTIALLY_CLOSED' && t.closedPct < 100))

    const wins = closed.filter(t => t.realizedPnl > 0)
    const losses = closed.filter(t => t.realizedPnl < 0)

    const totalFees = closed.reduce((sum, t) => sum + t.fees, 0)
    const totalPnl = closed.reduce((sum, t) => sum + t.realizedPnl, 0) - totalFees
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.realizedPnl, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.realizedPnl, 0) / losses.length : 0
    const winRate = closed.length ? (wins.length / closed.length) * 100 : 0

    // По монетам
    const byCoin: Record<string, { trades: number; pnl: number; wins: number }> = {}
    for (const t of closed) {
      const c = t.coin.replace('USDT', '')
      if (!byCoin[c]) byCoin[c] = { trades: 0, pnl: 0, wins: 0 }
      byCoin[c].trades++
      byCoin[c].pnl += t.realizedPnl
      if (t.realizedPnl > 0) byCoin[c].wins++
    }

    // По направлению
    const longs = closed.filter(t => t.type === 'LONG')
    const shorts = closed.filter(t => t.type === 'SHORT')
    const longPnl = longs.reduce((s, t) => s + t.realizedPnl, 0)
    const shortPnl = shorts.reduce((s, t) => s + t.realizedPnl, 0)

    res.json({
      total: trades.length,
      open: open.length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      longStats: { count: longs.length, pnl: Math.round(longPnl * 100) / 100 },
      shortStats: { count: shorts.length, pnl: Math.round(shortPnl * 100) / 100 },
      byCoin,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/trades/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const trade = await prisma.trade.findUnique({ where: { id: Number(req.params.id) } })
    if (!trade) return res.status(404).json({ error: 'Trade not found' })
    res.json(trade)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/trades — создать сделку
router.post('/', async (req: Request, res: Response) => {
  try {
    const { coin, type, leverage, entryPrice, amount, stopLoss, takeProfits, notes, fees } = req.body

    if (!coin || !type || !entryPrice || !amount || !stopLoss || !takeProfits?.length) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const trade = await prisma.trade.create({
      data: {
        coin: coin.toUpperCase().replace('USDT', '') + 'USDT',
        type: type.toUpperCase(),
        leverage: Number(leverage) || 1,
        entryPrice: Number(entryPrice),
        amount: Number(amount),
        stopLoss: Number(stopLoss),
        takeProfits,
        fees: Number(fees) || 0,
        notes: notes || null,
      },
    })

    res.json(trade)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/trades/:id/close — частичное/полное закрытие
router.post('/:id/close', async (req: Request, res: Response) => {
  try {
    const { price, percent } = req.body
    if (!price || !percent) return res.status(400).json({ error: 'price and percent required' })

    const trade = await prisma.trade.findUnique({ where: { id: Number(req.params.id) } })
    if (!trade) return res.status(404).json({ error: 'Trade not found' })
    if (trade.status === 'CLOSED' || trade.status === 'SL_HIT' || trade.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Trade already closed' })
    }

    const closePrice = Number(price)
    const closePct = Number(percent)
    const newClosedPct = Math.min(100, trade.closedPct + closePct)

    // Считаем P&L для этого закрытия
    // amount = margin (what user put in), leverage is applied
    const direction = trade.type === 'LONG' ? 1 : -1
    const priceDiff = (closePrice - trade.entryPrice) * direction
    const pnlPercent = (priceDiff / trade.entryPrice) * 100 * trade.leverage
    const portionAmount = trade.amount * (closePct / 100)
    const pnlUsdt = portionAmount * (pnlPercent / 100)

    const closes = Array.isArray(trade.closes) ? [...(trade.closes as any[])] : []
    closes.push({
      price: closePrice,
      percent: closePct,
      pnl: Math.round(pnlUsdt * 100) / 100,
      pnlPercent: Math.round(pnlPercent * 100) / 100,
      closedAt: new Date().toISOString(),
    })

    const newRealizedPnl = Math.round((trade.realizedPnl + pnlUsdt) * 100) / 100
    const isFull = newClosedPct >= 100
    const newStatus = isFull ? 'CLOSED' : 'PARTIALLY_CLOSED'

    const updated = await prisma.trade.update({
      where: { id: trade.id },
      data: {
        closes,
        closedPct: newClosedPct,
        realizedPnl: newRealizedPnl,
        status: newStatus,
        closedAt: isFull ? new Date() : null,
      },
    })

    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/trades/:id/sl-hit — стоп-лосс сработал
router.post('/:id/sl-hit', async (req: Request, res: Response) => {
  try {
    const trade = await prisma.trade.findUnique({ where: { id: Number(req.params.id) } })
    if (!trade) return res.status(404).json({ error: 'Trade not found' })

    const remainingPct = 100 - trade.closedPct
    const direction = trade.type === 'LONG' ? 1 : -1
    const priceDiff = (trade.stopLoss - trade.entryPrice) * direction
    const pnlPercent = (priceDiff / trade.entryPrice) * 100 * trade.leverage
    const portionAmount = trade.amount * (remainingPct / 100)
    const pnlUsdt = portionAmount * (pnlPercent / 100)

    const closes = Array.isArray(trade.closes) ? [...(trade.closes as any[])] : []
    closes.push({
      price: trade.stopLoss,
      percent: remainingPct,
      pnl: Math.round(pnlUsdt * 100) / 100,
      pnlPercent: Math.round(pnlPercent * 100) / 100,
      closedAt: new Date().toISOString(),
      isSL: true,
    })

    const updated = await prisma.trade.update({
      where: { id: trade.id },
      data: {
        closes,
        closedPct: 100,
        realizedPnl: Math.round((trade.realizedPnl + pnlUsdt) * 100) / 100,
        status: 'SL_HIT',
        closedAt: new Date(),
      },
    })

    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/trades/:id — обновить сделку
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const trade = await prisma.trade.findUnique({ where: { id: Number(req.params.id) } })
    if (!trade) return res.status(404).json({ error: 'Trade not found' })

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
      const direction = newType === 'LONG' ? 1 : -1
      let totalPnl = 0
      const recalculated = closes.map((c: any) => {
        const priceDiff = (c.price - newEntry) * direction
        const pnlPercent = (priceDiff / newEntry) * 100 * newLeverage
        const portionAmount = newAmount * (c.percent / 100)
        const pnl = Math.round(portionAmount * (pnlPercent / 100) * 100) / 100
        totalPnl += pnl
        return { ...c, pnl, pnlPercent: Math.round(pnlPercent * 100) / 100 }
      })
      data.closes = recalculated
      data.realizedPnl = Math.round(totalPnl * 100) / 100
    }

    const updated = await prisma.trade.update({
      where: { id: trade.id },
      data,
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/trades/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.trade.delete({ where: { id: Number(req.params.id) } })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
