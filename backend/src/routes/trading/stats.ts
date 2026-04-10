import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { asyncHandler, parsePagination } from '../_helpers'

const router = Router()

const PERIOD_MS: Record<string, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
}

/**
 * GET /api/trading/stats
 * P&L stats for day/week/month periods.
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const period = (req.query.period as string) || 'month'
  const since = new Date(Date.now() - (PERIOD_MS[period] ?? PERIOD_MS.month))

  const positions = await prisma.position.findMany({
    where: {
      closedAt: { gte: since },
      status: { in: ['CLOSED', 'SL_HIT', 'CLOSED_EXTERNAL', 'PARTIALLY_CLOSED'] },
    },
    include: { signal: true },
  })

  const totalPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0)
  const tradesCount = positions.length
  const wins = positions.filter((p) => p.realizedPnl > 0).length
  const winRate = tradesCount > 0 ? parseFloat(((wins / tradesCount) * 100).toFixed(1)) : 0

  // Group by channel
  const byChannel: Record<string, { count: number; pnl: number }> = {}
  for (const pos of positions) {
    const channel = pos.signal?.channel || 'unknown'
    if (!byChannel[channel]) byChannel[channel] = { count: 0, pnl: 0 }
    byChannel[channel].count++
    byChannel[channel].pnl += pos.realizedPnl
  }

  // Daily cumulative P&L series
  const dailyMap: Record<string, number> = {}
  for (const pos of positions) {
    if (!pos.closedAt) continue
    const dateKey = pos.closedAt.toISOString().slice(0, 10)
    dailyMap[dateKey] = (dailyMap[dateKey] || 0) + pos.realizedPnl
  }

  let cumulative = 0
  const dailySeries = Object.keys(dailyMap)
    .sort()
    .map((date) => {
      cumulative += dailyMap[date]
      return { date, cumulativePnl: parseFloat(cumulative.toFixed(2)) }
    })

  res.json({ totalPnl, tradesCount, wins, winRate, byChannel, dailySeries })
}, 'Trading'))

/**
 * GET /api/trading/stats/coins
 * Per-coin aggregated win rate and P&L statistics.
 */
router.get('/stats/coins', asyncHandler(async (_req, res) => {
  const positions = await prisma.position.findMany({
    where: { status: { in: ['CLOSED', 'SL_HIT', 'CLOSED_EXTERNAL'] } },
    select: { symbol: true, realizedPnl: true },
  })

  const byCoin: Record<string, { trades: number; wins: number; totalPnl: number }> = {}
  for (const pos of positions) {
    const coin = pos.symbol.replace('USDT', '')
    if (!byCoin[coin]) byCoin[coin] = { trades: 0, wins: 0, totalPnl: 0 }
    byCoin[coin].trades++
    if (pos.realizedPnl > 0) byCoin[coin].wins++
    byCoin[coin].totalPnl += pos.realizedPnl
  }

  const data = Object.entries(byCoin)
    .map(([coin, s]) => ({
      coin,
      trades: s.trades,
      wins: s.wins,
      winRate: s.trades > 0 ? parseFloat(((s.wins / s.trades) * 100).toFixed(1)) : 0,
      avgPnl: s.trades > 0 ? parseFloat((s.totalPnl / s.trades).toFixed(2)) : 0,
      totalPnl: parseFloat(s.totalPnl.toFixed(2)),
    }))
    .sort((a, b) => b.trades - a.trades)

  res.json({ data })
}, 'Trading'))

/**
 * GET /api/trading/logs
 * List order logs with optional filters and pagination.
 */
router.get('/logs', asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, 50, 200)
  const signalId = req.query.signalId ? parseInt(req.query.signalId as string) : undefined
  const positionId = req.query.positionId ? parseInt(req.query.positionId as string) : undefined
  const action = req.query.action as string | undefined
  const dateFrom = req.query.dateFrom as string | undefined
  const dateTo = req.query.dateTo as string | undefined

  const where: Record<string, any> = {}
  if (signalId) where.signalId = signalId
  if (positionId) where.positionId = positionId
  if (action) where.action = action
  if (dateFrom || dateTo) {
    where.createdAt = {}
    if (dateFrom) where.createdAt.gte = new Date(dateFrom)
    if (dateTo) where.createdAt.lte = new Date(dateTo)
  }

  const [data, total] = await Promise.all([
    prisma.orderLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.orderLog.count({ where }),
  ])

  res.json({ data, total, page, totalPages: Math.ceil(total / limit) })
}, 'Trading'))

export default router
