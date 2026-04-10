import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { fetchPricesBatch } from '../../services/market'
import { getBudgetStatus } from '../../services/budget'
import { computePortionPnl } from '../../services/tradeClose'
import { asyncHandler, parsePagination, parseIdParam } from '../_helpers'

const router = Router()

// === Symbol cache (Bybit USDT perpetuals) ===
let symbolsCache: string[] = []
let symbolsCacheTime = 0
const CACHE_TTL = 60 * 60 * 1000

async function loadSymbols(): Promise<string[]> {
  if (symbolsCache.length && Date.now() - symbolsCacheTime < CACHE_TTL) return symbolsCache
  try {
    const res = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000')
    const data = await res.json() as { result: { list: { symbol: string; status: string; quoteCoin: string }[] } }
    symbolsCache = data.result.list
      .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT')
      .map(s => s.symbol.replace('USDT', ''))
      .sort()
  } catch {
    console.warn('[Symbols] Bybit fetch failed')
  }
  symbolsCacheTime = Date.now()
  return symbolsCache
}

// GET /api/trades/symbols?q=BTC — поиск монет
router.get('/symbols', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').toUpperCase()
  const symbols = await loadSymbols()
  const filtered = q
    ? symbols.filter(s => s.includes(q)).sort((a, b) => {
        const aStarts = a.startsWith(q) ? 0 : 1
        const bStarts = b.startsWith(q) ? 0 : 1
        return aStarts - bStarts || a.localeCompare(b)
      }).slice(0, 30)
    : symbols.slice(0, 50)
  res.json(filtered)
}, 'Trades'))

// GET /api/trades — список сделок с фильтрами
router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req)
  const { status, coin, source } = req.query

  const where: any = {}
  if (status === 'ACTIVE') where.status = { in: ['OPEN', 'PARTIALLY_CLOSED'] }
  else if (status === 'FINISHED') where.status = { in: ['CLOSED', 'SL_HIT'] }
  else if (status && status !== 'ALL') where.status = status
  if (coin) where.coin = { contains: String(coin).toUpperCase() }
  if (source) where.source = String(source)

  const [data, total] = await Promise.all([
    prisma.trade.findMany({ where, orderBy: { openedAt: 'desc' }, skip, take: limit }),
    prisma.trade.count({ where }),
  ])

  res.json({ data, total, page, totalPages: Math.ceil(total / limit) })
}, 'Trades'))

// GET /api/trades/live — live prices & unrealized P&L for open trades
router.get('/live', asyncHandler(async (_req, res) => {
  const trades = await prisma.trade.findMany({
    where: { status: { in: ['PENDING_ENTRY', 'OPEN', 'PARTIALLY_CLOSED'] } },
  })

  const prices = await fetchPricesBatch(trades.map(t => t.coin))

  const result = trades.map(t => {
    const price = prices[t.coin]
    if (!price) return { id: t.id, status: t.status, currentPrice: null, unrealizedPnl: 0, unrealizedPnlPct: 0 }

    // PENDING_ENTRY — show price but no P&L (not yet in position)
    if (t.status === 'PENDING_ENTRY') {
      return { id: t.id, status: t.status, currentPrice: price, unrealizedPnl: 0, unrealizedPnlPct: 0 }
    }

    const remainingPct = 100 - t.closedPct
    const { pnlPercent, pnlUsdt } = computePortionPnl(t, price, remainingPct)

    return {
      id: t.id,
      status: t.status,
      currentPrice: price,
      unrealizedPnl: Math.round(pnlUsdt * 100) / 100,
      unrealizedPnlPct: Math.round(pnlPercent * 100) / 100,
    }
  })

  res.json(result)
}, 'Trades'))

// GET /api/trades/stats — статистика по сделкам
router.get('/stats', asyncHandler(async (_req, res) => {
  const trades = await prisma.trade.findMany({ where: { status: { not: 'CANCELLED' } } })

  const closed = trades.filter(t => ['CLOSED', 'SL_HIT', 'PARTIALLY_CLOSED'].includes(t.status) && t.closedPct > 0)
  const open = trades.filter(t => t.status === 'OPEN' || (t.status === 'PARTIALLY_CLOSED' && t.closedPct < 100))

  const wins = closed.filter(t => t.realizedPnl > 0)
  const losses = closed.filter(t => t.realizedPnl < 0)

  const totalFees = closed.reduce((s, t) => s + t.fees, 0)
  const totalPnl = closed.reduce((s, t) => s + t.realizedPnl, 0) - totalFees
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.realizedPnl, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.realizedPnl, 0) / losses.length : 0
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0

  const byCoin: Record<string, { trades: number; pnl: number; wins: number }> = {}
  for (const t of closed) {
    const c = t.coin.replace('USDT', '')
    if (!byCoin[c]) byCoin[c] = { trades: 0, pnl: 0, wins: 0 }
    byCoin[c].trades++
    byCoin[c].pnl += t.realizedPnl
    if (t.realizedPnl > 0) byCoin[c].wins++
  }

  const longs = closed.filter(t => t.type === 'LONG')
  const shorts = closed.filter(t => t.type === 'SHORT')

  const r2 = (n: number) => Math.round(n * 100) / 100

  res.json({
    total: trades.length,
    open: open.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 10) / 10,
    totalPnl: r2(totalPnl),
    avgWin: r2(avgWin),
    avgLoss: r2(avgLoss),
    longStats: { count: longs.length, pnl: r2(longs.reduce((s, t) => s + t.realizedPnl, 0)) },
    shortStats: { count: shorts.length, pnl: r2(shorts.reduce((s, t) => s + t.realizedPnl, 0)) },
    byCoin,
  })
}, 'Trades'))

// GET /api/trades/budget — текущий бюджет (virtualBalance − занятая маржа)
router.get('/budget', asyncHandler(async (_req, res) => {
  res.json(await getBudgetStatus())
}, 'Trades'))

// GET /api/trades/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const trade = await prisma.trade.findUnique({ where: { id } })
  if (!trade) {
    res.status(404).json({ error: 'Trade not found' })
    return
  }
  res.json(trade)
}, 'Trades'))

export default router
