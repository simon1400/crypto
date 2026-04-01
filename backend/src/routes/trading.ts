import { Router, Request, Response } from 'express'
import { prisma } from '../db/prisma'
import { executeSignalOrder } from '../trading/tradingService'
import { createBybitClient } from '../services/bybit'
import { logOrderAction } from '../trading/orderLogger'
import { getInstrumentInfo } from '../trading/instrumentCache'

const router = Router()

/**
 * POST /api/trading/execute
 * Execute a signal as a real Bybit order.
 *
 * Body: { signalId: number }
 * Returns 201 with position object on success.
 * Returns 409 if position already exists for signal.
 * Returns 400 for invalid input.
 * Returns 500 on other errors.
 */
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { signalId } = req.body

    if (!signalId || typeof signalId !== 'number') {
      return res.status(400).json({ error: 'signalId must be a number' })
    }

    const position = await executeSignalOrder(signalId)
    return res.status(201).json(position)
  } catch (err: any) {
    if (err.message?.includes('already exists')) {
      return res.status(409).json({ error: err.message })
    }
    console.error('[Trading] Execute error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/positions
 * List positions with optional status filter and pagination.
 *
 * Query: status?, page=1, limit=20
 */
router.get('/positions', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20))
    const status = req.query.status as string | undefined

    const where = status ? { status } : {}

    const [data, total] = await Promise.all([
      prisma.position.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { signal: true },
      }),
      prisma.position.count({ where }),
    ])

    return res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    console.error('[Trading] List positions error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/trading/kill-switch
 * Cancel all Bybit orders and set tradingMode to manual.
 */
router.post('/kill-switch', async (req: Request, res: Response) => {
  try {
    const client = await createBybitClient()
    const cancelResult = await client.cancelAllOrders({ category: 'linear', settleCoin: 'USDT' })

    await prisma.botConfig.update({
      where: { id: 1 },
      data: { tradingMode: 'manual' },
    })

    await prisma.position.updateMany({
      where: { status: 'PENDING_ENTRY' },
      data: { status: 'CANCELLED', closedAt: new Date() },
    })

    await logOrderAction('KILL_SWITCH', {
      details: { cancelledOrders: cancelResult.result },
    })

    return res.json({ success: true, tradingMode: 'manual' })
  } catch (err: any) {
    console.error('[Trading] Kill switch error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/positions/live
 * Get open positions enriched with unrealisedPnl from Bybit.
 * IMPORTANT: Must be defined before /positions/:id to avoid Express matching "live" as :id.
 */
router.get('/positions/live', async (req: Request, res: Response) => {
  try {
    const positions = await prisma.position.findMany({
      where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ENTRY'] } },
      include: { signal: true },
      orderBy: { createdAt: 'desc' },
    })

    if (positions.length === 0) {
      return res.json({ data: [] })
    }

    let bybitPositions: any[] = []
    try {
      const client = await createBybitClient()
      const response = await client.getPositionInfo({ category: 'linear', settleCoin: 'USDT' })
      bybitPositions = response.result?.list || []
    } catch (err: any) {
      console.error('[Trading] Failed to fetch Bybit positions:', err.message)
    }

    const enriched = positions.map((pos) => {
      const bybitPos = bybitPositions.find((bp: any) => bp.symbol === pos.symbol)
      return {
        ...pos,
        unrealisedPnl: bybitPos ? parseFloat(bybitPos.unrealisedPnl || '0') : 0,
        markPrice: bybitPos ? parseFloat(bybitPos.markPrice || '0') : null,
      }
    })

    return res.json({ data: enriched })
  } catch (err: any) {
    console.error('[Trading] Live positions error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/trading/positions/:id/close
 * Cancel TP orders and submit market close for a position.
 */
router.post('/positions/:id/close', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid position ID' })
    }

    const position = await prisma.position.findUnique({ where: { id } })
    if (!position) {
      return res.status(404).json({ error: 'Position not found' })
    }
    if (!['OPEN', 'PARTIALLY_CLOSED'].includes(position.status)) {
      return res.status(400).json({ error: `Cannot close position with status ${position.status}` })
    }

    const client = await createBybitClient()

    // Cancel outstanding TP orders
    const tpOrderIds = (position.tpOrderIds as string[]) || []
    for (const orderId of tpOrderIds) {
      try {
        await client.cancelOrder({ category: 'linear', symbol: position.symbol, orderId })
      } catch (_) {
        // Order may already be filled/cancelled — ignore
      }
    }

    // Calculate remaining qty aligned to step
    const remainingQty = position.qty * (1 - position.closedPct / 100)
    const instrumentInfo = await getInstrumentInfo(client, position.symbol)
    const qtyStep = parseFloat(instrumentInfo.qtyStep)
    const stepDecimals = instrumentInfo.qtyStep.includes('.')
      ? instrumentInfo.qtyStep.split('.')[1].length
      : 0
    const alignedQty = parseFloat(
      (Math.floor(remainingQty / qtyStep) * qtyStep).toFixed(stepDecimals)
    )

    if (alignedQty <= 0) {
      return res.status(400).json({ error: 'No remaining quantity to close' })
    }

    // Submit market close
    await client.submitOrder({
      category: 'linear',
      symbol: position.symbol,
      side: position.type === 'LONG' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: String(alignedQty),
      reduceOnly: true,
      positionIdx: 0,
    })

    await logOrderAction('POSITION_CLOSED', {
      positionId: id,
      details: { method: 'manual_market_close' },
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('[Trading] Close position error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/stats
 * P&L stats for day/week/month periods.
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || 'month'
    const now = new Date()
    let since: Date

    switch (period) {
      case 'day':
        since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        break
      case 'week':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'month':
      default:
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        break
    }

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

    const sortedDates = Object.keys(dailyMap).sort()
    let cumulative = 0
    const dailySeries = sortedDates.map((date) => {
      cumulative += dailyMap[date]
      return { date, cumulativePnl: parseFloat(cumulative.toFixed(2)) }
    })

    return res.json({ totalPnl, tradesCount, wins, winRate, byChannel, dailySeries })
  } catch (err: any) {
    console.error('[Trading] Stats error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/positions/:id
 * Get a single position with its order logs.
 */
router.get('/positions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid position ID' })
    }

    const position = await prisma.position.findUnique({
      where: { id },
      include: { orderLogs: { orderBy: { createdAt: 'desc' } }, signal: true },
    })

    if (!position) {
      return res.status(404).json({ error: 'Position not found' })
    }

    return res.json(position)
  } catch (err: any) {
    console.error('[Trading] Get position error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/logs
 * List order logs with optional filters and pagination.
 *
 * Query: signalId?, positionId?, page=1, limit=50
 */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50))
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
      prisma.orderLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.orderLog.count({ where }),
    ])

    return res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    console.error('[Trading] List logs error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

export default router
