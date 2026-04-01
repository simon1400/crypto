import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'
import { createOrderExecutor } from './orderExecutor'
import { getInstrumentInfo } from './instrumentCache'
import { calculatePositionQty } from './positionSizer'
import { logOrderAction } from './orderLogger'

/**
 * Execute a signal as a real Bybit order.
 *
 * Orchestrates the full signal-to-order flow:
 * 1. Load signal, check idempotency
 * 2. Set leverage, calculate position size
 * 3. Place entry order with SL
 * 4. Create Position record in DB
 * 5. For market orders, place TP orders immediately
 *
 * All Bybit API calls run inside the serial queue to prevent race conditions.
 */
export async function executeSignalOrder(signalId: number) {
  // Load signal
  const signal = await prisma.signal.findUnique({ where: { id: signalId } })
  if (!signal) {
    throw new Error(`Signal ${signalId} not found`)
  }

  // Check idempotency: reject if position already exists for this signal
  const existing = await prisma.position.findFirst({
    where: { signalId, status: { not: 'CANCELLED' } },
  })
  if (existing) {
    throw new Error(`Position already exists for signal ${signalId}`)
  }

  // Load config
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config) {
    throw new Error('BotConfig not found')
  }

  // Create Bybit client and executor
  const client = await createBybitClient()
  const executor = createOrderExecutor(client)

  // Run the order flow inside the serial queue
  return executor.executeInQueue(async () => {
    const symbol = signal.coin + 'USDT'

    // Fetch instrument info
    const instrument = await getInstrumentInfo(client, symbol)

    // Set leverage
    await executor.setLeverage(symbol, signal.leverage)

    // Get USDT balance
    const balanceResp = await client.getWalletBalance({
      accountType: 'UNIFIED',
      coin: 'USDT',
    })
    const balanceUsdt =
      (balanceResp.result as any).list[0]?.coin?.find(
        (c: any) => c.coin === 'USDT'
      )?.walletBalance || '0'

    // Determine entry type (market vs limit)
    const entryResult = await executor.determineEntryType(signal, symbol)

    // Calculate entry price for sizing
    const entryPrice =
      entryResult.orderType === 'Limit' && entryResult.price
        ? parseFloat(entryResult.price)
        : (signal.entryMin + signal.entryMax) / 2

    // Calculate position qty
    const qty = calculatePositionQty(
      balanceUsdt,
      config.positionSizePct,
      entryPrice,
      signal.leverage,
      instrument
    )

    // Determine side
    const side = signal.type === 'LONG' ? 'Buy' : 'Sell'

    // Place entry order with SL
    const orderResult = await executor.placeEntryWithSl({
      symbol,
      side: side as 'Buy' | 'Sell',
      orderType: entryResult.orderType,
      qty,
      price: entryResult.price,
      stopLoss: signal.stopLoss,
      signalId: signal.id,
      tickSize: instrument.tickSize,
    })

    // Calculate margin
    const margin = (parseFloat(qty) * entryPrice) / signal.leverage

    // Create Position in DB (optimistic write)
    const position = await prisma.position.create({
      data: {
        symbol,
        type: signal.type,
        leverage: signal.leverage,
        qty: parseFloat(qty),
        margin,
        entryOrderId: orderResult.orderId,
        entryOrderLinkId: orderResult.orderLinkId,
        stopLoss: signal.stopLoss,
        takeProfits: signal.takeProfits as any,
        status: entryResult.orderType === 'Market' ? 'OPEN' : 'PENDING_ENTRY',
        signalId: signal.id,
        entryPrice: entryResult.orderType === 'Market' ? entryPrice : undefined,
        filledAt: entryResult.orderType === 'Market' ? new Date() : undefined,
      },
    })

    // Log ORDER_PLACED
    await logOrderAction('ORDER_PLACED', {
      positionId: position.id,
      signalId: signal.id,
      details: {
        symbol,
        side,
        orderType: entryResult.orderType,
        qty,
        orderId: orderResult.orderId,
        orderLinkId: orderResult.orderLinkId,
      },
    })

    // If market order, place TP orders immediately
    if (entryResult.orderType === 'Market') {
      const closeSide = signal.type === 'LONG' ? 'Sell' : 'Buy'
      const tpOrderIds = await executor.placeTpOrders({
        symbol,
        side: closeSide as 'Buy' | 'Sell',
        totalQty: qty,
        takeProfits: signal.takeProfits as number[],
        signalId: signal.id,
        qtyStep: instrument.qtyStep,
        tickSize: instrument.tickSize,
      })

      // Save TP order IDs to position
      await prisma.position.update({
        where: { id: position.id },
        data: { tpOrderIds: tpOrderIds },
      })
    }

    return position
  })
}

/**
 * Check for expired pending orders and cancel them on Bybit.
 *
 * Finds all PENDING_ENTRY positions older than the configured TTL
 * and cancels them both on Bybit and in the DB.
 */
export async function checkExpiredOrders(): Promise<void> {
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!config) return

  const ttlMinutes = config.orderTtlMinutes
  const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000)

  // Find pending entries older than TTL
  const expired = await prisma.position.findMany({
    where: {
      status: 'PENDING_ENTRY',
      createdAt: { lt: cutoff },
    },
  })

  if (expired.length === 0) return

  const client = await createBybitClient()

  for (const position of expired) {
    try {
      // Cancel order on Bybit
      await client.cancelOrder({
        category: 'linear',
        symbol: position.symbol,
        orderId: position.entryOrderId!,
      })

      // Update position status
      await prisma.position.update({
        where: { id: position.id },
        data: {
          status: 'EXPIRED',
          closedAt: new Date(),
        },
      })

      // Log cancellation and expiry
      await logOrderAction('ORDER_CANCELLED', {
        positionId: position.id,
        signalId: position.signalId ?? undefined,
        details: { reason: 'TTL expired', orderId: position.entryOrderId },
      })
      await logOrderAction('EXPIRED', {
        positionId: position.id,
        signalId: position.signalId ?? undefined,
        details: { ttlMinutes, symbol: position.symbol },
      })

      console.log(
        `[TradingService] Expired order cancelled: ${position.symbol} pos=${position.id}`
      )
    } catch (err: any) {
      console.error(
        `[TradingService] Failed to cancel expired order ${position.id}: ${err.message}`
      )
      await logOrderAction('ERROR', {
        positionId: position.id,
        details: { error: err.message, action: 'cancel_expired' },
      })
    }
  }
}

/**
 * Start the TTL checker interval (runs every 60 seconds).
 */
export function startTtlChecker(): NodeJS.Timeout {
  return setInterval(() => {
    checkExpiredOrders().catch((err) =>
      console.error('[TradingService] TTL checker error:', err)
    )
  }, 60 * 1000)
}

/**
 * Stop the TTL checker interval.
 */
export function stopTtlChecker(interval: NodeJS.Timeout): void {
  clearInterval(interval)
}
