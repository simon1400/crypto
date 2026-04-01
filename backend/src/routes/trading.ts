import { Router, Request, Response } from 'express'
import { prisma } from '../db/prisma'
import { executeSignalOrder } from '../trading/tradingService'
import { createBybitClient } from '../services/bybit'
import { logOrderAction } from '../trading/orderLogger'
import { getInstrumentInfo } from '../trading/instrumentCache'
import { createOrderExecutor } from '../trading/orderExecutor'
import { stopAutoListener } from '../trading/autoListener'

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

    // Stop auto listener on kill switch
    await stopAutoListener()

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
    // Fetch DB positions with active statuses
    const dbPositions = await prisma.position.findMany({
      where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ENTRY'] } },
      include: { signal: true },
      orderBy: { createdAt: 'desc' },
    })

    // Fetch ALL Bybit positions (source of truth)
    let bybitPositions: any[] = []
    let allOpenOrders: any[] = []
    let bybitClient: any = null
    try {
      bybitClient = await createBybitClient()
      const response = await bybitClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' })
      bybitPositions = response.result?.list || []
    } catch (err: any) {
      console.error('[Trading] Failed to fetch Bybit positions:', err.message)
      // Fallback: return DB-only positions with origin 'Auto'
      const fallback = dbPositions.map((pos) => ({
        ...pos,
        unrealisedPnl: 0,
        markPrice: null,
        origin: 'Auto' as const,
      }))
      return res.json({ data: fallback })
    }

    // Filter to only active positions (size > 0)
    const activeBybitPositions = bybitPositions.filter(
      (bp: any) => parseFloat(bp.size || '0') > 0
    )

    // Fetch all open orders to find TP (reduceOnly limit) orders per symbol
    try {
      const ordersResp = await bybitClient.getActiveOrders({ category: 'linear', settleCoin: 'USDT', limit: 50 })
      allOpenOrders = ordersResp.result?.list || []
      console.log(`[Trading] Open orders fetched: ${allOpenOrders.length}`)
    } catch (err: any) {
      console.error('[Trading] Failed to fetch open orders:', err.message)
    }

    const result: any[] = []
    const matchedDbIds = new Set<number>()

    // Iterate Bybit positions as primary source
    for (const bp of activeBybitPositions) {
      const symbol = bp.symbol as string
      const side = bp.side as string // 'Buy' = LONG, 'Sell' = SHORT
      const type = side === 'Buy' ? 'LONG' : 'SHORT'

      // Find matching DB position by symbol
      const dbPos = dbPositions.find(
        (p) => p.symbol === symbol && !matchedDbIds.has(p.id)
      )
      if (dbPos) matchedDbIds.add(dbPos.id)

      // Origin detection per D-03
      let origin: 'Auto' | 'Bybit' | 'Auto (Modified)' = 'Bybit'
      if (dbPos) {
        origin = 'Auto'
        // Check if modified: margin or leverage differs from DB
        const bybitMargin = parseFloat(bp.positionIM || '0')
        const bybitLeverage = parseInt(bp.leverage || '0')
        if (dbPos.margin !== null && Math.abs(dbPos.margin - bybitMargin) > 0.01) {
          origin = 'Auto (Modified)'
        }
        if (dbPos.leverage !== bybitLeverage) {
          origin = 'Auto (Modified)'
        }
      }

      // Build response object — Bybit data for dynamic fields per D-04
      result.push({
        id: dbPos ? dbPos.id : -(result.length + 1),
        symbol,
        type,
        leverage: parseInt(bp.leverage || '1'),
        entryPrice: parseFloat(bp.avgPrice || bp.entryPrice || '0'),
        qty: parseFloat(bp.size || '0'),
        margin: parseFloat(bp.positionIM || '0'),
        stopLoss: dbPos ? dbPos.stopLoss : parseFloat(bp.stopLoss || '0'),
        takeProfits: dbPos ? dbPos.takeProfits : (() => {
          // For external positions, find reduceOnly limit orders as TP levels
          const tpOrders = allOpenOrders.filter(
            (o: any) => o.symbol === symbol && String(o.reduceOnly) === 'true' && o.orderType === 'Limit'
          )
          if (tpOrders.length > 0) {
            return tpOrders
              .map((o: any) => parseFloat(o.price || '0'))
              .sort((a: number, b: number) => type === 'LONG' ? a - b : b - a)
          }
          // Fallback to single TP from position
          return parseFloat(bp.takeProfit || '0') > 0 ? [parseFloat(bp.takeProfit)] : []
        })(),
        tpOrderIds: dbPos ? dbPos.tpOrderIds : [],
        closedPct: dbPos ? dbPos.closedPct : 0,
        realizedPnl: dbPos ? dbPos.realizedPnl : 0,
        fees: dbPos ? dbPos.fees : 0,
        status: dbPos ? dbPos.status : 'OPEN',
        signalId: dbPos ? dbPos.signalId : null,
        signal: dbPos ? dbPos.signal : null,
        createdAt: dbPos ? dbPos.createdAt : new Date().toISOString(),
        filledAt: dbPos ? dbPos.filledAt : null,
        closedAt: null,
        unrealisedPnl: parseFloat(bp.unrealisedPnl || '0'),
        markPrice: parseFloat(bp.markPrice || '0'),
        origin,
      })
    }

    // Include PENDING_ENTRY positions from DB not yet on Bybit (limit order not filled)
    for (const dbPos of dbPositions) {
      if (!matchedDbIds.has(dbPos.id) && dbPos.status === 'PENDING_ENTRY') {
        result.push({
          ...dbPos,
          unrealisedPnl: 0,
          markPrice: null,
          origin: 'Auto' as const,
        })
      }
    }

    return res.json({ data: result })
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
 * GET /api/trading/stats/coins
 * Per-coin aggregated win rate and P&L statistics.
 */
router.get('/stats/coins', async (req: Request, res: Response) => {
  try {
    // Get all closed positions (win = realizedPnl > 0)
    const positions = await prisma.position.findMany({
      where: {
        status: { in: ['CLOSED', 'SL_HIT', 'CLOSED_EXTERNAL'] },
      },
      select: {
        symbol: true,
        realizedPnl: true,
      },
    })

    // Group by symbol
    const byCoin: Record<string, { trades: number; wins: number; totalPnl: number }> = {}
    for (const pos of positions) {
      const coin = pos.symbol.replace('USDT', '')
      if (!byCoin[coin]) byCoin[coin] = { trades: 0, wins: 0, totalPnl: 0 }
      byCoin[coin].trades++
      if (pos.realizedPnl > 0) byCoin[coin].wins++
      byCoin[coin].totalPnl += pos.realizedPnl
    }

    // Format response
    const data = Object.entries(byCoin)
      .map(([coin, stats]) => ({
        coin,
        trades: stats.trades,
        wins: stats.wins,
        winRate: stats.trades > 0 ? parseFloat(((stats.wins / stats.trades) * 100).toFixed(1)) : 0,
        avgPnl: stats.trades > 0 ? parseFloat((stats.totalPnl / stats.trades).toFixed(2)) : 0,
        totalPnl: parseFloat(stats.totalPnl.toFixed(2)),
      }))
      .sort((a, b) => b.trades - a.trades) // Sort by most traded

    return res.json({ data })
  } catch (err: any) {
    console.error('[Trading] Coin stats error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/trading/positions/:id/market-entry
 * Cancel existing limit order and enter at market price.
 * Only works for PENDING_ENTRY positions.
 */
router.post('/positions/:id/market-entry', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid position ID' })
    }

    const position = await prisma.position.findUnique({ where: { id } })
    if (!position) {
      return res.status(404).json({ error: 'Position not found' })
    }
    if (position.status !== 'PENDING_ENTRY') {
      return res.status(400).json({ error: 'Position must be PENDING_ENTRY' })
    }

    const client = await createBybitClient()
    const executor = createOrderExecutor(client)

    await executor.executeInQueue(async () => {
      // Cancel existing limit order
      try {
        await client.cancelOrder({
          category: 'linear',
          symbol: position.symbol,
          orderId: position.entryOrderId!,
        })
      } catch (cancelErr: any) {
        console.warn('[Trading] Cancel limit order warning:', cancelErr.message)
      }

      // Place market order
      const side = position.type === 'LONG' ? 'Buy' : 'Sell'
      await client.submitOrder({
        category: 'linear',
        symbol: position.symbol,
        side,
        orderType: 'Market',
        qty: String(position.qty),
        positionIdx: 0,
      })

      // Update position in DB
      await prisma.position.update({
        where: { id },
        data: {
          status: 'OPEN',
          filledAt: new Date(),
        },
      })

      // Place TP orders
      const instrument = await getInstrumentInfo(client, position.symbol)
      const takeProfits = (position.takeProfits as number[]) || []
      if (takeProfits.length > 0) {
        const tpSide = position.type === 'LONG' ? 'Sell' : 'Buy'
        const tpOrderIds = await executor.placeTpOrders({
          symbol: position.symbol,
          side: tpSide,
          totalQty: String(position.qty),
          takeProfits,
          signalId: position.signalId || 0,
          qtyStep: instrument.qtyStep,
          tickSize: instrument.tickSize,
        })

        await prisma.position.update({
          where: { id },
          data: { tpOrderIds },
        })
      }

      await logOrderAction('MARKET_ENTRY', {
        positionId: id,
        signalId: position.signalId || undefined,
        details: { method: 'manual_market_entry', symbol: position.symbol },
      })
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('[Trading] Market entry error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/trading/positions/:id/cancel
 * Cancel the limit order and mark position as CANCELLED.
 * Only works for PENDING_ENTRY positions.
 */
router.post('/positions/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid position ID' })
    }

    const position = await prisma.position.findUnique({ where: { id } })
    if (!position) {
      return res.status(404).json({ error: 'Position not found' })
    }
    if (position.status !== 'PENDING_ENTRY') {
      return res.status(400).json({ error: 'Position must be PENDING_ENTRY' })
    }

    const client = await createBybitClient()

    // Cancel limit order on Bybit
    try {
      await client.cancelOrder({
        category: 'linear',
        symbol: position.symbol,
        orderId: position.entryOrderId!,
      })
    } catch (cancelErr: any) {
      console.warn('[Trading] Cancel order warning:', cancelErr.message)
    }

    // Mark position as CANCELLED
    await prisma.position.update({
      where: { id },
      data: { status: 'CANCELLED', closedAt: new Date() },
    })

    await logOrderAction('ORDER_CANCELLED', {
      positionId: id,
      signalId: position.signalId || undefined,
      details: { method: 'manual_cancel', symbol: position.symbol },
    })

    return res.json({ success: true })
  } catch (err: any) {
    console.error('[Trading] Cancel position error:', err.message)
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
