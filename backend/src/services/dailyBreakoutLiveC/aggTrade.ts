/**
 * Market data WS — aggTrade safety net + virtual-limit fills.
 *
 * Each aggTrade tick on a tracked symbol with open positions runs trackLiveTrade()
 * to check if any TP/SL level has been crossed and sends MARKET reduceOnly when
 * so. (Entry fills still come from ORDER_TRADE_UPDATE on the user-data stream.)
 *
 * Virtual-limit fills also live here — when price crosses the stored
 * limitOrderPrice, we send MARKET reduceOnly=false to open the position.
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { computeSizing } from '../marginGuard'
import {
  LOG, state, snapshot, lastMarkPriceWs,
  lastAggTradeAt, lastTickProcessedAt, TICK_THROTTLE_MS, fillBusy, ACTIVE_STATUSES,
} from './state'
import { fmtPrice } from './formatters'
import { getFilters } from './filters'
import { sendLiveTelegram } from './telegram'
import { trackLiveTrade } from './virtualSltp'
import { recordAttempt } from './attempts'
import { cancelPairOrder } from './wsHandlers'
import { attachSlAfterEntry } from './exchangeSl'
import { attachTpsAfterEntry } from './exchangeTp'
import { seedSnapshotFromRest } from './snapshot'

export function handleAggTrade(sym: string, price: number, ts: number): void {
  lastAggTradeAt.set(sym, ts)
  lastMarkPriceWs.set(sym, price)

  // Keep the snapshot's per-position markPrice in sync (no DB write — just
  // in-memory). Lets /status return current mark without a REST hit.
  if (snapshot.current) {
    const pos = snapshot.current.positions.find((p) => p.symbol === sym)
    if (pos) {
      pos.markPrice = price
      // Recompute unrealized for this position from the new mark.
      // Sign convention: long with markPrice > entry = positive.
      pos.unRealizedProfit = (price - pos.entryPrice) * pos.positionAmt
    }
  }

  const now = Date.now()
  const last = lastTickProcessedAt.get(sym) ?? 0
  if (now - last < TICK_THROTTLE_MS) return
  lastTickProcessedAt.set(sym, now)

  // Fire-and-forget tracker. trackLiveTrade has its own per-trade busy lock
  // so concurrent ticks on the same symbol can't race.
  void processAggTradeForSymbol(sym, price, ts)
}

async function processAggTradeForSymbol(sym: string, price: number, ts: number): Promise<void> {
  try {
    // 1. Virtual limit fill — check PENDING_LIMIT rows; if price crossed the
    //    limit level, send MARKET to open the position.
    const pending = await prisma.breakoutLiveTradeC.findMany({
      where: { symbol: sym, limitOrderState: 'PENDING_LIMIT' },
    })
    for (const t of pending) {
      await tryFillVirtualLimit(t, price, ts)
    }

    // 2. Virtual SL/TP — check OPEN/TP1_HIT/TP2_HIT rows; if price crossed any
    //    exit level, send MARKET reduceOnly.
    const openTrades = await prisma.breakoutLiveTradeC.findMany({
      where: {
        symbol: sym,
        status: { in: [...ACTIVE_STATUSES] },
      },
    })
    for (const t of openTrades) {
      await trackLiveTrade(t, price, ts)
    }
  } catch (e: any) {
    console.warn(`${LOG} aggTrade tracker ${sym} threw: ${e.message}`)
  }
}

/**
 * Try to fill a virtual PENDING_LIMIT row. Called from aggTrade WS handler.
 * For BUY: price must reach or exceed limitOrderPrice (= rangeHigh).
 * For SELL: price must drop to or below limitOrderPrice (= rangeLow).
 *
 * On cross:
 *   1. Atomic claim PENDING_LIMIT → FILLING via updateMany count check.
 *   2. Send MARKET reduceOnly=false for the stored qty.
 *   3. Move row to OPEN with the actual fill price from the MARKET response.
 *   4. Cancel the paired side (DB-only, mark CANCELLED_OTHER_SIDE).
 *   5. Place exchange-side STOP_MARKET safety-net (handled by attachSlAfterEntry).
 *
 * If MARKET placement fails (e.g. -2019 insufficient margin, -2027 max position),
 * we record the rejection and release the claim so a later tick can retry —
 * but if it's a structural rejection (sizing mismatch with current balance) the
 * retry will likely fail too. Mirrors paper C's fillLimitInner flow.
 */
async function tryFillVirtualLimit(trade: any, price: number, ts: number): Promise<void> {
  if (fillBusy.has(trade.id)) return
  if (!state.current) return

  const isLong = trade.side === 'BUY'
  const crossed = isLong ? price >= trade.limitOrderPrice : price <= trade.limitOrderPrice
  if (!crossed) return

  fillBusy.add(trade.id)
  try {
    // Atomic claim — prevent double-fill if two ticks fire concurrently.
    const claim = await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'PENDING_LIMIT' },
      data: { limitOrderState: 'FILLING' },
    })
    if (claim.count !== 1) return  // someone else got here first

    const filters = await getFilters(state.current.client)
    const f = filters.get(trade.symbol)
    if (!f) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} — no symbol filter; rolling back to PENDING`)
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
      return
    }

    // Re-size at fill time using current deposit (paper C does this too — sizing
    // computed at placement may be stale if other C trades opened/closed since).
    // Use the limit level as the reference entry for risk calc — actual market
    // fill may be 0-2 ticks away.
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) {
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
      return
    }
    const sizing = computeSizing({
      symbol: trade.symbol,
      deposit: cfg.currentDepositUsd,
      riskPct: cfg.riskPctPerTrade,
      targetMarginPct: cfg.targetMarginPct,
      entry: trade.limitOrderPrice,
      sl: trade.stopLoss,
    })
    if (!sizing || sizing.positionUnits <= 0) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} sizing failed at fill — cancelling`)
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(ts),
        },
      })
      return
    }

    // Round qty DOWN to step (Binance rejects qty above step granularity).
    const step = f.stepSize
    let qtyPlanned = Math.floor(sizing.positionUnits / step) * step
    qtyPlanned = Number(qtyPlanned.toFixed(f.quantityPrecision))
    if (qtyPlanned < f.minQty) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} qty below minQty — cancelling`)
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(ts),
        },
      })
      return
    }

    const newLev = Math.max(1, Math.round(sizing.leverage))
    try {
      await state.current.client.setLeverage(trade.symbol, newLev)
    } catch (e: any) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} setLeverage(${newLev}) failed: ${e.message}`)
    }

    // Approximate fill — aggTrade tick price as the best initial guess. The
    // real avgPrice + commission arrives via ORDER_TRADE_UPDATE WS event for
    // this MARKET order, which handleEntryFillUpdate routes back into the row.
    // Binance's synchronous placeOrder response for MARKET returns avgPrice="0"
    // (the matching-engine fill hasn't been indexed yet), so we can't trust it.
    let fillPrice = price
    let fillQty = qtyPlanned
    const entryCid = `enL${trade.id}`
    try {
      const resp = await state.current.client.placeOrder({
        symbol: trade.symbol,
        side: trade.side,
        type: 'MARKET',
        quantity: qtyPlanned,
        newClientOrderId: entryCid,
        // No reduceOnly — this is the entry, opening a new position.
      })
      // executedQty IS available immediately if MARKET filled — use it.
      if (resp.executedQty && Number(resp.executedQty) > 0) {
        fillQty = Number(resp.executedQty)
      }
      // Fee not estimated here — handleEntryFillUpdate writes the exact
      // commission from Binance's o.n into entryFeeUsd. Leaving feesPaidUsd=0
      // briefly until WS arrives is a tiny UI artifact vs the bigger problem
      // of mis-attributed fees the placeholder used to cause.
    } catch (e: any) {
      // Placement rejected — release the FILLING claim so the next tick can
      // retry, and surface the rejection to the audit log.
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} MARKET rejected: ${e.message}`)
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
      const code = e instanceof BinanceApiError ? String(e.code) : 'unknown'
      await recordAttempt({
        symbol: trade.symbol, side: trade.side, rangeDate: new Date(ts).toISOString().slice(0, 10),
        status: 'REJECTED_EXCHANGE',
        reasonCode: code, reasonText: e.message,
        limitPrice: trade.limitOrderPrice, markPrice: price,
      })
      return
    }

    const fillTime = new Date(ts)
    // Race protection: handleEntryFillUpdate can fire (via WS ORDER_TRADE_UPDATE)
    // before this row update completes — it sets binanceOrderId + exact entryPrice
    // from o.ap. Don't overwrite those exact fields with our aggTrade placeholder.
    // The updateMany only touches the trade row while binanceOrderId is still
    // null (WS hasn't refined yet); if WS already won, this is a no-op and the
    // exact avgPrice / qty / fee stay intact.
    //
    // No fees fields here — entry fee is owned by handleEntryFillUpdate
    // (writes entryFeeUsd from o.n, then recomputeTradeMoney rebuilds total).
    // The old `{ increment: feePaid }` placeholder caused race-dependent
    // double-charging / undercharging depending on WS event ordering.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, binanceOrderId: null },
      data: {
        entryPrice: fillPrice,
        positionUnits: fillQty,
        positionSizeUsd: fillPrice * fillQty,
        marginUsd: (fillPrice * fillQty) / newLev,
      },
    })

    // These fields are owned by the trader, not the WS refine — always set them.
    await prisma.breakoutLiveTradeC.update({
      where: { id: trade.id },
      data: {
        status: 'OPEN',
        limitOrderState: 'FILLED',
        limitFilledAt: fillTime,
        openedAt: fillTime,
        depositAtEntryUsd: cfg.currentDepositUsd,
        riskUsd: sizing.riskUsd,
        leverage: newLev,
      },
    })

    console.log(`${LOG} ✓ virtual limit filled #${trade.id} ${trade.symbol} ${trade.side} @ ${fillPrice} (limit ${trade.limitOrderPrice}) qty ${fillQty}`)

    const sideText = trade.side === 'BUY' ? 'LONG' : 'SHORT'
    const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴'
    sendLiveTelegram([
      `${sideEmoji} <b>${trade.symbol}</b> <b>${sideText}</b>  · entry filled`,
      `━━━━━━━━━━━━━━━━━━`,
      `💰 Цена   <code>${fmtPrice(fillPrice)}</code>  · лимит <code>${fmtPrice(trade.limitOrderPrice)}</code>`,
      `📐 Размер <code>$${(fillPrice * fillQty).toFixed(2)}</code>  · ${fillQty} ед.`,
      `⚡ Плечо  <code>${newLev}x</code>`,
      `🛑 SL    <code>${fmtPrice(trade.stopLoss)}</code>`,
    ].join('\n'))

    // Cancel pair (DB-only).
    if (trade.pairOrderId) {
      await cancelPairOrder(trade.pairOrderId).catch(() => { /* noop */ })
    }

    // Subscribe aggTrade for this symbol (likely already subscribed via the
    // PENDING phase but idempotent) and attach safety-net SL on the exchange.
    await refreshAggTradeSubscriptions().catch(() => { /* noop */ })
    await attachSlAfterEntry(trade.id).catch((e) =>
      console.warn(`${LOG} attachSlAfterEntry threw: ${e?.message ?? e}`))
    await attachTpsAfterEntry(trade.id).catch((e) =>
      console.warn(`${LOG} attachTpsAfterEntry threw: ${e?.message ?? e}`))

    // Refresh balance — fee was just charged, margin was just locked, next
    // sizing cycle needs accurate currentDepositUsd.
    if (state.current) {
      await seedSnapshotFromRest(state.current.client, state.current.net, 'rest-refresh').catch((e) =>
        console.warn(`${LOG} post-fill balance refresh failed: ${e?.message ?? e}`))
    }
  } catch (e: any) {
    console.error(`${LOG} tryFillVirtualLimit threw for #${trade.id}: ${e.message}`)
    // Best-effort rollback so a stuck FILLING doesn't lock the trade forever.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'FILLING' },
      data: { limitOrderState: 'PENDING_LIMIT' },
    }).catch(() => { /* noop */ })
  } finally {
    fillBusy.delete(trade.id)
  }
}

export function getLastAggTradeAt(symbol: string): number | undefined {
  return lastAggTradeAt.get(symbol)
}

/**
 * Diff aggTrade subscriptions to match the symbols with live activity.
 * Symbols with PENDING_LIMIT or OPEN/TP1_HIT/TP2_HIT rows get subscribed;
 * everything else gets unsubscribed. Idempotent — the WS layer's
 * setSubscriptions() handles the actual SUBSCRIBE/UNSUBSCRIBE diffing.
 */
export async function refreshAggTradeSubscriptions(): Promise<void> {
  if (!state.current) return
  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { limitOrderState: 'PENDING_LIMIT' },
        { status: { in: [...ACTIVE_STATUSES] } },
      ],
    },
    select: { symbol: true },
  })
  const symbols = Array.from(new Set(rows.map((r) => r.symbol)))
  state.current.marketDataWs.setSubscriptions(symbols)
}
