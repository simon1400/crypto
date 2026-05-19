/**
 * Flatten / cleanup helpers — used by EOD-FLAT, kill-switch, and orphan cleanup.
 */

import { prisma } from '../../db/prisma'
import { LOG, state, ACTIVE_STATUSES } from './state'
import { getFilters } from './filters'
import { cancelSlOnExchange } from './exchangeSl'
import { sendLiveTelegram } from './telegram'

/**
 * Close every BreakoutLiveTradeC row still in an open status: cancel its SL/TP
 * children, send MARKET reduceOnly for the remaining qty, mark CLOSED.
 *
 * Used by EOD-FLAT (23:55 UTC) and by the kill-switch endpoint (manual flush).
 */
export async function flattenAllOpenC(reason: string): Promise<{ closed: number; failed: number }> {
  if (!state.current) return { closed: 0, failed: 0 }

  const openTrades = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
  })
  if (openTrades.length === 0) {
    console.log(`${LOG} flatten — nothing open`)
    return { closed: 0, failed: 0 }
  }

  let closed = 0
  let failed = 0

  for (const t of openTrades) {
    try {
      // Compute remaining qty (units not yet closed by partial TPs). Virtual
      // SL/TP — no child orders on exchange to cancel; trackLiveTrade owns
      // exits entirely via MARKET reduceOnly, and once status moves to
      // CLOSED the aggTrade tracker will skip this row.
      const closesArr = ((t.closes as any[]) ?? [])
      const closedFrac = closesArr.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
      const remainingFrac = Math.max(0, 1 - closedFrac)
      const remainingQty = t.positionUnits * remainingFrac
      if (remainingQty <= 0) {
        // Nothing left to close on exchange (already fully filled via TPs/SL).
        // Just finalize the DB row.
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        closed++
        continue
      }

      const filters = await getFilters(state.current.client)
      const f = filters.get(t.symbol)
      if (!f) {
        console.warn(`${LOG} flatten #${t.id} — no filter for ${t.symbol}`)
        failed++
        continue
      }

      const step = f.stepSize
      let qty = Math.floor(remainingQty / step) * step
      qty = Number(qty.toFixed(f.quantityPrecision))
      if (qty < f.minQty) {
        // Below min qty — already dust. Just finalize.
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        closed++
        continue
      }

      const closeSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'

      // Cancel the safety-net SL on the exchange before sending our MARKET —
      // otherwise both could race and one gets -2022 ReduceOnly rejected.
      await cancelSlOnExchange(t).catch(() => { /* best-effort */ })

      // MARKET reduceOnly to close.
      try {
        await state.current.client.placeOrder({
          symbol: t.symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: qty,
          reduceOnly: true,
        })
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closes: [
              ...closesArr,
              {
                price: 0,  // exact price comes via WS event; recorded as 0 if missed
                percent: Math.round(remainingFrac * 100),
                pnlUsd: 0,
                closedAt: new Date().toISOString(),
                reason,
              },
            ] as any,
            binanceSlOrderId: null,
          },
        })
        closed++
        console.log(`${LOG} flattened #${t.id} ${t.symbol} ${t.side} qty ${qty} via MARKET (${reason})`)
      } catch (e: any) {
        console.warn(`${LOG} flatten #${t.id} MARKET failed: ${e.message}`)
        failed++
      }
    } catch (e: any) {
      console.warn(`${LOG} flatten #${t.id} threw: ${e.message}`)
      failed++
    }
  }

  console.log(`${LOG} flatten complete (${reason}): ${closed} closed, ${failed} failed`)

  if (closed > 0 || failed > 0) {
    const emoji = reason === 'EOD-FLAT' ? '🌙' : '🛑'
    await sendLiveTelegram([
      `${emoji} <b>${reason}</b>  · позиции закрыты по рынку`,
      `━━━━━━━━━━━━━━━━━━`,
      `✓ Закрыто: <b>${closed}</b>`,
      failed > 0 ? `✗ Ошибки: <b>${failed}</b>` : '',
    ].filter(Boolean).join('\n'))
  }
  return { closed, failed }
}

/**
 * Cancel virtual PENDING_LIMIT rows from prior UTC days. Since virtual-limit
 * refactor 2026-05-19 these are DB-only rows with no exchange orders behind
 * them, so cleanup is a simple updateMany.
 */
export async function cancelOrphanPendingLimits(): Promise<void> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const r = await prisma.breakoutLiveTradeC.updateMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      limitPlacedAt: { lt: todayStart },
    },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'EXPIRED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${LOG} cancelled ${r.count} orphan virtual PENDING_LIMIT from prior days`)
  }
}

/**
 * Close a single LIVE-C position via reduceOnly MARKET. Used by the per-trade
 * "close-market" route exposed for the BreakoutPaper UI when running variant=LIVE.
 * Mirrors flattenAllOpenC for one row; precise realized P&L still gets reconciled
 * later from ORDER_TRADE_UPDATE / REST refresh.
 */
export async function flattenOneOpenLiveC(tradeId: number, reason: string): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }> {
  if (!state.current) return { ok: false, error: 'Live trader is not running' }

  const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!t) return { ok: false, error: `Trade #${tradeId} not found` }
  if (!ACTIVE_STATUSES.includes(t.status as any)) {
    return { ok: false, error: `Trade #${tradeId} is not open (status=${t.status})` }
  }

  const closesArr = ((t.closes as any[]) ?? [])
  const closedFrac = closesArr.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  const remainingQty = t.positionUnits * remainingFrac

  if (remainingQty <= 0) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    return { ok: true, closed: true }
  }

  const filters = await getFilters(state.current.client)
  const f = filters.get(t.symbol)
  if (!f) return { ok: false, error: `No filter for ${t.symbol}` }

  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    return { ok: true, closed: true }
  }

  const closeSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'
  // Cancel the safety-net SL first — see flattenAllOpenC for rationale.
  await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
  try {
    await state.current.client.placeOrder({
      symbol: t.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: true,
    })
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closes: [
          ...closesArr,
          {
            price: 0,
            percent: Math.round(remainingFrac * 100),
            pnlUsd: 0,
            closedAt: new Date().toISOString(),
            reason,
          },
        ] as any,
        binanceSlOrderId: null,
      },
    })
    console.log(`${LOG} flattened #${t.id} ${t.symbol} ${t.side} qty ${qty} via MARKET (${reason})`)
    return { ok: true, closed: true }
  } catch (e: any) {
    console.warn(`${LOG} flatten #${t.id} MARKET failed: ${e.message}`)
    return { ok: false, error: e.message }
  }
}
