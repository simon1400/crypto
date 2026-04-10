import { prisma } from '../db/prisma'
import { createBybitClient } from './bybit'

/**
 * Получить открытые позиции с биржи Bybit, обогатив их данными из локальной БД.
 *
 * Источник правды — Bybit. DB используется для:
 * - связывания с signalId, category, комментариями
 * - определения origin (Auto / Bybit / Auto Modified)
 * - добавления PENDING_ENTRY позиций, которых ещё нет на бирже
 *
 * Если Bybit недоступен — fallback на DB-only с origin='Auto'.
 */
export async function getLivePositions() {
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
    console.error('[PositionsLive] Failed to fetch Bybit positions:', err.message)
    // Fallback: DB-only
    return dbPositions.map((pos) => ({
      ...pos,
      unrealisedPnl: 0,
      markPrice: null,
      origin: 'Auto' as const,
    }))
  }

  // Filter to only active positions (size > 0)
  const activeBybitPositions = bybitPositions.filter((bp: any) => parseFloat(bp.size || '0') > 0)

  // Fetch all open orders to find TP (reduceOnly limit) orders per symbol
  try {
    const ordersResp = await bybitClient.getActiveOrders({ category: 'linear', settleCoin: 'USDT', limit: 50 })
    allOpenOrders = ordersResp.result?.list || []
    console.log(`[PositionsLive] Open orders fetched: ${allOpenOrders.length}`)
  } catch (err: any) {
    console.error('[PositionsLive] Failed to fetch open orders:', err.message)
  }

  const result: any[] = []
  const matchedDbIds = new Set<number>()

  // Iterate Bybit positions as primary source
  for (const bp of activeBybitPositions) {
    const symbol = bp.symbol as string
    const side = bp.side as string // 'Buy' = LONG, 'Sell' = SHORT
    const type = side === 'Buy' ? 'LONG' : 'SHORT'

    // Find matching DB position by symbol
    const dbPos = dbPositions.find((p) => p.symbol === symbol && !matchedDbIds.has(p.id))
    if (dbPos) matchedDbIds.add(dbPos.id)

    // Origin detection per D-03
    let origin: 'Auto' | 'Bybit' | 'Auto (Modified)' = 'Bybit'
    if (dbPos) {
      origin = 'Auto'
      const bybitMargin = parseFloat(bp.positionIM || '0')
      const bybitLeverage = parseInt(bp.leverage || '0')
      if (dbPos.margin !== null && Math.abs(dbPos.margin - bybitMargin) > 0.01) {
        origin = 'Auto (Modified)'
      }
      if (dbPos.leverage !== bybitLeverage) {
        origin = 'Auto (Modified)'
      }
    }

    // For external positions, find TP/SL from conditional orders
    let resolvedTPs: number[] = []
    let resolvedSL = parseFloat(bp.stopLoss || '0')
    if (!dbPos) {
      const tpOrders = allOpenOrders.filter(
        (o: any) => o.symbol === symbol && (o.stopOrderType === 'TakeProfit' || o.stopOrderType === 'PartialTakeProfit'),
      )
      const slOrder = allOpenOrders.find(
        (o: any) => o.symbol === symbol && o.stopOrderType === 'StopLoss',
      )
      if (slOrder) resolvedSL = parseFloat(slOrder.triggerPrice || '0')
      if (tpOrders.length > 0) {
        resolvedTPs = tpOrders
          .map((o: any) => parseFloat(o.triggerPrice || o.price || '0'))
          .filter((p: number) => p > 0)
          .sort((a: number, b: number) => (type === 'LONG' ? a - b : b - a))
      } else if (parseFloat(bp.takeProfit || '0') > 0) {
        resolvedTPs = [parseFloat(bp.takeProfit)]
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
      stopLoss: dbPos ? dbPos.stopLoss : resolvedSL,
      takeProfits: dbPos ? dbPos.takeProfits : resolvedTPs,
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

  return result
}
