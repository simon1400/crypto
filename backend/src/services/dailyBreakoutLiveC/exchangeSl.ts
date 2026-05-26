/**
 * Exchange-side SL (hybrid model)
 *
 * The virtual tracker (trackLiveTrade) is the primary exit path: it watches
 * aggTrade ticks and sends MARKET reduceOnly when price crosses a level. It's
 * robust and identical to paper C.
 *
 * On top of that we *also* place a STOP_MARKET reduceOnly on Binance as a
 * safety net for the SL specifically:
 *   - If the bot dies (PM2 restart, VPS reboot, WS disconnect storm) the
 *     exchange-side SL still triggers — no naked position.
 *   - SL closes via STOP_MARKET cost taker fee anyway (the exit IS a market
 *     order once it triggers), so we don't lose on commissions vs the virtual
 *     path. Avg slippage is comparable.
 *   - TPs stay virtual — trailing requires "cancel old SL + place new SL"
 *     after each TP, which is simpler than juggling 3 child orders that all
 *     need recalibration.
 *
 * When the exchange SL fires:
 *   - ORDER_TRADE_UPDATE arrives with clientOrderId='slL{tradeId}', X=FILLED
 *   - handleSlOrderUpdate() invokes applyVirtualClose(reason='SL') so the DB
 *     and Telegram path is exactly the same as a virtual SL hit.
 *
 * When the bot's virtual SL fires first:
 *   - exitLiveTradeSlice cancels the exchange SL before sending MARKET,
 *     avoiding -2022 ReduceOnly rejected.
 *
 * Binance migrated STOP_MARKET to the Algo Order API in 2025-12 — the regular
 * /fapi/v1/order endpoint returns -4120. So we use placeAlgoOrder. The trigger
 * uses MARK_PRICE (not last trade) to avoid wick-out flashes.
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, state, snapshot, lastMarkPriceWs, ACTIVE_STATUSES } from './state'
import { getFilters } from './filters'
import { sendLiveTelegram } from './telegram'

type PlaceSlResult = { ok: true; algoId: bigint } | { ok: false; error: string }

export async function placeSlOnExchange(trade: any): Promise<PlaceSlResult> {
  if (!state.current) return { ok: false, error: 'live trader not running' }
  const filters = await getFilters(state.current.client)
  const f = filters.get(trade.symbol)
  if (!f) return { ok: false, error: `no filter for ${trade.symbol}` }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const tick = f.tickSize
  const triggerPrice = Number((Math.round(trade.currentStop / tick) * tick).toFixed(f.pricePrecision))
  // Round quantity DOWN to stepSize — retrailSlOnExchange passes the remaining
  // position fraction (e.g. 8375 × 0.5 = 4187.5 after TP1), which Binance rejects
  // with -1111 Precision when stepSize=1 (UBUSDT bug 2026-05-19 #4898). Apply
  // the same floor-to-step that placeOrder uses for entries / exit slices.
  const step = f.stepSize
  let qty = Math.floor(trade.positionUnits / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    return { ok: false, error: `qty ${qty} below minQty ${f.minQty} after step rounding` }
  }
  const slClientId = `slL${trade.id}`

  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await state.current.client.placeAlgoOrder({
        symbol: trade.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        triggerPrice,
        quantity: qty,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
        clientAlgoId: slClientId,
      })
      return { ok: true, algoId: BigInt(r.algoId) }
    } catch (e: any) {
      lastErr = e?.message ?? String(e)
      // -2021 'Order would immediately trigger' — markPrice already past stop.
      // No point retrying; let the virtual tracker handle this on the next tick.
      if (e instanceof BinanceApiError && e.code === -2021) break
      // Backoff before next attempt: 500ms, 1500ms.
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, attempt === 1 ? 500 : 1500))
      }
    }
  }
  return { ok: false, error: lastErr }
}

export async function cancelSlOnExchange(trade: any): Promise<void> {
  if (!state.current) return
  if (!trade.binanceSlOrderId) return
  try {
    await state.current.client.cancelAlgoOrder(trade.symbol, {
      algoId: Number(trade.binanceSlOrderId),
    })
  } catch (e: any) {
    // -2011 unknown order, -2013 doesn't exist — already gone, fine.
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) return
    console.warn(`${LOG} cancel SL #${trade.id} ${trade.symbol} failed: ${e.message}`)
  }
}

/**
 * Place SL after entry fill. Best-effort: on failure we keep the position
 * open with a virtual-only SL (trackLiveTrade still owns the exit) and warn
 * via Telegram so the operator can intervene.
 */
export async function attachSlAfterEntry(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh || fresh.status !== 'OPEN') return
  if (fresh.binanceSlOrderId) return  // already placed (idempotent on reconcile/retry)

  const r = await placeSlOnExchange(fresh)
  if (r.ok) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: tradeId },
      data: { binanceSlOrderId: r.algoId },
    })
    console.log(`${LOG} 🛡 SL placed on exchange #${tradeId} ${fresh.symbol} @ ${fresh.currentStop} (algoId=${r.algoId})`)
    return
  }
  // -2021 "Order would immediately trigger" right after entry → mark price has
  // already crossed the initial stop (entry slippage exceeded the stop distance).
  // That's exactly what the SL would have done; replay it via MARKET reduceOnly
  // instead of leaving the position stranded. The virtual SL tracker was removed
  // 2026-05-20 so there's no other safety net.
  if (r.error.includes('-2021')) {
    console.warn(`${LOG} ⚠ SL placement #${tradeId} ${fresh.symbol}: -2021 (mark already past trigger) — catching up via MARKET`)
    await closeMissedSl(tradeId).catch((e) =>
      console.warn(`${LOG} closeMissedSl #${tradeId} threw: ${e?.message ?? e}`))
    return
  }
  console.warn(`${LOG} ⚠ SL placement failed for #${tradeId} ${fresh.symbol}: ${r.error}`)
  sendLiveTelegram([
    `⚠️ <b>${fresh.symbol}</b> · SL не выставлен на бирже`,
    `━━━━━━━━━━━━━━━━━━`,
    `Причина: <code>${r.error}</code>`,
    `SL heartbeat попробует переставить на следующем цикле.`,
  ].join('\n'))
}

/**
 * Retrail SL on Binance after TP1/TP2 hit. Cancels the old algo order and
 * places a fresh STOP_MARKET at the new currentStop level.
 *
 * Failure modes that used to leave a stale SL hanging at the old trigger
 * (observed 2026-05-20 #4903 AAVE: TP1 fired but cancel SL got 418/-1003 IP
 * ban, then place got -4116 ClientOrderId duplicated, then DB nulled
 * binanceSlOrderId — net result: old SL @ $86.57 still alive on the book,
 * DB thinks none, app couldn't see/cancel it):
 *
 *   1. Cancel SL fails (429/418/network) → DON'T null binanceSlOrderId.
 *      Keep the ref so the next retrail/sweep can try again. (Symmetric
 *      with cancelAllTpsOnExchange fix.)
 *   2. Place new SL fails with -4116 duplicate cid → the old SL is still
 *      on the book under our deterministic clientAlgoId 'slL{id}'. Try a
 *      one-shot exchange-side recovery: look up the live algo by cid,
 *      adopt its algoId into binanceSlOrderId so virtual layer can still
 *      manage it.
 */
export async function retrailSlOnExchange(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh) return
  // Only retrail while position is still open.
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) return

  const cancelOk = await cancelSlOnExchangeStrict(fresh)
  if (!cancelOk) {
    // Old SL still on the book — DON'T null DB ref, DON'T place a duplicate.
    // Next TP hit or sweepStrayAlgoOrders will retry.
    console.warn(`${LOG} ⚠ SL retrail #${tradeId} ${fresh.symbol}: cancel old SL failed (rate limit / network) — keeping stale ref, will retry`)
    return
  }
  // Reset stored algoId only AFTER successful cancel.
  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: { binanceSlOrderId: null },
  })
  // The remaining position size is smaller after a partial TP — re-fetch and
  // pass it to placeSlOnExchange via positionUnits. We adjust by closed fraction.
  const refreshed = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!refreshed) return
  const closesArr = ((refreshed.closes as any[]) ?? []) as Array<{ percent?: number }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingUnits = refreshed.positionUnits * Math.max(0, 1 - closedFrac)
  const tradeForSl = { ...refreshed, positionUnits: remainingUnits }
  const r = await placeSlOnExchange(tradeForSl)
  if (r.ok) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: tradeId },
      data: { binanceSlOrderId: r.algoId },
    })
    console.log(`${LOG} 🛡 SL retrailed #${tradeId} ${refreshed.symbol} → ${refreshed.currentStop}`)
  } else {
    // -2021 "Order would immediately trigger" — mark price has already crossed
    // the (trailed or initial) stop. Replay what the algo would have done via
    // MARKET reduceOnly so the position doesn't sit stranded. Same fix as in
    // attachSlAfterEntry. The virtual SL tracker was removed 2026-05-20 so
    // there's nothing else covering this gap.
    if (r.error.includes('-2021')) {
      console.warn(`${LOG} ⚠ SL retrail #${tradeId}: -2021 (mark already past trigger) — catching up via MARKET`)
      await closeMissedSl(tradeId).catch((e) =>
        console.warn(`${LOG} closeMissedSl #${tradeId} threw: ${e?.message ?? e}`))
      return
    }
    console.warn(`${LOG} ⚠ SL retrail failed #${tradeId}: ${r.error}`)
    // -4116 means our deterministic cid is still alive on the book — the
    // earlier cancel didn't fully take. Try to recover the algoId so the
    // ref points at SOMETHING (otherwise repair-sltp can't see it either).
    if (r.error.includes('-4116') && state.current) {
      try {
        const algos = await state.current.client.getOpenAlgoOrders()
        const stale = algos.find((a) => a.symbol === refreshed.symbol && a.clientAlgoId === `slL${tradeId}`)
        if (stale) {
          await prisma.breakoutLiveTradeC.update({
            where: { id: tradeId },
            data: { binanceSlOrderId: BigInt(stale.algoId) },
          })
          console.log(`${LOG} ↻ SL recovered #${tradeId} ${refreshed.symbol} adopted stale algoId=${stale.algoId} from exchange`)
        }
      } catch (e: any) {
        console.warn(`${LOG} SL recovery lookup failed #${tradeId}: ${e?.message ?? e}`)
      }
    }
  }
}

/**
 * SL heartbeat — verify every active trade still has its STOP_MARKET on the
 * exchange at the right trigger price. Covers three failure modes:
 *
 *   1. OPEN trade with missing SL — attachSlAfterEntry failed or the algo
 *      silently disappeared from the book (testnet auto-cleanup, sweep race).
 *      Without this nothing re-attaches it; the position is "naked" until SL
 *      fires manually (the FARTCOINUSDT #23654 case 2026-05-26).
 *   2. TP1_HIT / TP2_HIT trade with missing SL — same as above but on a
 *      partially-closed position; original retrailSl bailed on rate-limit ban.
 *   3. SL trigger drift — DB.currentStop diverged from exchange triggerPrice
 *      (typically rounding noise; covered by the half-tick tolerance below).
 *
 * Runs from cycle.ts every minute so a transient ban during TP1 fire gets
 * auto-recovered on the next tick after the ban window expires.
 */
export async function reconcileSlOnExchange(): Promise<void> {
  if (!state.current) return
  const trails = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
    select: {
      id: true, symbol: true, currentStop: true, binanceSlOrderId: true,
    },
  })
  if (trails.length === 0) return

  let algos: Awaited<ReturnType<typeof state.current.client.getOpenAlgoOrders>>
  try {
    algos = await state.current.client.getOpenAlgoOrders()
  } catch (e: any) {
    // Likely rate-limit / ban still in effect — try again on the next tick.
    if (!(e instanceof BinanceApiError) || e.code !== -1003) {
      console.warn(`${LOG} reconcileSl: getOpenAlgoOrders failed: ${e.message}`)
    }
    return
  }

  // Need symbol filters to compute the tick-rounded version of currentStop
  // (which is what placeSlOnExchange actually sends to Binance). Without this,
  // a DB.currentStop=0.06074 vs exchange triggerPrice=0.0607 (after Binance's
  // tickSize=0.0001 rounding) keeps "drifting" by 0.066% every minute and we'd
  // cancel+replace the SL forever (observed 2026-05-20 #4907 SEIUSDT).
  const filtersMap = await getFilters(state.current.client).catch(() => null)

  for (const t of trails) {
    const algo = algos.find((a) => a.symbol === t.symbol && a.clientAlgoId === `slL${t.id}`)
    if (!algo) {
      // No STOP_MARKET on exchange at all — retrail will place one fresh.
      console.log(`${LOG} reconcileSl: no SL on exchange for #${t.id} ${t.symbol} — attempting retrail`)
      await retrailSlOnExchange(t.id).catch((e) =>
        console.warn(`${LOG} reconcileSl retrail #${t.id} failed: ${e?.message ?? e}`))
      continue
    }
    const exchangeTrigger = Number(algo.triggerPrice)
    if (!Number.isFinite(exchangeTrigger) || exchangeTrigger <= 0) continue

    // Round DB.currentStop the same way placeSlOnExchange would. After
    // rounding, the two prices should be byte-identical when the trailed
    // SL is in sync. If they still differ — retrail is genuinely needed.
    const f = filtersMap?.get(t.symbol)
    const tick = f?.tickSize ?? 0
    const dbRounded = tick > 0
      ? Number((Math.round(t.currentStop / tick) * tick).toFixed(f?.pricePrecision ?? 8))
      : t.currentStop
    // Tolerance = half a tick (covers floating-point representation noise on
    // either side). 0.01% multiplier kept as a fallback for unknown filters.
    const tolerance = tick > 0 ? tick / 2 : Math.max(dbRounded, exchangeTrigger) * 0.0001
    if (Math.abs(exchangeTrigger - dbRounded) <= tolerance) continue

    console.log(`${LOG} reconcileSl: #${t.id} ${t.symbol} drift detected — exchange ${exchangeTrigger} vs DB ${t.currentStop} (rounded ${dbRounded}); retrailing`)
    await retrailSlOnExchange(t.id).catch((e) =>
      console.warn(`${LOG} reconcileSl retrail #${t.id} failed: ${e?.message ?? e}`))
  }
}

/**
 * Catch-up close when the SL algo was missing on the exchange AND mark price
 * has already moved past the trigger. In that state, attempting to (re)place
 * STOP_MARKET returns -2021 "Order would immediately trigger" — nothing lands
 * on the book, the bot used to log "virtual SL still active" but the virtual
 * tracker was removed 2026-05-20, so the position was stranded open.
 *
 * The fix replays what the algo would have done: a MARKET reduceOnly for the
 * remaining position with cid 'exL{id}_SL'. ORDER_TRADE_UPDATE then arrives
 * via handleExitFillUpdate and refines closes[] with Binance's authoritative
 * fill price + commission + realizedPnl. applyVirtualClose writes the closes[]
 * placeholder + runs the same terminal cleanup any normal SL would.
 *
 * Idempotency: the entire helper is gated by ACTIVE_STATUSES + a sub-1e-6
 * remainingFrac check, so a double-call from concurrent reconcile / retrail
 * paths is a no-op on the second one.
 */
export async function closeMissedSl(tradeId: number): Promise<void> {
  if (!state.current) return
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh) return
  if (!ACTIVE_STATUSES.includes(fresh.status as any)) return

  const closesArr = ((fresh.closes as any[]) ?? []) as Array<{ percent?: number }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  if (remainingFrac < 1e-6) return

  const filtersMap = await getFilters(state.current.client).catch(() => null)
  const f = filtersMap?.get(fresh.symbol)
  if (!f) {
    console.warn(`${LOG} closeMissedSl #${fresh.id}: no filter for ${fresh.symbol}`)
    return
  }

  // Prefer the exchange's actual remaining size — TP1/TP2 step-rounding can
  // leave a different qty on the book than (positionUnits × remainingFrac).
  const snapPos = snapshot.current?.positions.find((p) => p.symbol === fresh.symbol)
  const exchangeRemaining = snapPos ? Math.abs(snapPos.positionAmt) : 0
  const plannedRemaining = fresh.positionUnits * remainingFrac
  const remainingQty = exchangeRemaining > 0 ? exchangeRemaining : plannedRemaining

  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    console.warn(`${LOG} closeMissedSl #${fresh.id} ${fresh.symbol}: qty ${qty} < minQty ${f.minQty} — finalizing as dust`)
    // Below minimum tradeable — still flip the DB to closed so reconcile
    // doesn't keep retrying. closeLowMarginPositions on the next exit-event
    // sweep will clean up the exchange-side residue.
    const { applyVirtualClose } = await import('./virtualSltp')
    await applyVirtualClose(fresh, 'SL', fresh.currentStop, remainingFrac, 0, 0, Date.now(), 0, true)
    return
  }

  // Cancel any orphan TPs first — without this, our MARKET reduceOnly races
  // a still-live algo TP and one of them gets -2022 ReduceOnly rejected.
  const { cancelAllTpsOnExchange } = await import('./exchangeTp')
  await cancelAllTpsOnExchange(fresh).catch(() => { /* best-effort */ })

  // Best-known mark price for the placeholder pnl/fee — WS refine overwrites it.
  const mark = lastMarkPriceWs.get(fresh.symbol) ?? snapPos?.markPrice ?? fresh.currentStop
  const isLong = fresh.side === 'BUY'
  const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
  const pnlR = initialRisk > 0
    ? ((isLong ? mark - fresh.entryPrice : fresh.entryPrice - mark) / initialRisk) * remainingFrac
    : 0
  const grossPnl = (isLong ? mark - fresh.entryPrice : fresh.entryPrice - mark) * qty
  const estFee = qty * mark * ((fresh.feeTakerPct ?? 0.04) / 100)

  const closeSide: 'BUY' | 'SELL' = fresh.side === 'BUY' ? 'SELL' : 'BUY'
  const exitCid = `exL${fresh.id}_SL`
  try {
    await state.current.client.placeOrder({
      symbol: fresh.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: true,
      newClientOrderId: exitCid,
    })
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2022) {
      // ReduceOnly rejected — position already 0 on the exchange. Let the
      // periodic reconcileClosedPositionsLiveC finalize from userTrades.
      console.warn(`${LOG} closeMissedSl #${fresh.id} ${fresh.symbol}: -2022 (no position) — reconcileClosed will finalize`)
      return
    }
    console.warn(`${LOG} closeMissedSl #${fresh.id} ${fresh.symbol} MARKET failed: ${e?.message ?? e}`)
    return
  }

  const { applyVirtualClose } = await import('./virtualSltp')
  await applyVirtualClose(fresh, 'SL', mark, remainingFrac, pnlR, grossPnl - estFee, Date.now(), estFee, true)
  console.log(`${LOG} 🛟 catch-up SL #${fresh.id} ${fresh.symbol} @ ~${mark} qty=${qty} (algo was missing on book + mark past trigger)`)
}

/**
 * Strict cancel: returns true only if the SL is actually gone from the book
 * (success OR -2011/-2013 "already gone"). Returns false on any other error
 * so the caller can avoid creating a duplicate placement.
 */
async function cancelSlOnExchangeStrict(trade: any): Promise<boolean> {
  if (!state.current) return false
  if (!trade.binanceSlOrderId) return true  // nothing to cancel
  try {
    await state.current.client.cancelAlgoOrder(trade.symbol, {
      algoId: Number(trade.binanceSlOrderId),
    })
    return true
  } catch (e: any) {
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) return true
    console.warn(`${LOG} cancel SL #${trade.id} ${trade.symbol} failed: ${e.message}`)
    return false
  }
}
