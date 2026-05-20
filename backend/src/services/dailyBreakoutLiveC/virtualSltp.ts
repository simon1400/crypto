/**
 * Virtual SL/TP tracking — mirrors paper C, exits via MARKET reduceOnly.
 *
 * Why virtual instead of real algo orders on the exchange:
 * - paper C logic is battle-tested over 2+ weeks of live trading
 * - real algo orders need /fapi/v1/algoOrder migration, separate cID space,
 *   and immediate-trigger handling when price already past stop
 * - one ws layer (aggTrade) drives all exits; one exit path (MARKET reduceOnly)
 *
 * Each aggTrade tick on a tracked symbol → check if it crosses any
 * remaining SL/TP level → if so, send MARKET reduceOnly for the appropriate
 * slice and update DB row (currentStop trails, status moves through TP1_HIT
 * → TP2_HIT → TP3_HIT or CLOSED/SL_HIT).
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import {
  LOG, state, snapshot, tradeBusy, SPLITS, ACTIVE_STATUSES,
} from './state'
import { fmtPrice, fmtPnl } from './formatters'
import { getFilters } from './filters'
import { sendLiveTelegram } from './telegram'
import { cancelSlOnExchange, retrailSlOnExchange } from './exchangeSl'
import { cancelTpOnExchange, cancelAllTpsOnExchange } from './exchangeTp'
import { seedSnapshotFromRest } from './snapshot'

/**
 * Rebuild realizedPnlUsd / feesPaidUsd / netPnlUsd as absolute values from the
 * trade row's authoritative inputs:
 *   realizedPnlUsd = Σ closes[].pnlUsd  (each entry written by applyVirtualClose
 *                                        or refined to o.rp by handleExitFillUpdate)
 *   feesPaidUsd    = entryFeeUsd + Σ closes[].feePaidUsd
 *   netPnlUsd      = realizedPnlUsd - feesPaidUsd - fundingPaidUsd
 *
 * Called after every entry/exit fill update so the money fields converge to
 * the truth regardless of which path ran first. The legacy `{ increment: x }`
 * style was race-sensitive — two paths writing optimistic deltas in different
 * orders produced different totals.
 */
export async function recomputeTradeMoney(tradeId: number): Promise<void> {
  const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!t) return
  const closes = (t.closes as any[]) ?? []
  const realizedPnl = closes.reduce((a, c) => a + (Number(c?.pnlUsd) || 0), 0)
  const closesFees = closes.reduce((a, c) => a + (Number(c?.feePaidUsd) || 0), 0)
  const fees = (t.entryFeeUsd ?? 0) + closesFees
  const netPnl = realizedPnl - fees - (t.fundingPaidUsd ?? 0)
  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      realizedPnlUsd: realizedPnl,
      feesPaidUsd: fees,
      netPnlUsd: netPnl,
    },
  })
}

/**
 * Recompute aggregate stats persisted on BreakoutLiveConfigC after a close.
 * Mirrors the paper-trader logic (totalTrades/Wins/Losses/PnL) but pulls
 * peakDepositUsd / maxDrawdownPct from the live walletBalance snapshot — for
 * LIVE C the canonical depo is the exchange wallet, not currentDepositUsd
 * (which mirrors availableBalance and excludes locked margin).
 */
export async function recomputeLiveCStats(): Promise<void> {
  const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
  if (!cfg) return

  const trades = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true, fundingPaidUsd: true },
  })
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
  const closedOnly = trades.filter((t) => closedStatuses.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter((t) => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter((t) => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a, t) => {
    const realizedNet = closedStatuses.has(t.status)
      ? t.netPnlUsd
      : (t.realizedPnlUsd - t.feesPaidUsd - t.fundingPaidUsd)
    return a + realizedNet
  }, 0)

  // Peak/DD anchored on real walletBalance — equity from the exchange, not
  // the synthetic startingDepositUsd + totalPnLUsd reconstruction (which can
  // drift on funding / external wallet movements).
  const wallet = snapshot.current?.total ?? cfg.currentDepositUsd
  const newPeak = Math.max(cfg.peakDepositUsd ?? cfg.startingDepositUsd, wallet)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - wallet) / newPeak) * 100) : 0

  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: {
      totalTrades, totalWins, totalLosses, totalPnLUsd,
      peakDepositUsd: newPeak, maxDrawdownPct: newDD,
    },
  })
}

/**
 * Send the close notification to Telegram. Reads the fresh trade row so the
 * displayed P&L reflects realized PnL minus fees minus funding accrued during
 * the position — same number the UI/exchange show. For partial closes (TP1/
 * TP2) we report the slice P&L; for terminal closes (SL/TP3) we report the
 * total trade P&L.
 *
 * @param virtual  true when sent from -2022 fallback path — adds a hint that
 *                 the number is a virtual estimate (no WS refine arrived).
 */
export async function notifyExitTelegram(
  tradeId: number,
  reason: 'SL' | 'TP1' | 'TP2' | 'TP3',
  fillPrice: number,
  frac: number,
  virtualPnlFallback: number,
  virtual: boolean,
): Promise<void> {
  const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!t) return

  const terminal = reason === 'SL' || reason === 'TP3'
  // Always report two numbers so the user sees exactly what the app shows
  // and what Binance shows:
  //   - slicePnl  = gross realizedProfit of this fill from Binance (matches
  //                 Binance's "Realized Profit" column in Trade History)
  //   - tradeNet  = realizedPnl − feesPaidUsd − fundingPaidUsd (matches the
  //                 app's "Реализовано" / "Net P&L" — includes entry fee)
  // Terminal closes get the same two figures; trade net equals the slice's
  // net plus all prior partial-close P&Ls minus all accumulated fees.
  const closes = (t.closes as any[]) ?? []
  const slice = [...closes].reverse().find((c) => c?.reason === reason)
  const sliceGross = Number(slice?.pnlUsd ?? virtualPnlFallback)
  const sliceFee = Number(slice?.feePaidUsd ?? 0)
  const tradeNet = (t.realizedPnlUsd ?? 0) - (t.feesPaidUsd ?? 0) - (t.fundingPaidUsd ?? 0)

  const emoji = reason === 'SL' ? '🔴' : '✅'
  const trailNote = reason === 'TP1' ? 'SL → BE'
    : reason === 'TP2' ? 'SL → TP1'
    : reason === 'TP3' ? 'позиция закрыта полностью'
    : 'позиция закрыта'
  const headerSuffix = terminal ? 'позиция закрыта' : 'частичное закрытие'
  const pnlSuffix = virtual ? ' <i>(≈ виртуально)</i>' : ''

  // For partial closes show both: this fill's realized + cumulative net.
  // For terminal closes the two collapse — show only the trade net so the
  // message isn't redundant.
  const pnlLines = terminal
    ? [`💵 P&L    <b>${fmtPnl(tradeNet)}</b>${pnlSuffix}  <i>(сделка целиком)</i>`]
    : [
        `💵 Slice  <b>${fmtPnl(sliceGross - sliceFee)}</b>${pnlSuffix}  <i>(gross ${fmtPnl(sliceGross)} − fee $${sliceFee.toFixed(2)})</i>`,
        `Σ сделка  <b>${fmtPnl(tradeNet)}</b>  <i>(вкл. entry fee)</i>`,
      ]

  sendLiveTelegram([
    `${emoji} <b>${t.symbol}</b> <b>${reason}</b>  · ${headerSuffix}`,
    `━━━━━━━━━━━━━━━━━━`,
    `💰 Цена   <code>${fmtPrice(fillPrice)}</code>`,
    `📊 Закрыто  ${Math.round(frac * 100)}%`,
    ...pnlLines,
    `🛡 ${trailNote}`,
  ].join('\n'))
}

export async function trackLiveTrade(trade: any, price: number, ts: number): Promise<void> {
  if (tradeBusy.has(trade.id)) return  // already processing a tick for this trade
  if (!state.current) return
  if (!ACTIVE_STATUSES.includes(trade.status as any)) return

  const isLong = trade.side === 'BUY'
  const currentStop = trade.currentStop
  const tpLadder = (trade.tpLadder as number[]) ?? []
  const closesArr = ((trade.closes as any[]) ?? []) as Array<{ reason?: string; percent?: number }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  if (remainingFrac < 1e-6) return

  // SL hit? (price crossed currentStop in the wrong direction)
  const slHit = isLong ? price <= currentStop : price >= currentStop
  if (slHit) {
    tradeBusy.add(trade.id)
    try {
      await exitLiveTradeSlice(trade, remainingFrac, 'SL', currentStop, price, ts)
    } finally {
      tradeBusy.delete(trade.id)
    }
    return
  }

  // TP hits? Determine next TP index from prior closes (count of TP* reasons).
  const tpsHit = closesArr.filter((c) => c.reason === 'TP1' || c.reason === 'TP2' || c.reason === 'TP3').length
  if (tpsHit >= 3) return  // all TPs done

  const nextTpIdx = tpsHit  // 0=TP1, 1=TP2, 2=TP3
  const tpPrice = tpLadder[nextTpIdx]
  if (tpPrice === undefined) return
  const tpHit = isLong ? price >= tpPrice : price <= tpPrice
  if (!tpHit) return

  tradeBusy.add(trade.id)
  try {
    const splitFrac = Math.min(SPLITS[nextTpIdx] ?? remainingFrac, remainingFrac)
    const tpLabel = (`TP${nextTpIdx + 1}`) as 'TP1' | 'TP2' | 'TP3'
    await exitLiveTradeSlice(trade, splitFrac, tpLabel, tpPrice, price, ts)
  } finally {
    tradeBusy.delete(trade.id)
  }
}

/**
 * Send a MARKET reduceOnly for `frac` of the position and persist the close.
 * On TP1/TP2 hit also trails currentStop: TP1 → SL to entry (BE); TP2 → SL
 * to TP1 level. On TP3 hit or SL hit → trade is finalized.
 *
 * triggerPrice = the level we wanted to exit at (TP price or current stop).
 *                Used for the closes[].price record.
 * fillPrice    = the aggTrade tick that triggered us. We don't use it as the
 *                exit price (Binance fills the MARKET wherever it fills);
 *                actual fill price arrives via ORDER_TRADE_UPDATE for the
 *                MARKET but we already record `triggerPrice` as our reference.
 */
async function exitLiveTradeSlice(
  trade: any,
  frac: number,
  reason: 'SL' | 'TP1' | 'TP2' | 'TP3',
  triggerPrice: number,
  _fillPrice: number,
  ts: number,
): Promise<void> {
  if (!state.current) return
  // Idempotency: check the row hasn't already been advanced past this reason
  // (e.g. by a slower duplicate tick that beat us to the lock).
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
  if (!fresh) return
  if (!ACTIVE_STATUSES.includes(fresh.status as any)) return
  const freshCloses = ((fresh.closes as any[]) ?? []) as Array<{ reason?: string }>
  if (freshCloses.some((c) => c.reason === reason)) return

  const filters = await getFilters(state.current.client)
  const f = filters.get(trade.symbol)
  if (!f) return

  const step = f.stepSize
  // For terminal closes (SL / TP3) the slice should empty the position fully.
  // floor(positionUnits × frac / step) × step truncates downward each TP, so by
  // the time SL or TP3 fires the planned closeUnits is already smaller than
  // the actual exchange remainder by 1-2 lot sizes. End result: dust like
  // 0.001 ETH stuck on the exchange after status='CLOSED' in the DB. Pull the
  // real remaining positionAmt from the live snapshot for terminal exits.
  const isTerminal = reason === 'SL' || reason === 'TP3'
  let closeUnits = fresh.positionUnits * frac
  if (isTerminal) {
    const snap = snapshot.current?.positions.find((p) => p.symbol === fresh.symbol)
    if (snap && snap.positionAmt !== 0) {
      closeUnits = Math.abs(snap.positionAmt)
    }
  }
  let qty = Math.floor(closeUnits / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    // Too small to send as a real order — record the close at the virtual
    // level and move on (e.g. TP3 remainder after step rounding).
    const isLong = trade.side === 'BUY'
    const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
    const pnlR = ((isLong ? triggerPrice - fresh.entryPrice : fresh.entryPrice - triggerPrice) / initialRisk) * frac
    const pnlUsd = (isLong ? triggerPrice - fresh.entryPrice : fresh.entryPrice - triggerPrice) * closeUnits
    await applyVirtualClose(fresh, reason, triggerPrice, frac, pnlR, pnlUsd, ts)
    return
  }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  let actualFillPrice = triggerPrice
  let actualPnlUsd = 0
  let feePaid = 0
  // If we're about to close on SL, cancel the exchange-side STOP_MARKET first
  // so the two paths don't race (both would try to reduceOnly, second one
  // gets -2022). Same race protection for TPs: cancel the matching exchange
  // TAKE_PROFIT_MARKET so our MARKET reduceOnly doesn't get -2022 when the
  // exchange algo fires a millisecond later.
  if (reason === 'SL') {
    await cancelSlOnExchange(fresh).catch(() => { /* best-effort */ })
  } else if (reason === 'TP1' || reason === 'TP2' || reason === 'TP3') {
    const tpIdx = reason === 'TP1' ? 1 : reason === 'TP2' ? 2 : 3
    await cancelTpOnExchange(fresh, tpIdx).catch(() => { /* best-effort */ })
  }
  // Tagged clientOrderId — when ORDER_TRADE_UPDATE arrives for this MARKET,
  // handleExitFillUpdate uses the cid to find the trade row + reason and
  // overwrite the closes[] entry with exact avgPrice + commission.
  const exitCid = `exL${fresh.id}_${reason}`
  let orderRejected = false  // true if exchange refused (-2022) — WS refine won't come
  try {
    const resp = await state.current.client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: true,
      newClientOrderId: exitCid,
    })
    // executedQty is reliable from sync response; avgPrice is not (Binance
    // returns "0.00000" before the matching engine indexes the fill). We use
    // triggerPrice as the placeholder and let the WS event correct it.
    if (resp.executedQty && Number(resp.executedQty) > 0) {
      // not used directly here, but kept for symmetry; qty already known
    }
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2022) {
      // -2022 'ReduceOnly Order is rejected' — position already closed by us
      // or by the exchange (ADL/liq). Record the virtual close anyway so DB
      // matches reality, mark CLOSED. Better than leaving row OPEN forever.
      console.warn(`${LOG} #${fresh.id} ${trade.symbol} ${reason} MARKET rejected (-2022 reduceOnly) — position already closed`)
      orderRejected = true
    } else {
      console.error(`${LOG} #${fresh.id} ${trade.symbol} ${reason} MARKET failed: ${e.message}`)
      // Don't write the close — re-try on next tick (slip lock so next tick can).
      return
    }
  }

  const isLong = trade.side === 'BUY'
  const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
  const pnlR = ((isLong ? actualFillPrice - fresh.entryPrice : fresh.entryPrice - actualFillPrice) / initialRisk) * frac
  actualPnlUsd = (isLong ? actualFillPrice - fresh.entryPrice : fresh.entryPrice - actualFillPrice) * closeUnits

  // Estimate taker fee (Binance USDT-M VIP0 = 0.04% taker on MARKET).
  feePaid = qty * actualFillPrice * (fresh.feeTakerPct ?? 0.04) / 100

  // notifyImmediately=true only when the order was rejected — no WS refine
  // will arrive, so we must send the Telegram now with the virtual estimate.
  // Otherwise handleExitFillUpdate sends it after Binance reports exact
  // avgPrice + commission + realizedProfit so Telegram matches UI/exchange.
  await applyVirtualClose(fresh, reason, actualFillPrice, frac, pnlR, actualPnlUsd - feePaid, ts, feePaid, orderRejected)
}

export async function applyVirtualClose(
  fresh: any,
  reason: 'SL' | 'TP1' | 'TP2' | 'TP3',
  fillPrice: number,
  frac: number,
  pnlR: number,
  netPnl: number,
  ts: number,
  feePaid: number = 0,
  notifyImmediately: boolean = false,
): Promise<void> {
  // grossPnl = pnl before fees. We persist gross in closes[].pnlUsd so the
  // absolute recompute below treats Σ closes[].pnlUsd as gross realized;
  // closes[].feePaidUsd holds the fee for this slice. handleExitFillUpdate
  // will later overwrite both fields with Binance's `o.rp` (gross realized
  // for the fill — this is what `o.rp` is) and `o.n` (commission).
  const grossPnl = netPnl + feePaid
  const newCloses = [
    ...((fresh.closes as any[]) ?? []),
    {
      price: fillPrice,
      percent: frac * 100,
      pnlR,
      pnlUsd: grossPnl,
      feePaidUsd: feePaid,
      closedAt: new Date(ts).toISOString(),
      reason,
    },
  ]

  // Trailing logic for TPs.
  let newCurrentStop = fresh.currentStop
  let newStatus = fresh.status
  let terminal = false
  if (reason === 'TP1') {
    newCurrentStop = fresh.entryPrice  // BE
    newStatus = 'TP1_HIT'
  } else if (reason === 'TP2') {
    newCurrentStop = (fresh.tpLadder as number[])[0]  // TP1 level
    newStatus = 'TP2_HIT'
  } else if (reason === 'TP3') {
    newStatus = 'TP3_HIT'
    terminal = true
  } else if (reason === 'SL') {
    // SL trail label: 0 = initial stop full loss, 1+ = locked partial profit
    const priorTps = ((fresh.closes as any[]) ?? []).filter((c: any) => c.reason?.startsWith('TP')).length
    newStatus = priorTps === 0 ? 'SL_HIT' : 'CLOSED'
    terminal = true
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: fresh.id },
    data: {
      closes: newCloses as any,
      currentStop: newCurrentStop,
      status: newStatus,
      realizedR: { increment: pnlR },
      ...(terminal ? { closedAt: new Date(ts) } : {}),
    },
  })
  // Absolute recompute — replaces the old `{ increment: ... }` math which was
  // race-sensitive when handleExitFillUpdate ran out of order with this call.
  await recomputeTradeMoney(fresh.id)

  console.log(`${LOG} ${reason === 'SL' ? '🔴' : '✅'} ${reason} hit #${fresh.id} ${fresh.symbol} @ ${fillPrice} pnl ${netPnl.toFixed(4)}`)

  // Telegram. By default we defer to handleExitFillUpdate, which sends the
  // notification after Binance reports exact avgPrice + commission +
  // realizedProfit — so the user sees numbers matching UI and the exchange
  // (including accrued funding). notifyImmediately=true only when the order
  // was rejected on the exchange (-2022 reduceOnly) — in that case no WS
  // refine will arrive, so we must send the virtual estimate now.
  if (notifyImmediately) {
    await notifyExitTelegram(fresh.id, reason, fillPrice, frac, netPnl, true)
  }

  // Sync the exchange-side SL with the new currentStop / position size.
  //  - TP1/TP2: position shrunk + currentStop trailed (BE / TP1) — replace old
  //    STOP_MARKET with a fresh one at the new trigger.
  //  - SL / TP3: position is closed (terminal) — cancel the safety-net SL AND
  //    any remaining exchange TPs so nothing dangles on the book.
  if (terminal) {
    await cancelSlOnExchange(fresh).catch(() => { /* best-effort */ })
    // Re-read the row so binanceTpOrderIds reflects whichever TP fired (if any).
    const t2 = await prisma.breakoutLiveTradeC.findUnique({ where: { id: fresh.id } })
    if (t2) await cancelAllTpsOnExchange(t2).catch(() => { /* best-effort */ })
  } else if (reason === 'TP1' || reason === 'TP2') {
    await retrailSlOnExchange(fresh.id).catch((e) =>
      console.warn(`${LOG} retrailSlOnExchange threw: ${e?.message ?? e}`))
  }

  // Force-refresh balance from REST after any exit. Realized PnL just hit the
  // wallet — without a refresh, sizing/UI keeps reading stale currentDepositUsd
  // until the next 30s tick. One weight=5 call per close.
  if (state.current) {
    await seedSnapshotFromRest(state.current.client, state.current.net, 'rest-refresh').catch((e) =>
      console.warn(`${LOG} post-close balance refresh failed: ${e?.message ?? e}`))
  }

  // Refresh aggregate stats (W/L count, totalPnL, peak/DD) on every close so
  // the header cards stop showing 0W/0L/0% DD.
  await recomputeLiveCStats().catch((e) =>
    console.warn(`${LOG} post-close recomputeLiveCStats failed: ${e?.message ?? e}`))
}
