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
import { sweepDustForSymbol, cancelAllExchangeOrdersForTrade } from './reconcile'

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
  // drift on funding / external wallet movements and undercounts realized
  // partial closes that haven't terminalised the row yet).
  //
  // Guard: only update when the snapshot is fresh AND its total is sane.
  // We've seen testnet REST occasionally return availableBalance in place of
  // walletBalance which would record a phantom 40%+ drawdown. If wallet drops
  // below baseline × 0.5 AND below currentDepositUsd it's almost certainly
  // bad data — skip the DD update for this tick.
  const wallet = snapshot.current?.total ?? cfg.currentDepositUsd
  const looksBogus = wallet > 0 && wallet < cfg.startingDepositUsd * 0.5 && wallet < cfg.currentDepositUsd
  const dataToWrite: any = { totalTrades, totalWins, totalLosses, totalPnLUsd }
  if (!looksBogus) {
    const newPeak = Math.max(cfg.peakDepositUsd ?? cfg.startingDepositUsd, wallet)
    const currentDD = newPeak > 0 ? ((newPeak - wallet) / newPeak) * 100 : 0
    dataToWrite.peakDepositUsd = newPeak
    dataToWrite.maxDrawdownPct = Math.max(cfg.maxDrawdownPct ?? 0, currentDD)
  } else {
    console.warn(`${LOG} recomputeLiveCStats: snapshot.total=${wallet} looks bogus (< baseline×0.5 AND < currentDeposit) — skipping peak/DD update`)
  }

  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: dataToWrite,
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

// Removed 2026-05-20: aggTrade-driven virtual TP/SL tracker. Exit handling
// is now exchange-only — STOP_MARKET + 3x TAKE_PROFIT_MARKET algo orders on
// Binance trigger by mark price, and handleSlOrderUpdate /
// handleTpOrderUpdate (via WS) call applyVirtualClose to persist DB state.
// Reasons:
//   - hybrid (virtual race exchange) caused most of today's bugs
//   - step-rounding mismatch produced dust positions
//   - mark-price vs last-price tick discrepancies misfired exits
//   - hot symbols hammered REST when virtual triggered ahead of exchange
// applyVirtualClose stays as the shared DB-update helper for the WS path.
// recomputeTradeMoney / recomputeLiveCStats / notifyExitTelegram unchanged.

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
    // Clear stored algo refs — cancelAllTpsOnExchange already empties the
    // TP list, but cancelSlOnExchange doesn't touch the SL ref. Null it out
    // so subsequent reconcile/sweep cycles don't see a stale algoId.
    await prisma.breakoutLiveTradeC.update({
      where: { id: fresh.id },
      data: { binanceSlOrderId: null },
    }).catch(() => { /* noop */ })
    // Belt-and-braces: the cancelAllTpsOnExchange call above trusts the DB
    // array binanceTpOrderIds. If that array was nulled by a prior reconcile,
    // or never written (WS race after entry), TPs survive the terminal close
    // (observed 2026-05-20 #4904 TRUMP: SL_HIT but TP1+TP2 still on the book).
    // Query the exchange directly and kill anything tagged with this trade's
    // clientAlgoId — independent of what the DB thinks we placed.
    if (state.current) {
      await cancelAllExchangeOrdersForTrade(state.current.client, fresh.id, fresh.symbol).catch((e) =>
        console.warn(`${LOG} post-close cancelAllExchangeOrdersForTrade failed: ${e?.message ?? e}`))
    }
    // Sweep any step-rounding residue NOW instead of waiting for EOD. SL@BE
    // from exchange STOP_MARKET and TP3 from exchange TAKE_PROFIT_MARKET both
    // close their advertised qty, but if entry filled fractional (e.g. 10.4
    // for stepSize=1) the STOP_MARKET/TPs we placed were floor-step (10) and
    // ~0.4 contracts get stripped of margin but stay listed in Binance UI.
    if (state.current) {
      await sweepDustForSymbol(state.current.client, fresh.symbol).catch((e) =>
        console.warn(`${LOG} post-close sweepDustForSymbol failed: ${e?.message ?? e}`))
    }
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
