/**
 * Exchange-side TP ladder (hybrid model)
 *
 * After SL was already wired to /fapi/v1/algoOrder, TPs stayed virtual — the
 * aggTrade tracker + kline watchdog drove all 3 closes. Worked, but exposed
 * the position to a "no-fill" window if both layers missed the wick (rare
 * but happened — see #4868 SEIUSDT 2026-05-19).
 *
 * Now we place 3 TAKE_PROFIT_MARKET reduceOnly algo orders at entry, qty
 * matching the 50/30/20 split. The virtual tracker still watches aggTrade
 * and the watchdog still replays klines — these layers race the exchange,
 * and the existing tradeBusy lock + closes[] idempotency make duplicates
 * safe. First fill wins; the other path's MARKET reduceOnly gets -2022 and
 * we treat that as "already closed by us" (the existing handler).
 *
 * qty geometry — fixed at entry, never retrailed:
 *   TP1 → 50% of positionUnits
 *   TP2 → 30% of positionUnits
 *   TP3 → 20% of positionUnits (or the floor remainder to avoid dust)
 *
 * After TP1 fills, remaining position is 50%. TP2 qty=30% is still ≤ 50%, so
 * reduceOnly handles it cleanly. After TP2, remaining = 20%, TP3 qty=20% ≤
 * 20%. No re-placement needed.
 *
 * clientAlgoId format: 'tpL{tradeId}_{tpIdx}' where tpIdx ∈ {1, 2, 3}. The
 * resulting fill arrives as ORDER_TRADE_UPDATE with clientOrderId equal to
 * this clientAlgoId (Binance preserves it).
 *
 * When the bot's virtual tracker fires a TP before the exchange algo does:
 *   - exitLiveTradeSlice cancels the matching exchange TP before sending its
 *     MARKET, avoiding -2022 race.
 *
 * When the exchange algo fires first:
 *   - handleTpOrderUpdate runs applyVirtualClose with the exact fill values.
 *
 * Storage: binanceTpOrderIds Json — array of { tpIdx, algoId } objects so we
 * can cancel just the unhit levels without touching the filled one.
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, state, SPLITS } from './state'
import { getFilters } from './filters'

export interface TpAlgoEntry { tpIdx: 1 | 2 | 3; algoId: string }

/**
 * Place all three TPs as TAKE_PROFIT_MARKET reduceOnly algo orders. Best-
 * effort: if any one fails (e.g. -2021 already past trigger, rare for TPs at
 * entry), we still place the others. The virtual tracker covers any gaps.
 */
export async function placeTpsOnExchange(trade: any): Promise<TpAlgoEntry[]> {
  if (!state.current) return []
  const filters = await getFilters(state.current.client)
  const f = filters.get(trade.symbol)
  if (!f) {
    console.warn(`${LOG} placeTps #${trade.id}: no filter for ${trade.symbol}`)
    return []
  }

  const tpLadder = (trade.tpLadder as number[]) ?? []
  if (tpLadder.length < 3) {
    console.warn(`${LOG} placeTps #${trade.id}: tpLadder.length=${tpLadder.length} < 3 — skipping`)
    return []
  }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const tick = f.tickSize
  const step = f.stepSize

  // Compute qty per TP from SPLITS [0.5, 0.3, 0.2]. For TP3 use the floor
  // remainder so step rounding doesn't leave dust on the exchange.
  let qty1 = Math.floor((trade.positionUnits * SPLITS[0]) / step) * step
  let qty2 = Math.floor((trade.positionUnits * SPLITS[1]) / step) * step
  let qty3 = Math.floor((trade.positionUnits - qty1 - qty2) / step) * step
  qty1 = Number(qty1.toFixed(f.quantityPrecision))
  qty2 = Number(qty2.toFixed(f.quantityPrecision))
  qty3 = Number(qty3.toFixed(f.quantityPrecision))

  const qtys: [number, number, number] = [qty1, qty2, qty3]
  const placed: TpAlgoEntry[] = []

  for (let i = 0; i < 3; i++) {
    const tpIdx = (i + 1) as 1 | 2 | 3
    const qty = qtys[i]
    if (qty < f.minQty) {
      console.warn(`${LOG} placeTps #${trade.id} TP${tpIdx}: qty ${qty} < minQty ${f.minQty} — skipping`)
      continue
    }
    const triggerPrice = Number((Math.round(tpLadder[i] / tick) * tick).toFixed(f.pricePrecision))
    const tpClientId = `tpL${trade.id}_${tpIdx}`

    let placedThis = false
    let lastErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await state.current.client.placeAlgoOrder({
          symbol: trade.symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice,
          quantity: qty,
          reduceOnly: true,
          workingType: 'MARK_PRICE',
          clientAlgoId: tpClientId,
        })
        placed.push({ tpIdx, algoId: String(r.algoId) })
        placedThis = true
        break
      } catch (e: any) {
        lastErr = e?.message ?? String(e)
        // -2021 "Order would immediately trigger" — markPrice already past TP.
        // The virtual tracker will pick it up on the next aggTrade tick.
        if (e instanceof BinanceApiError && e.code === -2021) break
        if (attempt < 3) {
          await new Promise((res) => setTimeout(res, attempt === 1 ? 500 : 1500))
        }
      }
    }
    if (!placedThis) {
      console.warn(`${LOG} placeTps #${trade.id} TP${tpIdx}: failed — ${lastErr} (virtual TP still active)`)
    }
  }

  return placed
}

/**
 * Cancel a single TP algo order. Used by exitLiveTradeSlice when the virtual
 * tracker fires a TP before the exchange algo does — same pattern as
 * cancelSlOnExchange. Reads from binanceTpOrderIds, finds the entry for tpIdx,
 * cancels on Binance, removes from the array.
 */
export async function cancelTpOnExchange(trade: any, tpIdx: 1 | 2 | 3): Promise<void> {
  if (!state.current) return
  const tpAlgos = ((trade.binanceTpOrderIds as any[]) ?? []) as TpAlgoEntry[]
  const entry = tpAlgos.find((t) => Number(t.tpIdx) === tpIdx)
  if (!entry) return
  let cancelledOrAlreadyGone = false
  try {
    await state.current.client.cancelAlgoOrder(trade.symbol, {
      algoId: Number(entry.algoId),
    })
    cancelledOrAlreadyGone = true
  } catch (e: any) {
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) {
      cancelledOrAlreadyGone = true  // already gone, fine
    } else {
      console.warn(`${LOG} cancel TP${tpIdx} #${trade.id} ${trade.symbol} failed: ${e.message}`)
      // Transient failure — leave in DB so retry/sweep can finish.
    }
  }
  if (!cancelledOrAlreadyGone) return
  const remaining = tpAlgos.filter((t) => Number(t.tpIdx) !== tpIdx)
  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: { binanceTpOrderIds: remaining as any },
  }).catch(() => { /* noop */ })
}

/**
 * Cancel ALL stored TP algo orders for this trade. Used on terminal exits
 * (SL hit, TP3 hit, flatten/kill) so no algo orders are left hanging on the
 * book after the position is closed.
 *
 * Per-entry result handling: only drop a TP from binanceTpOrderIds if it was
 * actually cancelled or returned -2011/-2013 (already gone). On a rate-limit
 * (-1003) or other transient failure we keep it in the array so the next
 * cancel attempt (or sweepStrayAlgoOrders) can finish the job. Previously we
 * unconditionally zeroed out the array even on failures, which made
 * binanceTpOrderIds report "all cancelled" while the orders kept living on
 * the exchange — observed 2026-05-20 #4923 TRUMPUSDT (three 429s during SL
 * fill, TPs survived the close).
 */
export async function cancelAllTpsOnExchange(trade: any): Promise<void> {
  if (!state.current) return
  const tpAlgos = ((trade.binanceTpOrderIds as any[]) ?? []) as TpAlgoEntry[]
  if (tpAlgos.length === 0) return
  const stillOpen: TpAlgoEntry[] = []
  for (const t of tpAlgos) {
    try {
      await state.current.client.cancelAlgoOrder(trade.symbol, { algoId: Number(t.algoId) })
      // success → drop from stored array
    } catch (e: any) {
      if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) {
        // already gone → drop from stored array
        continue
      }
      console.warn(`${LOG} cancel TP${t.tpIdx} #${trade.id} ${trade.symbol} failed: ${e.message}`)
      // Transient failure (rate limit, network, etc.) — KEEP in array so a
      // later sweep finishes the cancel. Don't lie to the DB.
      stillOpen.push(t)
    }
  }
  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: { binanceTpOrderIds: stillOpen as any },
  }).catch(() => { /* noop */ })
}

/**
 * Place TPs after entry. Mirrors attachSlAfterEntry: idempotent, runs after
 * status flips to OPEN. Writes binanceTpOrderIds on the trade row.
 */
export async function attachTpsAfterEntry(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh || fresh.status !== 'OPEN') return
  const existing = ((fresh.binanceTpOrderIds as any[]) ?? []) as TpAlgoEntry[]
  if (existing.length > 0) return  // already placed (idempotent on reconcile/retry)

  const placed = await placeTpsOnExchange(fresh)
  if (placed.length > 0) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: tradeId },
      data: { binanceTpOrderIds: placed as any },
    })
    console.log(`${LOG} 🎯 TPs placed on exchange #${tradeId} ${fresh.symbol}: ${placed.map((t) => `TP${t.tpIdx}=${t.algoId}`).join(', ')}`)
  } else {
    console.warn(`${LOG} ⚠ no TPs placed for #${tradeId} ${fresh.symbol} — virtual TP layer still active`)
  }
}
