import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { executeSignalOrder } from '../../trading/tradingService'
import { createBybitClient } from '../../services/bybit'
import { logOrderAction } from '../../trading/orderLogger'
import { getInstrumentInfo } from '../../trading/instrumentCache'
import { createOrderExecutor } from '../../trading/orderExecutor'
import { stopAutoListener } from '../../trading/autoListener'
import { asyncHandler, parseIdParam } from '../_helpers'

const router = Router()

/**
 * POST /api/trading/execute
 * Execute a signal as a real Bybit order.
 */
router.post('/execute', asyncHandler(async (req, res) => {
  const { signalId } = req.body
  if (!signalId || typeof signalId !== 'number') {
    res.status(400).json({ error: 'signalId must be a number' })
    return
  }

  try {
    const position = await executeSignalOrder(signalId)
    res.status(201).json(position)
  } catch (err: any) {
    if (err.message?.includes('already exists')) {
      res.status(409).json({ error: err.message })
      return
    }
    throw err
  }
}, 'Trading'))

/**
 * POST /api/trading/kill-switch
 * Cancel all Bybit orders and set tradingMode to manual.
 */
router.post('/kill-switch', asyncHandler(async (_req, res) => {
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

  await stopAutoListener()

  await logOrderAction('KILL_SWITCH', {
    details: { cancelledOrders: cancelResult.result },
  })

  res.json({ success: true, tradingMode: 'manual' })
}, 'Trading'))

/**
 * POST /api/trading/positions/:id/close
 * Cancel TP orders and submit market close for a position.
 */
router.post('/positions/:id/close', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const position = await prisma.position.findUnique({ where: { id } })
  if (!position) {
    res.status(404).json({ error: 'Position not found' })
    return
  }
  if (!['OPEN', 'PARTIALLY_CLOSED'].includes(position.status)) {
    res.status(400).json({ error: `Cannot close position with status ${position.status}` })
    return
  }

  const client = await createBybitClient()

  // Cancel outstanding TP orders
  const tpOrderIds = (position.tpOrderIds as string[]) || []
  for (const orderId of tpOrderIds) {
    try {
      await client.cancelOrder({ category: 'linear', symbol: position.symbol, orderId })
    } catch {
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
    (Math.floor(remainingQty / qtyStep) * qtyStep).toFixed(stepDecimals),
  )

  if (alignedQty <= 0) {
    res.status(400).json({ error: 'No remaining quantity to close' })
    return
  }

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

  res.json({ success: true })
}, 'Trading'))

/**
 * POST /api/trading/positions/:id/market-entry
 * Cancel existing limit order and enter at market price.
 * Only works for PENDING_ENTRY positions.
 */
router.post('/positions/:id/market-entry', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const position = await prisma.position.findUnique({ where: { id } })
  if (!position) {
    res.status(404).json({ error: 'Position not found' })
    return
  }
  if (position.status !== 'PENDING_ENTRY') {
    res.status(400).json({ error: 'Position must be PENDING_ENTRY' })
    return
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

    await prisma.position.update({
      where: { id },
      data: { status: 'OPEN', filledAt: new Date() },
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

  res.json({ success: true })
}, 'Trading'))

/**
 * POST /api/trading/positions/:id/cancel
 * Cancel the limit order and mark position as CANCELLED.
 * Only works for PENDING_ENTRY positions.
 */
router.post('/positions/:id/cancel', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const position = await prisma.position.findUnique({ where: { id } })
  if (!position) {
    res.status(404).json({ error: 'Position not found' })
    return
  }
  if (position.status !== 'PENDING_ENTRY') {
    res.status(400).json({ error: 'Position must be PENDING_ENTRY' })
    return
  }

  const client = await createBybitClient()

  try {
    await client.cancelOrder({
      category: 'linear',
      symbol: position.symbol,
      orderId: position.entryOrderId!,
    })
  } catch (cancelErr: any) {
    console.warn('[Trading] Cancel order warning:', cancelErr.message)
  }

  await prisma.position.update({
    where: { id },
    data: { status: 'CANCELLED', closedAt: new Date() },
  })

  await logOrderAction('ORDER_CANCELLED', {
    positionId: id,
    signalId: position.signalId || undefined,
    details: { method: 'manual_cancel', symbol: position.symbol },
  })

  res.json({ success: true })
}, 'Trading'))

export default router
