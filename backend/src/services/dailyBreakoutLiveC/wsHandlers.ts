/**
 * User-data WebSocket handlers — ORDER_TRADE_UPDATE / ACCOUNT_UPDATE routing.
 *
 * clientOrderId prefix convention:
 *   - 'enL{tradeId}'           → entry MARKET fill (tryFillVirtualLimit)
 *   - 'exL{tradeId}_{REASON}'  → exit MARKET fill (exitLiveTradeSlice)
 *   - 'slL{tradeId}'           → safety-net STOP_MARKET fired (exchange-driven SL)
 */

import { prisma } from '../../db/prisma'
import type { OrderTradeUpdateEvent, AccountUpdateEvent } from '../exchanges/binanceFuturesWs'
import { LOG, snapshot, lastMarkPriceWs, ACTIVE_STATUSES } from './state'
import { applyVirtualClose, notifyExitTelegram, recomputeTradeMoney } from './virtualSltp'

export async function handleUserDataEvent(ev: any): Promise<void> {
  switch (ev.e) {
    case 'ORDER_TRADE_UPDATE':
      await handleOrderUpdate(ev as OrderTradeUpdateEvent)
      break
    case 'ACCOUNT_UPDATE':
      await handleAccountUpdate(ev as AccountUpdateEvent)
      break
    case 'listenKeyExpired':
      console.warn(`${LOG} listenKey expired — WS layer will reconnect`)
      break
    default:
      // Unknown event — ignore (Binance occasionally adds new event types).
      break
  }
}

/**
 * Route an ORDER_TRADE_UPDATE event to the right handler.
 *
 * The synchronous /fapi/v1/order response for MARKET orders returns
 * avgPrice="0.00000" because the matching engine fill is indexed asynchronously.
 * We therefore record the row optimistically with the aggTrade tick price as
 * a placeholder, and overwrite with exact avgPrice + commission once
 * ORDER_TRADE_UPDATE X=FILLED arrives.
 */
async function handleOrderUpdate(ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  const cid = o.c

  // Safety-net SL — when the exchange STOP_MARKET fires before our virtual
  // tracker, the resulting MARKET fill arrives here with clientOrderId equal
  // to the clientAlgoId we set ('slL{tradeId}'). Look up the trade row by id.
  if (cid && cid.startsWith('slL')) {
    const tradeId = parseInt(cid.slice(3), 10)
    if (!Number.isFinite(tradeId)) return
    const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
    if (trade) {
      await handleSlOrderUpdate(trade, ev)
    }
    return
  }

  // Entry MARKET fill — refine entryPrice + fee on the row.
  if (cid && cid.startsWith('enL')) {
    const tradeId = parseInt(cid.slice(3), 10)
    if (!Number.isFinite(tradeId)) return
    await handleEntryFillUpdate(tradeId, ev)
    return
  }

  // Exit MARKET fill (TP1/TP2/TP3/SL via virtual tracker) — refine the matching
  // closes[] entry on the row with exact fill price + commission + realized PnL.
  if (cid && cid.startsWith('exL')) {
    // Parse 'exL{tradeId}_{REASON}'.
    const rest = cid.slice(3)
    const underscoreAt = rest.indexOf('_')
    if (underscoreAt < 1) return
    const tradeId = parseInt(rest.slice(0, underscoreAt), 10)
    const reason = rest.slice(underscoreAt + 1) as 'SL' | 'TP1' | 'TP2' | 'TP3'
    if (!Number.isFinite(tradeId) || !['SL', 'TP1', 'TP2', 'TP3'].includes(reason)) return
    await handleExitFillUpdate(tradeId, reason, ev)
    return
  }

  // Unknown cid — likely a manual order from another script. Ignore.
}

/**
 * Refine the trade row from the entry MARKET fill event. Binance delivers
 * exact avgPrice (`ap`) and commission (`n`) here. Updates entryPrice,
 * positionUnits, positionSizeUsd, marginUsd, feesPaidUsd to reality. SL/TP
 * geometry stays anchored on rangeEdge — they don't shift with fill price.
 *
 * Idempotent: filters by X==='FILLED' and runs the update inside a status
 * guard so duplicate WS events (reconnect replays) don't double-charge fees.
 */
async function handleEntryFillUpdate(tradeId: number, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return  // PARTIALLY_FILLED ignored — wait for final FILLED

  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return
  // Don't gate on trade.status — Binance can deliver ORDER_TRADE_UPDATE
  // milliseconds after our synchronous placeOrder returns, sometimes before
  // tryFillVirtualLimit finishes flipping the row to OPEN. If we bailed on
  // 'PENDING_LIMIT' / 'FILLING' here the entryPrice would stay frozen at the
  // aggTrade placeholder and never get refined to the actual MARKET avgPrice
  // (we saw up to ~1% slippage on hot symbols, e.g. POL 0.0902 → 0.0912).
  // Idempotency: binanceOrderId is null after the optimistic write and set
  // here. If it's already populated, this event is a replay.
  if (trade.binanceOrderId != null) return

  const exactPrice = Number(o.ap) || Number(o.L) || trade.entryPrice
  const exactQty = Number(o.z) || trade.positionUnits
  const exactFee = Number(o.n) || 0  // commission in USDT (N field gives asset)
  const exchangeOrderId = BigInt(o.i)

  // Cache the exact entry fee on the row itself (entryFeeUsd) so the absolute
  // recompute helper below can rebuild feesPaidUsd / netPnlUsd from row +
  // closes[] without depending on any prior increment. This makes the path
  // idempotent — the same WS event replayed (reconnect) won't double-charge,
  // and a tryFillVirtualLimit placeholder running before/after this handler
  // doesn't matter.
  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      entryPrice: exactPrice,
      positionUnits: exactQty,
      positionSizeUsd: exactPrice * exactQty,
      marginUsd: trade.leverage ? (exactPrice * exactQty) / trade.leverage : trade.marginUsd,
      entryFeeUsd: exactFee,
      binanceOrderId: exchangeOrderId,
    },
  })
  await recomputeTradeMoney(tradeId)

  console.log(`${LOG} ↻ entry refined #${tradeId} ${trade.symbol} entry ${trade.entryPrice} → ${exactPrice}, entryFee SET to ${exactFee.toFixed(4)}`)
}

/**
 * Refine the matching closes[] entry from the exit MARKET fill event. We
 * overwrite the placeholder (triggerPrice, estimated taker fee) with exact
 * avgPrice + commission + realized PnL from Binance.
 *
 * The 'rp' field on ORDER_TRADE_UPDATE.o carries realizedProfit for this fill.
 * That's the authoritative figure — entry slippage and exit slippage both
 * fold into it, no need to recompute.
 */
async function handleExitFillUpdate(
  tradeId: number,
  reason: 'SL' | 'TP1' | 'TP2' | 'TP3',
  ev: OrderTradeUpdateEvent,
): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return

  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return

  const exactFillPrice = Number(o.ap) || Number(o.L) || 0
  const exactFee = Number(o.n) || 0
  const exactRealizedPnl = Number(o.rp) || 0  // realizedProfit
  const exchangeOrderId = String(o.i)

  if (exactFillPrice <= 0) return  // can't refine without a price

  // Locate the matching closes[] entry — last one with this reason. Each
  // (tradeId, reason) pair only fires once, so there should be exactly one.
  const closes = ((trade.closes as any[]) ?? []).slice()
  const idx = closes.map((c, i) => ({ c, i })).reverse().find((x) => x.c?.reason === reason)?.i
  if (idx === undefined) return

  const prev = closes[idx]
  // Idempotency: each Binance orderId fires this once. If we already refined
  // from this exact event, skip (Binance may replay on reconnect).
  if ((prev as any).binanceOrderId === exchangeOrderId) return

  // Overwrite the closes[] entry with Binance's authoritative numbers, then
  // let recomputeTradeMoney rebuild realizedPnlUsd / feesPaidUsd / netPnlUsd
  // absolutely from the row + closes[]. No more delta arithmetic — if the
  // event replays or the placeholder differed in qty/price the totals still
  // converge to truth.
  closes[idx] = {
    ...prev,
    price: exactFillPrice,
    pnlUsd: exactRealizedPnl,
    feePaidUsd: exactFee,
    binanceOrderId: exchangeOrderId,
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      closes: closes as any,
    },
  })
  await recomputeTradeMoney(tradeId)

  console.log(`${LOG} ↻ exit refined #${tradeId} ${trade.symbol} ${reason} @ ${exactFillPrice} realizedPnl=${exactRealizedPnl.toFixed(4)} fee=${exactFee.toFixed(4)}`)

  // Telegram is sent here (not in applyVirtualClose) so the user sees the
  // authoritative P&L from Binance instead of the virtual triggerPrice
  // estimate. notifyExitTelegram reads the freshly-updated row, so realized
  // PnL, fees and any accrued funding are folded in correctly.
  const slicePercent = (prev as any)?.percent ?? 100
  const sliceFrac = slicePercent / 100
  await notifyExitTelegram(tradeId, reason, exactFillPrice, sliceFrac, exactRealizedPnl, false)
}

/**
 * Cancel the paired entry virtual limit (DB-only — no exchange call). When one
 * side fills, the other side is no longer needed. Atomic — only flips state
 * if still PENDING_LIMIT (skip if already filled or cancelled).
 */
export async function cancelPairOrder(pairTradeId: number): Promise<void> {
  const r = await prisma.breakoutLiveTradeC.updateMany({
    where: { id: pairTradeId, limitOrderState: 'PENDING_LIMIT' },
    data: {
      limitOrderState: 'CANCELLED_OTHER_SIDE',
      status: 'CANCELLED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    const pair = await prisma.breakoutLiveTradeC.findUnique({ where: { id: pairTradeId } })
    console.log(`${LOG} cancelled pair #${pairTradeId} ${pair?.symbol ?? '?'} ${pair?.side ?? '?'}`)
  }
}

/**
 * Handle the case where the exchange SL fires before our virtual tracker
 * gets a chance to act. The MARKET fill arrives as a regular order update
 * with clientOrderId='slL{tradeId}' (Binance preserves clientAlgoId as the
 * resulting fill's clientOrderId per Algo Order docs).
 */
async function handleSlOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return  // we only care about the fill event
  // Position may already be CLOSED if our virtual tracker beat the exchange.
  // Idempotent — applyVirtualClose checks status.
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
  if (!fresh) return
  if (!ACTIVE_STATUSES.includes(fresh.status as any)) return
  const closesArr = ((fresh.closes as any[]) ?? []) as Array<{ reason?: string; percent?: number }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  if (remainingFrac < 1e-6) return

  const fillPrice = Number(o.ap) || Number(o.L) || fresh.currentStop
  const isLong = fresh.side === 'BUY'
  const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
  const pnlR = ((isLong ? fillPrice - fresh.entryPrice : fresh.entryPrice - fillPrice) / initialRisk) * remainingFrac
  const grossPnl = (isLong ? fillPrice - fresh.entryPrice : fresh.entryPrice - fillPrice) * fresh.positionUnits * remainingFrac
  const feePaid = Number(o.n) || 0
  await applyVirtualClose(fresh, 'SL', fillPrice, remainingFrac, pnlR, grossPnl - feePaid, ev.T || ev.E, feePaid)
  console.log(`${LOG} 🛑 exchange SL triggered #${fresh.id} ${fresh.symbol} @ ${fillPrice}`)
}

async function handleAccountUpdate(ev: AccountUpdateEvent): Promise<void> {
  // FUNDING_FEE → log to BreakoutLiveFundingC. Binance posts funding every
  // 8h (00:00, 08:00, 16:00 UTC) for every open perp position; the event's
  // 'a.B' deltas contain the actual USDT amount charged/credited.
  if (ev.a?.m === 'FUNDING_FEE') {
    await logFundingFromEvent(ev)
    // funding still updates balance — fall through to snapshot update
  }

  // Update the live snapshot from ACCOUNT_UPDATE deltas. ev.a.B carries asset
  // balances (we care about USDT), ev.a.P carries position deltas (one entry
  // per symbol that changed in this event — not the full position set, so we
  // merge with the existing snapshot rather than replacing).
  if (!snapshot.current) return  // snapshot not yet seeded; first seedSnapshotFromRest will pick this up

  const usdt = ev.a?.B?.find((b) => b.a === 'USDT')
  if (usdt) {
    // wb = wallet balance (post-event); cw = cross wallet balance
    snapshot.current.total = Number(usdt.wb)
    // Binance doesn't broadcast availableBalance per WS — derive: total minus
    // isolated-margin locked in positions. Close enough for the UI; the next
    // REST refresh (≤5 min) will resync if drift accumulates.
    let isolatedLocked = 0
    for (const p of snapshot.current.positions) {
      if (p.marginType === 'isolated' && p.positionAmt !== 0) {
        isolatedLocked += Math.abs(p.positionAmt * p.entryPrice) / Math.max(p.leverage, 1)
      }
    }
    snapshot.current.available = Math.max(0, snapshot.current.total - isolatedLocked)
  }

  const positionDeltas = ev.a?.P ?? []
  for (const d of positionDeltas) {
    const amt = Number(d.pa)
    const idx = snapshot.current.positions.findIndex((p) => p.symbol === d.s)
    if (amt === 0) {
      // position closed
      if (idx >= 0) snapshot.current.positions.splice(idx, 1)
      continue
    }
    const updated = {
      symbol: d.s,
      positionAmt: amt,
      entryPrice: Number(d.ep),
      markPrice: lastMarkPriceWs.get(d.s) ?? Number(d.ep),
      unRealizedProfit: Number(d.up),
      leverage: idx >= 0 ? snapshot.current.positions[idx].leverage : 1,  // not in event; keep last
      marginType: (d.mt === 'isolated' ? 'isolated' : 'cross') as 'isolated' | 'cross',
    }
    if (idx >= 0) snapshot.current.positions[idx] = updated
    else snapshot.current.positions.push(updated)
  }

  snapshot.current.updatedAt = Date.now()
  snapshot.current.source = 'ws-account-update'

  // NOTE: currentDepositUsd in DB is NOT updated from this WS event. The
  // available value we derived above is an approximation (wb - entry-price-based
  // margin lock) that drifts from Binance's mark-price-based availableBalance.
  // Writing it to DB poisoned the UI 'Депозит' figure. Instead, the periodic
  // REST refresh (every 30s via SNAPSHOT_STALE_MS) syncs currentDepositUsd with
  // the exact value from /fapi/v2/account. The WS event still keeps the
  // in-memory snapshot fresh for /status latency.
}

/**
 * Persist funding fee events to BreakoutLiveFundingC. The event delivers a
 * batch of position-level deltas (a.P) — one per symbol that paid/received
 * funding in this 8h interval. We log one row per (symbol, occurredAt) pair
 * and try to associate with the currently OPEN trade for that symbol so the
 * trade-level fundingPaidUsd accumulates correctly.
 */
async function logFundingFromEvent(ev: AccountUpdateEvent): Promise<void> {
  const occurredAt = new Date(ev.T || ev.E)
  // We can't know the per-symbol funding amount from a.P directly (it carries
  // updated position state, not deltas). Instead we use the balance deltas in
  // a.B — for FUNDING_FEE reason the USDT balance change equals the funding
  // total across all positions. But to keep per-symbol attribution we use
  // a separate userTrades-like approach: the ACCOUNT_UPDATE doesn't itemize,
  // so we record one aggregated row with symbol='*' and a per-symbol best-
  // effort split if there's only one OPEN position. Anything else gets logged
  // for inspection but not attributed.
  const usdtDelta = ev.a?.B?.find((b) => b.a === 'USDT')
  const amount = usdtDelta ? Number(usdtDelta.bc) : 0  // 'bc' = balance change for this event
  if (!amount || !isFinite(amount)) return

  const openTrades = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true, symbol: true },
  })

  if (openTrades.length === 1) {
    // Single-position case — attribute fully.
    const t = openTrades[0]
    await prisma.breakoutLiveFundingC.create({
      data: {
        symbol: t.symbol,
        tradeId: t.id,
        amountUsd: amount,
        occurredAt,
      },
    })
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        fundingPaidUsd: { increment: -amount },  // funding paid (negative) increases cost basis
        netPnlUsd: { increment: amount },        // netPnl includes funding
      },
    })
  } else if (openTrades.length > 1) {
    // Multi-position case — log unattributed, attribute pro-rata by notional
    // in a later reconciliation pass (TODO). For now, totalFundingUsd on the
    // config accumulates the aggregate so depo math stays consistent.
    await prisma.breakoutLiveFundingC.create({
      data: {
        symbol: openTrades.map((t) => t.symbol).join(','),
        tradeId: null,
        amountUsd: amount,
        occurredAt,
      },
    })
  }
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: { totalFundingUsd: { increment: amount } },
  })
  console.log(`${LOG} funding ${amount > 0 ? '+' : ''}${amount.toFixed(6)} USDT at ${occurredAt.toISOString()}`)
}
