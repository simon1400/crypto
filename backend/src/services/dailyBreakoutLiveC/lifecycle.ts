/**
 * Lifecycle — start / stop / restart of the LIVE C trader.
 *
 * Idempotent. WS streams stay up regardless of cfg.enabled so the /status
 * endpoint always has live position/balance data. Strategy gating (no
 * placements when disabled) happens inside runLiveCycle.
 */

import { prisma } from '../../db/prisma'
import {
  getBinanceClient, getBinanceCreds,
} from '../exchanges/binanceFutures'
import {
  BinanceUserDataStream, BinanceMarketDataStream,
} from '../exchanges/binanceFuturesWs'
import { LOG, state, startGuard, snapshot } from './state'
import { seedSnapshotFromRest } from './snapshot'
import { recomputeLiveCStats } from './virtualSltp'
import { reconcileWithExchange, closeLowMarginPositions, sweepStrayAlgoOrders } from './reconcile'
import { sendLiveTelegram } from './telegram'
import { runLiveCycle, runEodTick } from './cycle'
import { handleAggTrade } from './aggTrade'
import { handleUserDataEvent } from './wsHandlers'

/**
 * Start the live trader. Idempotent — if already running, returns the existing
 * connection. If Strategy is disabled in config, leaves state=null (the tick
 * checks cfg.enabled on each iteration; this start is for WS connectivity).
 *
 * We start the WS streams regardless of enabled flag so the UI/status endpoint
 * has live position/balance data even when Strategy isn't trading.
 */
export async function startBreakoutLiveTraderC(): Promise<void> {
  if (state.current || startGuard.inFlight) return
  startGuard.inFlight = true
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) {
      console.log(`${LOG} no config row yet — skip start`)
      return
    }

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) {
      console.log(`${LOG} no Binance creds for ${cfg.useTestnet ? 'testnet' : 'prod'} — skip start (configure on /settings)`)
      return
    }

    const client = getBinanceClient(creds)
    try {
      await client.syncTime()
    } catch (e: any) {
      console.warn(`${LOG} time sync failed: ${e.message} — defer start`)
      return
    }

    // Seed the live snapshot once via REST so /status has data immediately
    // (before the first ACCOUNT_UPDATE arrives). After this, the snapshot is
    // maintained by WS handlers; REST is only used as a staleness backup.
    try {
      await seedSnapshotFromRest(client, creds.net, 'rest-seed')
      console.log(`${LOG} snapshot seeded — bal $${snapshot.current?.available?.toFixed(2) ?? '?'} · positions ${snapshot.current?.positions?.length ?? 0}`)
    } catch (e: any) {
      console.warn(`${LOG} snapshot seed failed: ${e.message} — /status will return null until first ACCOUNT_UPDATE`)
    }

    // Backfill aggregate stats once on boot — trades closed before this code
    // shipped never triggered recomputeLiveCStats, so W/L/maxDD sit at 0.
    // One write here brings the config row in sync with whatever's in trades.
    await recomputeLiveCStats().catch((e) =>
      console.warn(`${LOG} boot recomputeLiveCStats failed: ${e?.message ?? e}`))

    // Reconcile DB ↔ exchange BEFORE starting the WS handlers — we want to
    // know about any drift (unknown positions, missing orders) before live
    // events start flowing.
    const reconcileReport = await reconcileWithExchange(client)
    if (reconcileReport.hasUntrackedPositions || reconcileReport.hasUntrackedOrders) {
      // Strategy stays disabled until user reviews manually. The trader is
      // still running (WS up, status endpoint works), but won't auto-place.
      await prisma.breakoutLiveConfigC.update({
        where: { id: 1 },
        data: {
          enabled: false,
          killSwitchActive: true,
          killSwitchReason: `Untracked positions/orders on exchange: ${reconcileReport.summary}`,
          killSwitchAt: new Date(),
        },
      })
      console.error(`${LOG} ⚠ untracked exchange state — Strategy disabled until manual review: ${reconcileReport.summary}`)
      await sendLiveTelegram([
        `🛑 <b>Reconciliation drift</b>  · Strategy выключен`,
        `━━━━━━━━━━━━━━━━━━`,
        `❗ Обнаружены позиции/ордера на бирже, которых нет в БД.`,
        `📋 ${reconcileReport.summary}`,
        `⚙ Проверь страницу C·LIVE и сними kill-switch вручную.`,
      ].join('\n'))
    } else if (reconcileReport.summary !== 'no drift') {
      // Soft drift (recovered late fills / closed positions) — informational only.
      await sendLiveTelegram([
        `ℹ <b>Reconciliation</b>  · восстановление состояния`,
        `${reconcileReport.summary}`,
      ].join('\n'))
    }

    const userDataWs = new BinanceUserDataStream({
      net: creds.net,
      client,
      onEvent: (ev) => handleUserDataEvent(ev),
      onDisconnect: (reason) => console.warn(`${LOG} user data WS disconnected: ${reason}`),
    })
    await userDataWs.start()

    const marketDataWs = new BinanceMarketDataStream({
      net: creds.net,
      onAggTrade: (sym, price, ts) => handleAggTrade(sym, price, ts),
    })
    marketDataWs.start()

    // Placement tick — every 60s. See cycle.ts for why this cadence is fine
    // even though aggTrade drives fills sub-second.
    const tickTimer = setInterval(() => {
      runLiveCycle().catch((e) => console.error(`${LOG} cycle error:`, e.message))
    }, 60 * 1000)

    // EOD-FLAT tick — every minute, fires once at 23:55 UTC to flatten any
    // still-open positions. Independent from the 60s cycle so we don't miss
    // the window. Also runs orphan PENDING cleanup after midnight.
    const eodTimer = setInterval(() => {
      runEodTick().catch((e) => console.error(`${LOG} EOD tick error:`, e.message))
    }, 60 * 1000)

    // Watchdog removed 2026-05-20 — exit handling is now exchange-only via
    // Binance algo orders, so missed aggTrade wicks no longer matter (mark
    // price drives the STOP_MARKET / TAKE_PROFIT_MARKET triggers directly).

    state.current = { client, userDataWs, marketDataWs, tickTimer, eodTimer, watchdogTimer: null, net: creds.net }
    console.log(`${LOG} started (${creds.net})`)

    // Kick off one immediate cycle so subscriptions/reconciliation happen now,
    // not 60s from now.
    runLiveCycle().catch((e) => console.error(`${LOG} initial cycle error:`, e.message))

    // Close any exchange-side dust positions whose isolated margin < $1
    // (after restart, finds anything left from prior session's step-rounding
    // residue). Margin-based gate replaces the old qty/minQty heuristic which
    // refused to act on residuals below minQty — those stayed visible in
    // Binance UI until manually cleared.
    closeLowMarginPositions(client).catch((e) => console.warn(`${LOG} boot low-margin sweep error:`, e.message))
    // Same idea, but for algo orders (TP/SL): cancel anything whose owning
    // trade is already terminal, plus random-cid orphans.
    sweepStrayAlgoOrders(client).catch((e) => console.warn(`${LOG} boot stray-algo sweep error:`, e.message))
  } finally {
    startGuard.inFlight = false
  }
}

export function stopBreakoutLiveTraderC(): void {
  if (!state.current) return
  console.log(`${LOG} stopping`)
  if (state.current.tickTimer) clearInterval(state.current.tickTimer)
  if (state.current.eodTimer) clearInterval(state.current.eodTimer)
  if (state.current.watchdogTimer) clearInterval(state.current.watchdogTimer)
  state.current.userDataWs.stop()
  state.current.marketDataWs.stop()
  state.current = null
}

/**
 * Restart the trader — used when credentials change (saved/deleted on /settings)
 * or when the user toggles testnet/prod. Drops connections, picks up fresh
 * creds from DB.
 */
export async function restartBreakoutLiveTraderC(): Promise<void> {
  stopBreakoutLiveTraderC()
  await startBreakoutLiveTraderC()
}

export function isRunning(): boolean { return state.current !== null }
export function currentNet(): 'testnet' | 'prod' | null { return state.current?.net ?? null }
