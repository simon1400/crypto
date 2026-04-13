import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'
import { createOrderExecutor } from './orderExecutor'
import { getInstrumentInfo } from './instrumentCache'
import { logOrderAction } from './orderLogger'

/**
 * WebSocket order update shape (from Bybit v5 WS).
 */
interface WsOrderUpdate {
  orderId: string
  orderLinkId: string
  symbol: string
  side: string
  orderType: string
  price: string
  qty: string
  cumExecQty: string
  avgPrice: string
  orderStatus: string // New, PartiallyFilled, Filled, Cancelled, Rejected, Deactivated
  stopOrderType: string // empty string or 'StopLoss' or 'TakeProfit'
  reduceOnly: boolean
}

/**
 * WebSocket position update shape.
 */
interface WsPositionUpdate {
  symbol: string
  side: string // Buy, Sell, None
  size: string
  entryPrice: string
  leverage: string
  unrealisedPnl: string
  cumRealisedPnl: string
  liqPrice: string
}

/**
 * Handle WebSocket order updates.
 * Dispatches to appropriate handler based on order type and status.
 */
export async function handleOrderUpdate(data: WsOrderUpdate[]): Promise<void> {
  for (const order of data) {
    try {
      // Check if this is an entry order fill
      if (order.orderLinkId.match(/^sig-\d+-entry$/)) {
        await handleEntryOrderUpdate(order)
        continue
      }

      // Check if this is a TP order fill
      const tpMatch = order.orderLinkId.match(/^sig-\d+-tp(\d+)$/)
      if (tpMatch) {
        await handleTpOrderUpdate(order, parseInt(tpMatch[1]))
        continue
      }

      // Check if this is a SL trigger (stopOrderType = 'StopLoss')
      if (order.stopOrderType === 'StopLoss' && order.orderStatus === 'Filled') {
        await handleSlTriggered(order)
      }
    } catch (err: any) {
      console.error(`[PositionManager] Error handling order update for ${order.orderId}: ${err.message}`)
    }
  }
}

/**
 * Handle entry order status changes (Filled or Cancelled).
 */
async function handleEntryOrderUpdate(order: WsOrderUpdate): Promise<void> {
  const position = await prisma.position.findFirst({
    where: { entryOrderId: order.orderId },
  })
  if (!position) return

  if (order.orderStatus === 'Filled') {
    // Step 1: Atomically update position status + log order fill
    await prisma.$transaction(async (tx) => {
      await tx.position.update({
        where: { id: position.id },
        data: {
          status: 'OPEN',
          entryPrice: parseFloat(order.avgPrice),
          filledAt: new Date(),
        },
      })

      await tx.orderLog.create({
        data: {
          action: 'ORDER_FILLED',
          positionId: position.id,
          signalId: position.signalId ?? undefined,
          details: {
            orderId: order.orderId,
            avgPrice: order.avgPrice,
            cumExecQty: order.cumExecQty,
          },
        },
      })
    })

    console.log(`[OrderLog] ORDER_FILLED pos=${position.id} sig=${position.signalId ?? '-'}`)

    // Step 2: External API call — place TP orders (outside transaction)
    try {
      const client = await createBybitClient()
      const executor = createOrderExecutor(client)
      const instrument = await getInstrumentInfo(client, position.symbol)

      const closeSide = position.type === 'LONG' ? 'Sell' : 'Buy'
      const tpOrderIds = await executor.placeTpOrders({
        symbol: position.symbol,
        side: closeSide as 'Buy' | 'Sell',
        totalQty: String(position.qty),
        takeProfits: position.takeProfits as number[],
        signalId: position.signalId ?? 0,
        qtyStep: instrument.qtyStep,
        tickSize: instrument.tickSize,
      })

      await prisma.position.update({
        where: { id: position.id },
        data: { tpOrderIds },
      })
    } catch (err: any) {
      console.error(`[PositionManager] Failed to place TP orders for position ${position.id}: ${err.message}`)
      await logOrderAction('ERROR', {
        positionId: position.id,
        details: { error: err.message, action: 'place_tp_after_fill' },
      })
    }
  } else if (order.orderStatus === 'Cancelled') {
    await prisma.position.update({
      where: { id: position.id },
      data: { status: 'CANCELLED', closedAt: new Date() },
    })

    await logOrderAction('ORDER_CANCELLED', {
      positionId: position.id,
      signalId: position.signalId ?? undefined,
      details: { orderId: order.orderId, reason: 'cancelled_by_exchange' },
    })
  }
}

/**
 * Handle TP order fill events.
 */
async function handleTpOrderUpdate(order: WsOrderUpdate, tpLevel: number): Promise<void> {
  if (order.orderStatus !== 'Filled') return

  // Find position that has this TP order ID
  const positions = await prisma.position.findMany({
    where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
  })

  const position = positions.find((p: any) => {
    const tpIds = p.tpOrderIds as string[]
    return tpIds.includes(order.orderId)
  })
  if (!position) return

  const tps = position.takeProfits as number[]
  const tpCount = tps.length
  const pctPerTp = 100 / tpCount
  const newClosedPct = Math.min(position.closedPct + pctPerTp, 100)

  const actionName = `TP${tpLevel}_HIT` as any

  // Calculate P&L for this TP portion
  const tpPrice = parseFloat(order.avgPrice) || tps[tpLevel - 1]
  const tpPnl = calculateRealizedPnl(position, tpPrice, pctPerTp)
  const totalPnl = Math.round((position.realizedPnl + tpPnl) * 100) / 100

  // Determine if all TPs are filled
  const allFilled = newClosedPct >= 100
  const newStatus = allFilled ? 'CLOSED' : 'PARTIALLY_CLOSED'

  await prisma.position.update({
    where: { id: position.id },
    data: {
      closedPct: newClosedPct,
      status: newStatus,
      realizedPnl: totalPnl,
      closedAt: allFilled ? new Date() : undefined,
    },
  })

  await logOrderAction(actionName, {
    positionId: position.id,
    signalId: position.signalId ?? undefined,
    details: {
      tpLevel,
      price: order.avgPrice,
      qty: order.cumExecQty,
      closedPct: newClosedPct,
      tpPnl,
      totalPnl,
    },
  })
}

/**
 * Calculate realized P&L for a position closed at a given price.
 * Takes into account partially closed percentage (TPs already hit).
 */
function calculateRealizedPnl(
  position: { entryPrice: number | null; type: string; leverage: number; margin: number | null; closedPct: number; realizedPnl: number },
  closePrice: number,
  closePct: number // percentage being closed now (e.g. 100 for full SL, or per-TP pct)
): number {
  if (!position.entryPrice || !position.margin) return 0

  const direction = position.type === 'LONG' ? 1 : -1
  const priceDiff = (closePrice - position.entryPrice) * direction
  const pnlPercent = (priceDiff / position.entryPrice) * 100 * position.leverage
  const portionMargin = position.margin * (closePct / 100)
  return Math.round(portionMargin * (pnlPercent / 100) * 100) / 100
}

/**
 * Handle SL triggered events.
 */
async function handleSlTriggered(order: WsOrderUpdate): Promise<void> {
  // Find position by symbol that is OPEN or PARTIALLY_CLOSED
  const position = await prisma.position.findFirst({
    where: {
      symbol: order.symbol,
      status: { in: ['OPEN', 'PARTIALLY_CLOSED'] },
    },
  })
  if (!position) return

  // Calculate P&L for the remaining portion closed by SL
  const remainingPct = 100 - position.closedPct
  const slPrice = parseFloat(order.avgPrice) || position.stopLoss
  const slPnl = calculateRealizedPnl(position, slPrice, remainingPct)
  const totalPnl = Math.round((position.realizedPnl + slPnl) * 100) / 100

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: 'SL_HIT',
      closedAt: new Date(),
      closedPct: 100,
      realizedPnl: totalPnl,
    },
  })

  await logOrderAction('SL_TRIGGERED', {
    positionId: position.id,
    signalId: position.signalId ?? undefined,
    details: {
      orderId: order.orderId,
      price: order.avgPrice,
      symbol: order.symbol,
      slPnl,
      totalPnl,
      remainingPct,
    },
  })
}

/**
 * Handle WebSocket position updates.
 * Detects externally closed positions (size=0 on Bybit but OPEN in DB).
 */
export async function handlePositionUpdate(data: WsPositionUpdate[]): Promise<void> {
  for (const update of data) {
    try {
      if (update.size === '0' || update.side === 'None') {
        // Position closed on exchange -- check if we have it open in DB
        const position = await prisma.position.findFirst({
          where: {
            symbol: update.symbol,
            status: { in: ['OPEN', 'PARTIALLY_CLOSED'] },
          },
        })
        if (!position) {
          // External position closed — create a record for P&L tracking
          const bybitPnl = parseFloat(update.cumRealisedPnl || '0')
          if (bybitPnl !== 0) {
            await prisma.position.create({
              data: {
                symbol: update.symbol,
                type: 'LONG',
                leverage: parseInt(update.leverage || '1'),
                qty: 0,
                stopLoss: 0,
                takeProfits: [],
                status: 'CLOSED_EXTERNAL',
                closedAt: new Date(),
                closedPct: 100,
                realizedPnl: Math.round(bybitPnl * 100) / 100,
              },
            })

            await logOrderAction('CLOSED_EXTERNAL', {
              details: {
                symbol: update.symbol,
                cumRealisedPnl: update.cumRealisedPnl,
                reason: 'external_position_closed_ws',
              },
            })

            console.log(`[PositionManager] External position closed: ${update.symbol} P&L: ${bybitPnl}`)
          }
          continue
        }

        const bybitPnl = parseFloat(update.cumRealisedPnl || '0')
        // Use Bybit's cumRealisedPnl if available, otherwise keep what we have
        const totalPnl = bybitPnl !== 0
          ? Math.round(bybitPnl * 100) / 100
          : position.realizedPnl

        await prisma.position.update({
          where: { id: position.id },
          data: {
            status: 'CLOSED_EXTERNAL',
            closedAt: new Date(),
            closedPct: 100,
            realizedPnl: totalPnl,
          },
        })

        await logOrderAction('CLOSED_EXTERNAL', {
          positionId: position.id,
          signalId: position.signalId ?? undefined,
          details: {
            symbol: update.symbol,
            cumRealisedPnl: update.cumRealisedPnl,
            realizedPnl: totalPnl,
            reason: 'position_size_zero_on_exchange',
          },
        })
      }
    } catch (err: any) {
      console.error(`[PositionManager] Error handling position update for ${update.symbol}: ${err.message}`)
    }
  }
}

/**
 * Reconcile positions with Bybit via REST polling.
 *
 * Detects:
 * - DB positions that no longer exist on Bybit -> mark CLOSED_EXTERNAL
 * - PENDING_ENTRY that is actually open on Bybit -> update to OPEN
 */
export async function reconcilePositions(): Promise<void> {
  try {
    const client = await createBybitClient()

    // Get all open positions from Bybit
    const response = await client.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT',
    })

    if (response.retCode !== 0) {
      console.error(`[PositionManager] Reconcile: failed to fetch positions: ${response.retMsg}`)
      return
    }

    const bybitPositions = (response.result as any).list || []
    const bybitSymbolSet = new Set<string>()

    // Build set of symbols with open positions on Bybit
    for (const bp of bybitPositions) {
      if (parseFloat(bp.size) > 0) {
        bybitSymbolSet.add(bp.symbol)
      }
    }

    // Get all DB positions that should be active
    const dbPositions = await prisma.position.findMany({
      where: {
        status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_ENTRY'] },
      },
    })

    for (const dbPos of dbPositions) {
      const existsOnBybit = bybitSymbolSet.has(dbPos.symbol)

      if (!existsOnBybit && (dbPos.status === 'OPEN' || dbPos.status === 'PARTIALLY_CLOSED')) {
        // Position closed externally — try to get P&L from Bybit closed PnL API
        let closedPnl = dbPos.realizedPnl
        try {
          const pnlResp = await client.getClosedPnL({
            category: 'linear',
            symbol: dbPos.symbol,
            limit: 5,
          })
          const pnlRecords = (pnlResp.result as any)?.list || []
          // Find the most recent record for this symbol
          if (pnlRecords.length > 0) {
            const totalFromBybit = pnlRecords.reduce(
              (sum: number, r: any) => sum + parseFloat(r.closedPnl || '0'), 0
            )
            if (totalFromBybit !== 0) {
              closedPnl = Math.round(totalFromBybit * 100) / 100
            }
          }
        } catch {
          // Fallback: use calculated P&L if Bybit API fails
        }

        await prisma.position.update({
          where: { id: dbPos.id },
          data: { status: 'CLOSED_EXTERNAL', closedAt: new Date(), closedPct: 100, realizedPnl: closedPnl },
        })

        await logOrderAction('CLOSED_EXTERNAL', {
          positionId: dbPos.id,
          signalId: dbPos.signalId ?? undefined,
          details: { reason: 'reconcile_not_on_exchange', symbol: dbPos.symbol, realizedPnl: closedPnl },
        })

        console.log(`[PositionManager] Reconcile: marked ${dbPos.symbol} pos=${dbPos.id} as CLOSED_EXTERNAL (P&L: ${closedPnl})`)
      } else if (existsOnBybit && dbPos.status === 'PENDING_ENTRY') {
        // Entry filled but WS event missed
        const bybitPos = bybitPositions.find(
          (bp: any) => bp.symbol === dbPos.symbol && parseFloat(bp.size) > 0
        )
        if (bybitPos) {
          await prisma.position.update({
            where: { id: dbPos.id },
            data: {
              status: 'OPEN',
              entryPrice: parseFloat(bybitPos.entryPrice),
              filledAt: new Date(),
            },
          })

          await logOrderAction('RECONCILE_MISMATCH', {
            positionId: dbPos.id,
            signalId: dbPos.signalId ?? undefined,
            details: {
              reason: 'pending_but_open_on_exchange',
              symbol: dbPos.symbol,
              entryPrice: bybitPos.entryPrice,
            },
          })

          console.log(`[PositionManager] Reconcile: updated ${dbPos.symbol} pos=${dbPos.id} to OPEN`)
        }
      }
    }
  } catch (err: any) {
    console.error(`[PositionManager] Reconcile error: ${err.message}`)
  }
}
