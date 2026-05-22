/**
 * Flatten / cleanup helpers — used by EOD-FLAT, kill-switch, and orphan cleanup.
 */

import { prisma } from '../../db/prisma'
import { LOG, state, snapshot, lastMarkPriceWs, ACTIVE_STATUSES } from './state'
import { getFilters } from './filters'
import { cancelSlOnExchange } from './exchangeSl'
import { cancelAllTpsOnExchange } from './exchangeTp'
import { sendLiveTelegram } from './telegram'
import { recomputeTradeMoney } from './virtualSltp'

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
      const r = await flattenOneRow(t, reason)
      if (r === 'closed') closed++
      else if (r === 'failed') failed++
    } catch (e: any) {
      console.warn(`${LOG} flatten #${t.id} threw: ${e.message}`)
      failed++
    }
  }

  console.log(`${LOG} flatten complete (${reason}): ${closed} closed, ${failed} failed`)

  // EOD-FLAT skips the bulk-close Telegram message — the EOD summary that
  // follows (sendLiveCEodSummary) already lists every closed row with P&L.
  // Kill-switch keeps the announcement so the operator sees the flush fired.
  if (reason !== 'EOD-FLAT' && (closed > 0 || failed > 0)) {
    const emoji = '🛑'
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
 *
 * Also includes rows stuck in `FILLING` (tryFillVirtualLimit claimed the row
 * but didn't release it — e.g. backend crash mid-fill). Anything older than
 * today should be considered dead regardless of state.
 */
export async function cancelOrphanPendingLimits(): Promise<void> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const r = await prisma.breakoutLiveTradeC.updateMany({
    where: {
      limitOrderState: { in: ['PENDING_LIMIT', 'FILLING'] },
      limitPlacedAt: { lt: todayStart },
    },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'EXPIRED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${LOG} cancelled ${r.count} orphan virtual PENDING_LIMIT/FILLING from prior days`)
  }
}

/**
 * Cancel ALL virtual PENDING_LIMIT rows regardless of date. Used by EOD-FLAT
 * (23:55 UTC) — at end of trading day we want zero open exposure: positions
 * are closed via flattenAllOpenC, and any unfilled limits from today should
 * also be cancelled so they don't fire when a new UTC day starts and prices
 * cross the prior day's rangeEdge before a fresh range forms.
 *
 * Also sweeps rows stuck in `FILLING` (backend crash mid-fill, orphan claims).
 */
export async function cancelAllPendingLimits(): Promise<number> {
  const r = await prisma.breakoutLiveTradeC.updateMany({
    where: { limitOrderState: { in: ['PENDING_LIMIT', 'FILLING'] } },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'EXPIRED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${LOG} EOD: cancelled ${r.count} virtual PENDING_LIMIT/FILLING (all dates)`)
  }
  return r.count
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
  lastFlattenError.delete(tradeId)
  const r = await flattenOneRow(t, reason)
  if (r === 'closed') return { ok: true, closed: true }
  if (r === 'finalized') return { ok: true, closed: true }
  const err = lastFlattenError.get(tradeId) ?? 'MARKET reduceOnly failed'
  lastFlattenError.delete(tradeId)
  return { ok: false, error: err }
}

/**
 * Shared per-row flatten logic used by EOD-FLAT, kill-switch and manual close.
 *
 * Key differences from the older (buggy) implementation:
 *   1. Quantity to close pulled from the live snapshot (`positionAmt`) rather
 *      than `positionUnits × remainingFrac`. Step-rounding earlier closes (TP1
 *      qty rounded DOWN) used to leave a 0.5-unit dust on the exchange — see
 *      bug report 2026-05-20 (#4). Snapshot has the exact open size.
 *   2. clientOrderId tagged 'exL{id}_{REASON}' so ORDER_TRADE_UPDATE fires
 *      handleExitFillUpdate, which refines `pnlUsd` / `feePaidUsd` with the
 *      authoritative Binance numbers. Without the tag, the WS event arrives
 *      as 'unknown cid' and the row keeps `pnlUsd: 0` forever — which broke
 *      the equity curve (#1).
 *   3. closes[].pnlUsd is set to a non-zero placeholder computed from the
 *      last known mark price (snapshot/aggTrade). The WS event will overwrite
 *      it with the exact realized P&L, but if the WS event is missed the
 *      placeholder keeps the curve sane instead of dropping to 0.
 */
async function flattenOneRow(t: any, reason: string): Promise<'closed' | 'finalized' | 'failed'> {
  if (!state.current) return 'failed'

  const closesArr = ((t.closes as any[]) ?? [])
  const closedFrac = closesArr.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
  const remainingFracPlanned = Math.max(0, 1 - closedFrac)

  // Read the actual remaining size from the exchange snapshot — TP1/TP2 step
  // rounding may have left a different qty on the book than (units × frac).
  // Falling back to (positionUnits × remainingFrac) if the snapshot is empty.
  const snapPos = snapshot.current?.positions.find((p) => p.symbol === t.symbol)
  const exchangeRemaining = snapPos ? Math.abs(snapPos.positionAmt) : 0
  const plannedRemaining = t.positionUnits * remainingFracPlanned
  const remainingQty = exchangeRemaining > 0 ? exchangeRemaining : plannedRemaining

  if (remainingQty <= 0) {
    // Nothing left to close on exchange (already fully filled via TPs/SL).
    // Cancel any still-active SL/TP algo orders on Binance before flipping
    // the row to CLOSED — otherwise they hang on the exchange book forever
    // (we found 3 such orphans 2026-05-20 from this exact early-return path).
    await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
    await cancelAllTpsOnExchange(t).catch(() => { /* best-effort */ })
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        binanceSlOrderId: null,
        binanceTpOrderIds: [] as any,
      },
    })
    return 'finalized'
  }

  const filters = await getFilters(state.current.client)
  const f = filters.get(t.symbol)
  if (!f) {
    console.warn(`${LOG} flatten #${t.id} — no filter for ${t.symbol}`)
    return 'failed'
  }

  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    // Below min qty — pure dust. Finalize the row and clean up exchange algos.
    await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
    await cancelAllTpsOnExchange(t).catch(() => { /* best-effort */ })
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        binanceSlOrderId: null,
        binanceTpOrderIds: [] as any,
      },
    })
    return 'finalized'
  }

  const closeSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'

  // Cancel safety-net SL + any remaining exchange TPs first — otherwise the
  // next algo trigger races our MARKET and the loser gets -2022 ReduceOnly.
  await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
  await cancelAllTpsOnExchange(t).catch(() => { /* best-effort */ })

  // Best-known fill price for the closes[] placeholder. The WS event will
  // refine this to the exact avgPrice; until it arrives we want a non-zero
  // estimate so the equity curve doesn't read 0.
  const markFromSnap = snapPos?.markPrice ?? lastMarkPriceWs.get(t.symbol) ?? t.entryPrice
  const isLong = t.side === 'BUY'
  const grossPnlPlaceholder = (isLong ? markFromSnap - t.entryPrice : t.entryPrice - markFromSnap) * qty
  // Estimated taker fee — refined by WS event from o.n.
  const feePlaceholder = qty * markFromSnap * ((t.feeTakerPct ?? 0.04) / 100)
  const actualPercent = (qty / t.positionUnits) * 100

  // Tag the MARKET so ORDER_TRADE_UPDATE → handleExitFillUpdate routes the
  // exact fill back into this trade's closes[]. Reason gets folded into the
  // suffix so the handler picks the right closes[] entry to overwrite.
  // 'SL' is reused so the existing SL trailing/notify logic also fires
  // appropriately for terminal close events.
  const cidReason = 'SL' as const
  const exitCid = `exL${t.id}_${cidReason}`

  // Split into chunks if remaining position exceeds MARKET_LOT_SIZE. Symmetric
  // with the chunked entry path in aggTrade.ts — KAS marketMaxQty=10000 so a
  // 106k position needs 11+ legs. Without this split, flattenOneRow used to
  // reject with -4005 "Quantity greater than max quantity" and the manual
  // "Закрыть по рынку" button reported MARKET reduceOnly failed (2026-05-20
  // #4925 KASUSDT after the chunked-entry positionUnits truncation got fixed
  // and the row finally reflected real exchange qty).
  const marketCap = Math.max(f.minQty, f.marketMaxQty || qty)
  const chunks: number[] = []
  if (qty <= marketCap) {
    chunks.push(qty)
  } else {
    let remaining = qty
    while (remaining > 1e-9) {
      const chunk = Math.min(remaining, marketCap)
      let qc = Math.floor(chunk / step) * step
      qc = Number(qc.toFixed(f.quantityPrecision))
      if (qc < f.minQty) break
      chunks.push(qc)
      remaining -= qc
    }
    console.log(`${LOG} flatten #${t.id} ${t.symbol} qty ${qty} > MARKET_LOT_SIZE.maxQty ${marketCap} — splitting into ${chunks.length} legs`)
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkQty = chunks[i]
      const cidForChunk = chunks.length === 1 ? exitCid : `${exitCid}_${i + 1}`
      await state.current.client.placeOrder({
        symbol: t.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: chunkQty,
        reduceOnly: true,
        newClientOrderId: cidForChunk,
      })
    }
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closes: [
          ...closesArr,
          {
            price: markFromSnap,
            percent: actualPercent,
            pnlUsd: grossPnlPlaceholder,
            feePaidUsd: feePlaceholder,
            closedAt: new Date().toISOString(),
            reason: cidReason,  // matches `exL{id}_SL` cid so WS refine targets this entry
            reasonNote: reason, // e.g. 'EOD-FLAT' / 'manual' / 'kill-switch' for the UI
          },
        ] as any,
        binanceSlOrderId: null,
        binanceTpOrderIds: [] as any,
      },
    })
    // Recompute totals from the new closes[] entry so realizedPnlUsd /
    // feesPaidUsd / netPnlUsd reflect the placeholder immediately. The WS
    // event will then overwrite the entry and re-recompute, converging to
    // the exact figures.
    await recomputeTradeMoney(t.id).catch(() => { /* noop */ })
    console.log(`${LOG} flattened #${t.id} ${t.symbol} ${t.side} qty ${qty} via MARKET (${reason}) cid=${exitCid}${chunks.length > 1 ? ` × ${chunks.length} legs` : ''}`)
    return 'closed'
  } catch (e: any) {
    console.warn(`${LOG} flatten #${t.id} MARKET failed: ${e.message}`)
    lastFlattenError.set(t.id, e.message)
    return 'failed'
  }
}

// Per-trade last flatten error message, surfaced by /close-market route so
// the UI can show the user the actual Binance reason instead of the generic
// "MARKET reduceOnly failed".
export const lastFlattenError = new Map<number, string>()
