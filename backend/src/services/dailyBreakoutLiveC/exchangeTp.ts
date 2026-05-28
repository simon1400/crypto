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
import { LOG, state, snapshot, lastMarkPriceWs, ACTIVE_STATUSES, SPLITS } from './state'
import { getFilters } from './filters'
import { closeReduceOnlyOrPlain } from './closeHelper'

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
      // -2021 here means mark already past trigger. Caller (reconcileTpsForActiveTrades)
      // detects this state upstream and routes to catchUpMissedTp before reaching
      // placeTpsOnExchange, but log explicitly so the entry-time attach path
      // (attachTpsAfterEntry) surfaces it visibly — that path will get caught
      // by the next reconcile heartbeat.
      console.warn(`${LOG} placeTps #${trade.id} TP${tpIdx}: failed — ${lastErr}`)
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
 * Catch-up close for a TP whose algo went missing on the exchange WHILE mark
 * price has already moved past the trigger. Attempting to (re)place at that
 * point returns -2021 — nothing lands on the book, and (since the virtual
 * tracker was removed 2026-05-20) the TP slice would never fire.
 *
 * Replays what the algo would have done: MARKET reduceOnly for the slice qty
 * with cid 'exL{id}_TP{n}' so handleExitFillUpdate refines closes[] with the
 * authoritative Binance fill numbers. applyVirtualClose handles the SL trail
 * (TP1→BE / TP2→TP1 / TP3 terminal) the same way as a normal algo fill.
 *
 * Idempotency: ACTIVE_STATUSES gate + closes[] reason check inside
 * applyVirtualClose's caller convention — we also guard with a per-trade
 * tradeBusy-style lock via the existing applyVirtualClose status guard.
 */
export async function catchUpMissedTp(tradeId: number, tpIdx: 1 | 2 | 3): Promise<void> {
  if (!state.current) return
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh) return
  if (!ACTIVE_STATUSES.includes(fresh.status as any)) return

  // Has this TP already been recorded (race with the real algo finally firing,
  // or a concurrent catch-up)? Skip.
  const closesArr = ((fresh.closes as any[]) ?? []) as Array<{ reason?: string }>
  if (closesArr.some((c) => c.reason === `TP${tpIdx}`)) return

  // Don't re-catch-up a TP for a status that's already past it (e.g. trying
  // to catch up TP1 when status is already TP2_HIT).
  if (fresh.status === 'TP1_HIT' && tpIdx === 1) return
  if (fresh.status === 'TP2_HIT' && (tpIdx === 1 || tpIdx === 2)) return

  const filtersMap = await getFilters(state.current.client).catch(() => null)
  const f = filtersMap?.get(fresh.symbol)
  if (!f) {
    console.warn(`${LOG} catchUpMissedTp #${fresh.id}: no filter for ${fresh.symbol}`)
    return
  }

  const splitFrac = SPLITS[tpIdx - 1] ?? 0
  if (splitFrac <= 0) return

  // Slice qty: same geometry as placeTpsOnExchange (positionUnits × split,
  // floor to stepSize). TP3 falls back to remainder when called from the
  // ladder; for catch-up we just use the static split — if TP1/TP2 already
  // partially closed, exchange remaining < planned and the reduceOnly will
  // clamp, but the algo-original split is the right number to record.
  const step = f.stepSize
  let qty = Math.floor((fresh.positionUnits * splitFrac) / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    console.warn(`${LOG} catchUpMissedTp #${fresh.id} TP${tpIdx}: qty ${qty} < minQty ${f.minQty} — skipping`)
    return
  }

  // Cap qty by the exchange's remaining position — TP1's planned 50% slice
  // could exceed what's actually open if a manual close shaved the position.
  const snapPos = snapshot.current?.positions.find((p) => p.symbol === fresh.symbol)
  const exchangeRemaining = snapPos ? Math.abs(snapPos.positionAmt) : 0
  if (exchangeRemaining > 0 && qty > exchangeRemaining) {
    let capped = Math.floor(exchangeRemaining / step) * step
    capped = Number(capped.toFixed(f.quantityPrecision))
    if (capped < f.minQty) {
      console.warn(`${LOG} catchUpMissedTp #${fresh.id} TP${tpIdx}: exchange remaining ${exchangeRemaining} < minQty — skipping`)
      return
    }
    qty = capped
  }

  const closeSide: 'BUY' | 'SELL' = fresh.side === 'BUY' ? 'SELL' : 'BUY'
  const exitCid = `exL${fresh.id}_TP${tpIdx}`
  // Safe close: reduceOnly first, plain-MARKET fallback on testnet -2022 (guarded
  // by a live position re-read). Without this, every TP heartbeat tick burned a
  // -2022 and returned, stranding ETH/DYDX-class trades OPEN forever in a 60s
  // loop while mark was clearly past TP1 (root cascade: 2026-05-27 ETH #32311).
  const cr = await closeReduceOnlyOrPlain(state.current.client, {
    symbol: fresh.symbol, closeSide, quantity: qty, clientOrderId: exitCid,
  })
  if (!cr.ok) {
    console.warn(`${LOG} catchUpMissedTp #${fresh.id} TP${tpIdx} close failed: ${cr.reason}`)
    return
  }
  if (cr.placed !== true) {
    // "already flat" or sub-min dust — no order went out; let reconcileClosed handle it.
    console.warn(`${LOG} catchUpMissedTp #${fresh.id} TP${tpIdx}: ${cr.reason ?? 'no order placed'} — reconcileClosed will finalize`)
    return
  }

  // Placeholder uses trigger price for pnlR (matches handleTpOrderUpdate
  // convention). WS refine via cid='exL{id}_TP{n}' overwrites price/pnl/fee
  // with the exact fill once ORDER_TRADE_UPDATE lands.
  const triggerPrice = (fresh.tpLadder as number[])[tpIdx - 1] ?? lastMarkPriceWs.get(fresh.symbol) ?? fresh.entryPrice
  const isLong = fresh.side === 'BUY'
  const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
  const pnlR = initialRisk > 0
    ? ((isLong ? triggerPrice - fresh.entryPrice : fresh.entryPrice - triggerPrice) / initialRisk) * splitFrac
    : 0
  const grossPnl = (isLong ? triggerPrice - fresh.entryPrice : fresh.entryPrice - triggerPrice) * qty
  const estFee = qty * triggerPrice * ((fresh.feeTakerPct ?? 0.04) / 100)

  const { applyVirtualClose } = await import('./virtualSltp')
  await applyVirtualClose(fresh, `TP${tpIdx}` as 'TP1' | 'TP2' | 'TP3', triggerPrice, splitFrac, pnlR, grossPnl - estFee, Date.now(), estFee, true)
  console.log(`${LOG} 🛟 catch-up TP${tpIdx} #${fresh.id} ${fresh.symbol} qty=${qty} (algo was missing on book + mark past trigger)`)
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

    // Split missing TPs into two buckets:
    //   pastTrigger — mark price has already crossed this TP. Re-placing would
    //                 return -2021 "would immediately trigger". Catch up via
    //                 MARKET reduceOnly with cid 'exL{id}_TP{n}' so the slice
    //                 actually fires and the SL trails correctly.
    //   reattachable — mark hasn't crossed yet, safe to re-place as algo.
    const tpLadder = ((t.tpLadder as number[]) ?? []) as number[]
    const isLong = t.side === 'BUY'
    const mark = lastMarkPriceWs.get(t.symbol)
      ?? snapshot.current?.positions.find((p) => p.symbol === t.symbol)?.markPrice
      ?? null

    const pastTrigger: Array<1 | 2 | 3> = []
    const reattachable: Array<1 | 2 | 3> = []
    for (const idx of missing) {
      const trig = tpLadder[idx - 1]
      if (mark != null && trig && (isLong ? mark >= trig : mark <= trig)) {
        pastTrigger.push(idx)
      } else {
        reattachable.push(idx)
      }
    }

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

    // Catch up past-trigger levels first. Each catch-up call mutates the row
    // (status flip / trail), so subsequent ones see the latest state.
    if (pastTrigger.length > 0) {
      console.warn(`${LOG} ⚠ TP heartbeat: mark past trigger for TP${pastTrigger.join('/')} on #${t.id} ${t.symbol} — catching up via MARKET`)
      for (const idx of pastTrigger) {
        await catchUpMissedTp(t.id, idx).catch((e) =>
          console.warn(`${LOG} catchUpMissedTp #${t.id} TP${idx} threw: ${e?.message ?? e}`))
      }
    }

    if (reattachable.length === 0) continue

    const refreshed = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
    if (!refreshed) continue
    // Re-fetch missing set against the post-catchup state — a catch-up flipped
    // OPEN→TP1_HIT, so TP1 is no longer "missing", it's "filled".
    const stillExpected: Array<1 | 2 | 3> = []
    if (refreshed.status === 'OPEN') stillExpected.push(1, 2, 3)
    else if (refreshed.status === 'TP1_HIT') stillExpected.push(2, 3)
    else if (refreshed.status === 'TP2_HIT') stillExpected.push(3)
    const toPlace = reattachable.filter((idx) => stillExpected.includes(idx))
    if (toPlace.length === 0) continue

    console.warn(`${LOG} ⚠ TP heartbeat: re-attaching missing TP${toPlace.join('/')} for #${t.id} ${t.symbol} (status=${refreshed.status})`)
    const newOnes = await placeTpsOnExchange(refreshed, toPlace).catch((e) => {
      console.warn(`${LOG} reconcileTps: placeTpsOnExchange #${t.id} threw: ${e?.message ?? e}`)
      return [] as TpAlgoEntry[]
    })
    if (newOnes.length === 0) continue

    // Re-read the row again — applyVirtualClose during catch-up may have
    // cleared binanceTpOrderIds on terminal exits, so we can't use the
    // pre-catchup `survivors` snapshot as the base.
    const t2 = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
    const baseTps = ((t2?.binanceTpOrderIds as any[]) ?? []) as TpAlgoEntry[]
    const merged: TpAlgoEntry[] = [
      ...baseTps.filter((e) => !newOnes.some((n) => Number(n.tpIdx) === Number(e.tpIdx))),
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
