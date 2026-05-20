/**
 * Cycle ticks — placement (60s) + EOD-FLAT / orphan cleanup (1min).
 */

import { prisma } from '../../db/prisma'
import { LOG, state, cycleGuard, eodGuard } from './state'
import { placeLimitsForRanges } from './placement'
import { refreshAggTradeSubscriptions } from './aggTrade'
import { flattenAllOpenC, cancelOrphanPendingLimits, cancelAllPendingLimits } from './flatten'
import { pruneOldAttempts } from './attempts'
import { sweepClosedRowDust, sweepStrayAlgoOrders } from './reconcile'
import { sendLiveCEodSummary } from './eod'

/**
 * Placement tick — mirrors paper C cadence. Virtual limits live only in DB;
 * no exchange order is placed until aggTrade WS observes price cross the
 * rangeEdge. So cycle frequency only affects how soon a brand-new 3h range
 * gets pair-PENDING rows in DB after 03:00 UTC — once they're in DB, aggTrade
 * ticks (50-500/sec on hot symbols) drive fills directly.
 */
export async function runLiveCycle(): Promise<void> {
  if (cycleGuard.busy) {
    // Re-entrancy guard per feedback_setinterval_reentrancy_guard memory.
    return
  }
  cycleGuard.busy = true
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return
    if (cfg.killSwitchActive) {
      console.log(`${LOG} kill switch active — cycle no-op`)
      return
    }
    if (!cfg.enabled) {
      // WS streams stay up for UI, but no trading.
      return
    }
    if (!state.current) return  // service stopped between schedule and tick

    // Unstuck stale FILLING claims. tryFillVirtualLimit flips a row to
    // 'FILLING' atomically, then sends MARKET, then writes the OPEN row. If
    // the backend dies between claim and the OPEN write, the row sits in
    // FILLING forever — invisible to aggTrade watcher (filters PENDING_LIMIT
    // only) AND to EOD cancel (filters PENDING_LIMIT only). Anything older
    // than 10 minutes in FILLING is dead; revert to PENDING_LIMIT so the
    // watcher can retry, or — if from a prior UTC day — let EOD/orphan tick
    // sweep it. Catches the #4894 1000BONK pattern we saw 2026-05-20.
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000)
    const stale = await prisma.breakoutLiveTradeC.updateMany({
      where: { limitOrderState: 'FILLING', limitPlacedAt: { lt: staleCutoff } },
      data: { limitOrderState: 'PENDING_LIMIT' },
    })
    if (stale.count > 0) {
      console.log(`${LOG} unstuck ${stale.count} stale FILLING row(s) (> 10 min old) — back to PENDING_LIMIT`)
    }

    // Pre-emptive limit placement: one BUY + one SELL on rangeEdge for each
    // tracked symbol that has a formed 3h range today and no open record yet.
    await placeLimitsForRanges(cfg, state.current.client, state.current.net)

    // Refresh market-data aggTrade subscriptions so we keep an eye on every
    // symbol with a live row (PENDING or OPEN). Used for freshness signal and
    // future safety-net logic; SL/TP triggers themselves are real exchange
    // orders so don't depend on aggTrade.
    await refreshAggTradeSubscriptions()
  } catch (e: any) {
    console.error(`${LOG} cycle threw:`, e.message)
  } finally {
    cycleGuard.busy = false
  }
}

/**
 * Runs every minute. Two responsibilities:
 *   1. If current UTC time is in 23:55-23:56 window AND we haven't flushed
 *      today yet → flatten all open positions via MARKET reduceOnly.
 *   2. Around 00:01 UTC, cancel any PENDING_LIMIT entry orders still on the
 *      book from prior days (cleanup if EOD didn't run, e.g. process restart).
 */
export async function runEodTick(): Promise<void> {
  if (!state.current) return
  const now = new Date()
  const utcDate = now.toISOString().slice(0, 10)
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // EOD flatten window: 23:55 UTC. Idempotent via eodGuard.lastDate.
  // Three-part flush: close all open positions via MARKET reduceOnly, cancel
  // every still-pending virtual limit, then sweep any step-rounding dust that
  // got left on the exchange (e.g. step=1 closes leave 0.5-unit residuals).
  if (hour === 23 && minute >= 55 && eodGuard.lastDate !== utcDate) {
    eodGuard.lastDate = utcDate
    console.log(`${LOG} EOD-FLAT window ${utcDate} 23:55 UTC — flattening open positions + cancelling pending + dust sweep`)
    try {
      await flattenAllOpenC('EOD-FLAT')
    } catch (e: any) {
      console.error(`${LOG} EOD-FLAT failed: ${e.message}`)
    }
    try {
      await cancelAllPendingLimits()
    } catch (e: any) {
      console.error(`${LOG} EOD pending-cancel failed: ${e.message}`)
    }
    if (state.current) {
      try {
        await sweepClosedRowDust(state.current.client)
      } catch (e: any) {
        console.error(`${LOG} EOD dust sweep failed: ${e.message}`)
      }
      try {
        await sweepStrayAlgoOrders(state.current.client)
      } catch (e: any) {
        console.error(`${LOG} EOD stray-algo sweep failed: ${e.message}`)
      }
    }
    // Telegram report — full list of closes for the day with Σ P&L. Runs LAST
    // so WS refines from the flatten MARKETs land on the closes[] rows first
    // (handleExitFillUpdate writes Binance's exact o.rp/o.n) and the report
    // numbers match the dashboard's "Закрытые" tab. There's a small race where
    // a refine could land just after the report sends — acceptable for now;
    // the values would be within rounding error of the placeholder.
    try {
      await sendLiveCEodSummary(utcDate)
    } catch (e: any) {
      console.error(`${LOG} EOD summary failed: ${e.message}`)
    }
  }

  // Orphan PENDING cleanup just after midnight UTC. Cancels any pre-emptive
  // limits from yesterday that didn't fill and weren't already cancelled by
  // EOD (e.g. WS event missed during a brief disconnect).
  if (hour === 0 && minute === 1) {
    try {
      await cancelOrphanPendingLimits()
    } catch (e: any) {
      console.warn(`${LOG} orphan cleanup failed: ${e.message}`)
    }
    // Prune attempt audit rows from prior UTC days — they belonged to the
    // last range cycle and aren't useful once a new one starts.
    await pruneOldAttempts()
  }
}
