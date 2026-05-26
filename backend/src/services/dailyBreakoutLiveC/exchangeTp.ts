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
 *
 * `onlyIdx` (optional): restrict placement to a subset of the ladder. Used by
 * reconcileTpsForActiveTrades to re-attach only TPs that disappeared, NEVER
 * to recreate already-filled lower TPs (which would immediately fire and
 * double-close at the old level).
 */
export async function placeTpsOnExchange(trade: any, onlyIdx?: ReadonlyArray<1 | 2 | 3>): Promise<TpAlgoEntry[]> {
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
    if (onlyIdx && !onlyIdx.includes(tpIdx)) continue
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
 * Heartbeat verification for the TP ladder of every active trade.
 *
 * Why: exchange-side algo TPs are the SOLE exit path for TP1/TP2/TP3 after the
 * virtual tracker was removed (2026-05-20). If one of them disappears from the
 * book for any reason — Binance testnet auto-cleanup, a missed -2011 race, a
 * sweep that misclassified the cid, the WS event for our own cancel arriving
 * late — the corresponding profit target stops firing and the position stays
 * open through what should be a clean exit. We saw exactly this on #23636
 * SEIUSDT 2026-05-26: TP1+TP2 fired, TP3 was placed at entry (algoId=...377),
 * mark price crossed TP3 for 40 minutes, no fill ever happened because the
 * algo had silently gone from the book.
 *
 * For every trade in OPEN / TP1_HIT / TP2_HIT we cross-check our DB record of
 * placed TP algos (binanceTpOrderIds) against the live openAlgoOrders list. If
 * an expected TP for an UN-hit level is missing, we re-attach it.
 *
 * Idempotent + safe:
 *   - We only re-place TPs for levels that haven't been hit yet (skip TP1 if
 *     status >= TP1_HIT, etc.) — re-placing a fired TP would double-close.
 *   - We use the same deterministic clientAlgoId 'tpL{id}_{idx}' so a true
 *     duplicate (rare race) gets -4116 and is logged-but-tolerated.
 *   - Falls through silently if state.current isn't set yet.
 */
export async function reconcileTpsForActiveTrades(): Promise<void> {
  if (!state.current) return
  const trades = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (trades.length === 0) return

  let algos: Awaited<ReturnType<typeof state.current.client.getOpenAlgoOrders>>
  try {
    algos = await state.current.client.getOpenAlgoOrders()
  } catch (e: any) {
    // Rate-limit / ban / network — retry next tick.
    if (!(e instanceof BinanceApiError) || e.code !== -1003) {
      console.warn(`${LOG} reconcileTps: getOpenAlgoOrders failed: ${e.message}`)
    }
    return
  }

  // Group algos by symbol for O(1) lookup.
  const algoCidsBySymbol = new Map<string, Set<string>>()
  for (const a of algos) {
    if (!a.clientAlgoId) continue
    let set = algoCidsBySymbol.get(a.symbol)
    if (!set) { set = new Set(); algoCidsBySymbol.set(a.symbol, set) }
    set.add(a.clientAlgoId)
  }

  for (const t of trades) {
    // For each trade, which TP indices SHOULD still be on the book?
    //   OPEN     → TP1, TP2, TP3
    //   TP1_HIT  → TP2, TP3
    //   TP2_HIT  → TP3
    const expectedIdx: Array<1 | 2 | 3> = []
    if (t.status === 'OPEN') expectedIdx.push(1, 2, 3)
    else if (t.status === 'TP1_HIT') expectedIdx.push(2, 3)
    else if (t.status === 'TP2_HIT') expectedIdx.push(3)
    if (expectedIdx.length === 0) continue

    const liveCids = algoCidsBySymbol.get(t.symbol) ?? new Set<string>()
    const missing = expectedIdx.filter((i) => !liveCids.has(`tpL${t.id}_${i}`))
    if (missing.length === 0) continue

    // Drop the missing entries from binanceTpOrderIds so re-attach can re-place
    // them under the same cid (deterministic — Binance will throw -4116 if the
    // old one is somehow still alive but it's safer to ASK the exchange via
    // a fresh placeAlgoOrder than to trust DB ref of a maybe-dead algo id).
    const currentStored = ((t.binanceTpOrderIds as any[]) ?? []) as TpAlgoEntry[]
    const survivors = currentStored.filter((e) => !missing.includes(Number(e.tpIdx) as 1 | 2 | 3))
    if (survivors.length !== currentStored.length) {
      await prisma.breakoutLiveTradeC.update({
        where: { id: t.id },
        data: { binanceTpOrderIds: survivors as any },
      }).catch(() => { /* noop */ })
    }

    // Compute the remaining position the TPs should cover. For TP1_HIT/TP2_HIT
    // the original split percentages of the FULL positionUnits are still the
    // right qty per TP (since each TP is independent reduceOnly slicing of the
    // original size). We pass a synthetic trade object with positionUnits set
    // to the original full size so placeTpsOnExchange computes the SAME splits
    // the entry-time call used — guarantees the re-attached TPs match what
    // was originally on the book.
    const refreshed = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
    if (!refreshed) continue

    // Re-place ONLY the missing levels — passing onlyIdx prevents the function
    // from recreating any already-filled lower TPs that would immediately fire
    // at the old trigger and double-close the position (would-be catastrophic
    // for TP2_HIT trades where TP1's trigger is now far in profit).
    console.warn(`${LOG} ⚠ TP heartbeat: re-attaching missing TP${missing.join('/')} for #${t.id} ${t.symbol} (status=${t.status})`)
    const newOnes = await placeTpsOnExchange(refreshed, missing).catch((e) => {
      console.warn(`${LOG} reconcileTps: placeTpsOnExchange #${t.id} threw: ${e?.message ?? e}`)
      return [] as TpAlgoEntry[]
    })
    if (newOnes.length === 0) continue

    const merged: TpAlgoEntry[] = [
      ...survivors.filter((e) => !newOnes.some((n) => Number(n.tpIdx) === Number(e.tpIdx))),
      ...newOnes,
    ]
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: { binanceTpOrderIds: merged as any },
    }).catch(() => { /* noop */ })
    console.log(`${LOG} 🎯 TP heartbeat re-attached #${t.id} ${t.symbol}: ${newOnes.map((n) => `TP${n.tpIdx}=${n.algoId}`).join(', ')}`)
  }
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
