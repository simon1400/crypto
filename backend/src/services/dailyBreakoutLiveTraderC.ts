/**
 * Daily Breakout — Variant C LIVE trader (Binance Futures USDT-M, real money).
 *
 * Mirrors the paper C trader's mechanics 1:1 (pre-emptive limit on rangeEdge,
 * pair cancel on fill, real TP/SL ladders, full trailing, EOD-FLAT 23:55 UTC),
 * but every action that paper simulates this service executes on Binance:
 *   - Placement → POST /fapi/v1/order LIMIT GTC
 *   - Pair cancel → DELETE /fapi/v1/order on the other side's clientOrderId
 *     triggered by ORDER_TRADE_UPDATE WS event with X=FILLED
 *   - TP1/TP2/TP3 → 3× TAKE_PROFIT_MARKET reduceOnly placed after entry fill
 *   - SL → STOP_MARKET reduceOnly placed after entry fill, replaced on each
 *     trailing step (TP1 hit → SL → BE; TP2 hit → SL → TP1)
 *   - EOD-FLAT → cancel TP/SL children + MARKET reduceOnly on remaining qty
 *
 * Reads BreakoutLiveConfigC (cfg.enabled, useTestnet, killSwitchActive,
 * circuit breaker, sizing knobs) and the shared BreakoutConfig for the
 * universe + rangeBars / volumeMultiplier (same source as paper A/B/C).
 *
 * Writes BreakoutLiveTradeC rows with exchange identifiers:
 *   binanceClientOrderId — our deterministic ID, format: 'cL{net}_{rangeDate}_{symbol}_{side}'
 *   binanceOrderId       — exchange-assigned, captured from placement response
 *   binanceSlOrderId / binanceTpOrderIds — child reduceOnly orders, captured after fill
 *
 * This file is the skeleton — placement, fill handling, trailing, and EOD are
 * implemented in follow-up commits. For now it just owns the start/stop
 * lifecycle and exposes hooks the WS layer + index.ts will call into.
 */

import { prisma } from '../db/prisma'
import {
  getBinanceClient, getBinanceCreds, BinanceFuturesClient, BinanceApiError,
  type SymbolFilter,
} from './exchanges/binanceFutures'
import {
  BinanceUserDataStream, BinanceMarketDataStream,
  type OrderTradeUpdateEvent, type AccountUpdateEvent,
} from './exchanges/binanceFuturesWs'
import { detectRange, BreakoutEngineConfig } from '../scalper/dailyBreakoutEngine'
import { loadHistorical } from '../scalper/historicalLoader'
import { computeSizing } from './marginGuard'
import { DEFAULT_BREAKOUT_SETUPS } from './dailyBreakoutLiveScanner'
// refreshLiveBalance removed 2026-05-19 — superseded by getLiveSnapshot which
// pulls balance from the WS-driven snapshot instead of a per-cycle REST hit.

const LOG = '[BreakoutLiveC]'
const TG_PREFIX = '⚠️ <b>[LIVE C]</b> '

// ============================================================================
// Telegram helper — sends a live notification using the BotConfig credentials.
// Kept separate from notifier.ts (which is paper-only) so live events don't
// risk regressing the existing message templates.
// ============================================================================
async function sendLiveTelegram(html: string): Promise<void> {
  try {
    const cfg = await prisma.botConfig.findUnique({ where: { id: 1 } })
    if (!cfg?.telegramEnabled) return
    if (!cfg.telegramBotToken || !cfg.telegramChatId) return
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        text: TG_PREFIX + html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (e: any) {
    console.warn(`${LOG} Telegram send failed: ${e.message}`)
  }
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

// Cache exchangeInfo filters for 1h — they don't change intraday and we'd
// otherwise hit /fapi/v1/exchangeInfo (weight 1) on every placement cycle.
let filtersCache: { at: number; map: Map<string, SymbolFilter> } | null = null
const FILTERS_TTL_MS = 60 * 60 * 1000

async function getFilters(client: BinanceFuturesClient): Promise<Map<string, SymbolFilter>> {
  if (filtersCache && Date.now() - filtersCache.at < FILTERS_TTL_MS) return filtersCache.map
  const map = await client.getSymbolFilters()
  filtersCache = { at: Date.now(), map }
  return map
}

/**
 * Build deterministic clientOrderId for an entry limit. Same range edge → same
 * cID, so retrying the cycle within the same day won't double-place. Binance
 * caps cID at 36 chars — we keep our scheme short.
 *   cL{net[0]}_{YYYYMMDD}_{SYMBOL_no_USDT}_{B|S}
 * Examples: cLt_20260518_BTC_B, cLp_20260518_DOGE_S
 */
function buildEntryCid(net: 'testnet' | 'prod', rangeDate: string, symbol: string, side: 'BUY' | 'SELL'): string {
  const compactDate = rangeDate.replace(/-/g, '')
  const ticker = symbol.replace(/USDT$/, '')
  return `cL${net[0]}_${compactDate}_${ticker}_${side[0]}`
}

// ============================================================================
// Lifecycle
// ============================================================================

interface RunningState {
  client: BinanceFuturesClient
  userDataWs: BinanceUserDataStream
  marketDataWs: BinanceMarketDataStream
  tickTimer: NodeJS.Timeout | null
  eodTimer: NodeJS.Timeout | null
  net: 'testnet' | 'prod'
}

// Track which UTC day we already EOD-flushed so the 1-min tick doesn't fire
// the flush repeatedly between 23:55 and 23:56.
let lastEodDate: string | null = null

// One breaker alert per UTC day. Set when notifyBreaker fires, cleared on the
// first cycle of a new UTC day (compared inside maybeNotifyBreaker).
let breakerNotifiedDate: string | null = null

async function maybeNotifyBreaker(cb: { reason: string; realizedR: number; netPnlUsd: number; pnlPct: number }): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (breakerNotifiedDate === today) return
  breakerNotifiedDate = today
  await sendLiveTelegram([
    `🛑 <b>Circuit breaker</b>  · сегодняшняя торговля остановлена`,
    `━━━━━━━━━━━━━━━━━━`,
    `❗ ${cb.reason}`,
    `📈 Σ R    ${cb.realizedR.toFixed(2)}R`,
    `💵 Σ P&L  <b>${fmtPnl(cb.netPnlUsd)}</b> (${cb.pnlPct.toFixed(2)}%)`,
    `🚫 Новые лимитки заблокированы, висящие отменены до следующего UTC дня.`,
  ].join('\n'))
}

let state: RunningState | null = null
let startInFlight = false

/**
 * Start the live trader. Idempotent — if already running, returns the existing
 * connection. If Strategy is disabled in config, leaves state=null (the tick
 * checks cfg.enabled on each iteration; this start is for WS connectivity).
 *
 * We start the WS streams regardless of enabled flag so the UI/status endpoint
 * has live position/balance data even when Strategy isn't trading.
 */
export async function startBreakoutLiveTraderC(): Promise<void> {
  if (state || startInFlight) return
  startInFlight = true
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
    // maintained by WS handlers; REST is only used as a 5-min staleness backup.
    try {
      await seedSnapshotFromRest(client, creds.net, 'rest-seed')
      console.log(`${LOG} snapshot seeded — bal $${liveSnapshot?.available?.toFixed(2) ?? '?'} · positions ${liveSnapshot?.positions?.length ?? 0}`)
    } catch (e: any) {
      console.warn(`${LOG} snapshot seed failed: ${e.message} — /status will return null until first ACCOUNT_UPDATE`)
    }

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

    // Placement tick — every 60s, mirrors paper C cadence. Virtual limits live
    // only in DB; no exchange order is placed until aggTrade WS observes price
    // cross the rangeEdge. So cycle frequency only affects how soon a brand-new
    // 3h range gets pair-PENDING rows in DB after 03:00 UTC — once they're
    // in DB, aggTrade ticks (50-500/sec on hot symbols) drive fills directly.
    const tickTimer = setInterval(() => {
      runLiveCycle().catch((e) => console.error(`${LOG} cycle error:`, e.message))
    }, 60 * 1000)

    // EOD-FLAT tick — every minute, fires once at 23:55 UTC to flatten any
    // still-open positions. Independent from the 5min cycle so we don't miss
    // the window. Also runs orphan PENDING cleanup after midnight.
    const eodTimer = setInterval(() => {
      runEodTick().catch((e) => console.error(`${LOG} EOD tick error:`, e.message))
    }, 60 * 1000)

    state = { client, userDataWs, marketDataWs, tickTimer, eodTimer, net: creds.net }
    console.log(`${LOG} started (${creds.net})`)

    // Kick off one immediate cycle so subscriptions/reconciliation happen now,
    // not 5 min from now.
    runLiveCycle().catch((e) => console.error(`${LOG} initial cycle error:`, e.message))
  } finally {
    startInFlight = false
  }
}

export function stopBreakoutLiveTraderC(): void {
  if (!state) return
  console.log(`${LOG} stopping`)
  if (state.tickTimer) clearInterval(state.tickTimer)
  if (state.eodTimer) clearInterval(state.eodTimer)
  state.userDataWs.stop()
  state.marketDataWs.stop()
  state = null
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

export function isRunning(): boolean { return state !== null }
export function currentNet(): 'testnet' | 'prod' | null { return state?.net ?? null }

// ============================================================================
// Live snapshot — WS-driven account state (replaces REST polling from /status)
//
// Why: the UI polls /status every 10s for connectivity + balance + positions.
// Hitting Binance with 3 SIGNED REST calls × 6/min (getAccount + getOpenPositions
// + getOpenOrders) burned through rate-limit weight and triggered 418/-1003
// IP bans (2026-05-19). Solution: keep an in-memory snapshot driven by
// ACCOUNT_UPDATE WS events. REST is only used to seed the snapshot on start
// and as a stale-data refresh (>= 5 min old).
//
// ACCOUNT_UPDATE delivers full asset balances and position deltas on every
// trade event, so the snapshot stays current without polling.
// ============================================================================

export interface LiveSnapshot {
  net: 'testnet' | 'prod' | null
  available: number   // free USDT balance (USDT-M futures wallet)
  total: number       // wallet balance (including unrealized)
  positions: Array<{
    symbol: string
    positionAmt: number
    entryPrice: number
    markPrice: number       // last seen via aggTrade; null if no recent tick
    unRealizedProfit: number
    leverage: number
    marginType: 'isolated' | 'cross'
  }>
  updatedAt: number   // ms epoch; consumer can compare with Date.now() for staleness
  source: 'rest-seed' | 'ws-account-update' | 'rest-refresh'
}

let liveSnapshot: LiveSnapshot | null = null

// Per-symbol last mark price from aggTrade WS — used to compute unrealized PnL
// in the snapshot without an extra REST call.
const lastMarkPriceWs = new Map<string, number>()

const SNAPSHOT_STALE_MS = 30 * 1000  // 30s — refresh REST. WS approximation
// drifts (it doesn't get an availableBalance value, only walletBalance, and we
// subtract entry-price-based margin which doesn't match Binance's mark-based
// internal calc). 30s REST keeps currentDepositUsd within $0.01 of reality
// without burning weight (weight 5 per refresh × 2/min = 10 weight/min).

export async function getLiveSnapshot(forceRefresh = false): Promise<LiveSnapshot | null> {
  if (!state) return null
  if (forceRefresh || !liveSnapshot || Date.now() - liveSnapshot.updatedAt > SNAPSHOT_STALE_MS) {
    try {
      await seedSnapshotFromRest(state.client, state.net, forceRefresh ? 'rest-refresh' : 'rest-refresh')
    } catch (e: any) {
      console.warn(`${LOG} snapshot refresh failed: ${e.message} — returning stale snapshot`)
    }
  }
  return liveSnapshot
}

async function seedSnapshotFromRest(
  client: BinanceFuturesClient,
  net: 'testnet' | 'prod',
  source: 'rest-seed' | 'rest-refresh',
): Promise<void> {
  // Single getAccount call covers balance + positions. Saves us from the old
  // getAccount + getOpenPositions double-hit. Weight: 5 (vs 5+5 before).
  const acc = await client.getAccount()
  const usdt = acc.assets.find((a) => a.asset === 'USDT')
  const available = usdt ? Number(usdt.availableBalance) : 0
  const total = usdt ? Number(usdt.walletBalance) : 0
  const positions = (acc.positions ?? [])
    .filter((p) => Number(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      positionAmt: Number(p.positionAmt),
      entryPrice: Number(p.entryPrice),
      markPrice: lastMarkPriceWs.get(p.symbol) ?? Number(p.markPrice ?? p.entryPrice),
      unRealizedProfit: Number(p.unRealizedProfit ?? 0),
      leverage: Number(p.leverage ?? 1),
      marginType: (p.marginType === 'isolated' ? 'isolated' : 'cross') as 'isolated' | 'cross',
    }))
  liveSnapshot = { net, available, total, positions, updatedAt: Date.now(), source }
  // Mirror into BreakoutLiveConfigC.currentDepositUsd so sizing/cycle reads
  // stay in sync with the snapshot — same effect as the old refreshLiveBalance.
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: { currentDepositUsd: available },
  }).catch(() => { /* noop — config row absent at very first boot */ })
}

// ============================================================================
// Cycle (5 min) — placement / safety net / EOD
// ============================================================================

let cycleBusy = false

async function runLiveCycle(): Promise<void> {
  if (cycleBusy) {
    // Re-entrancy guard per feedback_setinterval_reentrancy_guard memory.
    return
  }
  cycleBusy = true
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return
    if (cfg.killSwitchActive) {
      console.log(`${LOG} kill switch active — cycle no-op`)
      return
    }
    if (!cfg.enabled) {
      // WS streams stay up for UI, but no trading. Refresh subscriptions to the
      // symbols of any still-open positions (handled in follow-up commit).
      return
    }
    if (!state) return  // service stopped between schedule and tick

    // Pre-emptive limit placement: one BUY + one SELL on rangeEdge for each
    // tracked symbol that has a formed 3h range today and no open record yet.
    await placeLimitsForRanges(cfg, state.client, state.net)

    // Refresh market-data aggTrade subscriptions so we keep an eye on every
    // symbol with a live row (PENDING or OPEN). Used for freshness signal and
    // future safety-net logic; SL/TP triggers themselves are real exchange
    // orders so don't depend on aggTrade.
    await refreshAggTradeSubscriptions()
  } catch (e: any) {
    console.error(`${LOG} cycle threw:`, e.message)
  } finally {
    cycleBusy = false
  }
}

// ============================================================================
// EOD-FLAT — close all open Variant C live positions at 23:55 UTC
// ============================================================================

/**
 * Runs every minute. Two responsibilities:
 *   1. If current UTC time is in 23:55-23:56 window AND we haven't flushed
 *      today yet → flatten all open positions via MARKET reduceOnly.
 *   2. Around 00:01 UTC, cancel any PENDING_LIMIT entry orders still on the
 *      book from prior days (cleanup if EOD didn't run, e.g. process restart).
 */
async function runEodTick(): Promise<void> {
  if (!state) return
  const now = new Date()
  const utcDate = now.toISOString().slice(0, 10)
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // EOD flatten window: 23:55 UTC. Idempotent via lastEodDate guard.
  if (hour === 23 && minute >= 55 && lastEodDate !== utcDate) {
    lastEodDate = utcDate
    console.log(`${LOG} EOD-FLAT window ${utcDate} 23:55 UTC — flattening open positions`)
    try {
      await flattenAllOpenC('EOD-FLAT')
    } catch (e: any) {
      console.error(`${LOG} EOD-FLAT failed: ${e.message}`)
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

/**
 * Close every BreakoutLiveTradeC row still in an open status: cancel its SL/TP
 * children, send MARKET reduceOnly for the remaining qty, mark CLOSED.
 *
 * Used by EOD-FLAT (23:55 UTC) and by the kill-switch endpoint (manual flush).
 */
async function flattenAllOpenC(reason: string): Promise<{ closed: number; failed: number }> {
  if (!state) return { closed: 0, failed: 0 }

  const openTrades = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (openTrades.length === 0) {
    console.log(`${LOG} flatten — nothing open`)
    return { closed: 0, failed: 0 }
  }

  let closed = 0
  let failed = 0

  for (const t of openTrades) {
    try {
      // Compute remaining qty (units not yet closed by partial TPs). Virtual
      // SL/TP — no child orders on exchange to cancel; trackLiveTrade owns
      // exits entirely via MARKET reduceOnly, and once status moves to
      // CLOSED the aggTrade tracker will skip this row.
      const closesArr = ((t.closes as any[]) ?? [])
      const closedFrac = closesArr.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
      const remainingFrac = Math.max(0, 1 - closedFrac)
      const remainingQty = t.positionUnits * remainingFrac
      if (remainingQty <= 0) {
        // Nothing left to close on exchange (already fully filled via TPs/SL).
        // Just finalize the DB row.
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        closed++
        continue
      }

      const filters = await getFilters(state.client)
      const f = filters.get(t.symbol)
      if (!f) {
        console.warn(`${LOG} flatten #${t.id} — no filter for ${t.symbol}`)
        failed++
        continue
      }

      const step = f.stepSize
      let qty = Math.floor(remainingQty / step) * step
      qty = Number(qty.toFixed(f.quantityPrecision))
      if (qty < f.minQty) {
        // Below min qty — already dust. Just finalize.
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
        closed++
        continue
      }

      const closeSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'

      // Cancel the safety-net SL on the exchange before sending our MARKET —
      // otherwise both could race and one gets -2022 ReduceOnly rejected.
      await cancelSlOnExchange(t).catch(() => { /* best-effort */ })

      // 3. MARKET reduceOnly to close.
      // Note: actual fill price + realized pnl come back via ORDER_TRADE_UPDATE
      // (handleEntryOrderUpdate doesn't match because cID isn't 'cL*' — but the
      // event won't match any tracked order either, it'll fall through and be
      // logged as 'untracked'). We mark CLOSED here optimistically; precise
      // realized P&L is reconciled via REST in the next refresh cycle.
      try {
        await state.client.placeOrder({
          symbol: t.symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: qty,
          reduceOnly: true,
        })
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closes: [
              ...closesArr,
              {
                price: 0,  // exact price comes via WS event; recorded as 0 if missed
                percent: Math.round(remainingFrac * 100),
                pnlUsd: 0,
                closedAt: new Date().toISOString(),
                reason,
              },
            ] as any,
            binanceSlOrderId: null,
          },
        })
        closed++
        console.log(`${LOG} flattened #${t.id} ${t.symbol} ${t.side} qty ${qty} via MARKET (${reason})`)
      } catch (e: any) {
        console.warn(`${LOG} flatten #${t.id} MARKET failed: ${e.message}`)
        failed++
      }
    } catch (e: any) {
      console.warn(`${LOG} flatten #${t.id} threw: ${e.message}`)
      failed++
    }
  }

  console.log(`${LOG} flatten complete (${reason}): ${closed} closed, ${failed} failed`)

  if (closed > 0 || failed > 0) {
    const emoji = reason === 'EOD-FLAT' ? '🌙' : '🛑'
    await sendLiveTelegram([
      `${emoji} <b>${reason}</b>  · позиции закрыты по рынку`,
      `━━━━━━━━━━━━━━━━━━`,
      `✓ Закрыто: <b>${closed}</b>`,
      failed > 0 ? `✗ Ошибки: <b>${failed}</b>` : '',
    ].filter(Boolean).join('\n'))
  }
  return { closed, failed }
}

/**
 * Cancel virtual PENDING_LIMIT rows from prior UTC days. Since virtual-limit
 * refactor 2026-05-19 these are DB-only rows with no exchange orders behind
 * them, so cleanup is a simple updateMany.
 */
async function cancelOrphanPendingLimits(): Promise<void> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const r = await prisma.breakoutLiveTradeC.updateMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      limitPlacedAt: { lt: todayStart },
    },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'EXPIRED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${LOG} cancelled ${r.count} orphan virtual PENDING_LIMIT from prior days`)
  }
}

// Exposed for the kill-switch route (POST /api/breakout-live-c/kill-switch).
export async function flattenAllOpenLiveC(reason: string): Promise<{ closed: number; failed: number }> {
  return flattenAllOpenC(reason)
}

// Close a single LIVE-C position via reduceOnly MARKET. Used by the per-trade
// "close-market" route exposed for the BreakoutPaper UI when running variant=LIVE.
// Mirrors flattenAllOpenC for one row; precise realized P&L still gets reconciled
// later from ORDER_TRADE_UPDATE / REST refresh.
export async function flattenOneOpenLiveC(tradeId: number, reason: string): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }> {
  if (!state) return { ok: false, error: 'Live trader is not running' }

  const t = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!t) return { ok: false, error: `Trade #${tradeId} not found` }
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)) {
    return { ok: false, error: `Trade #${tradeId} is not open (status=${t.status})` }
  }

  const closesArr = ((t.closes as any[]) ?? [])
  const closedFrac = closesArr.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  const remainingQty = t.positionUnits * remainingFrac

  if (remainingQty <= 0) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    return { ok: true, closed: true }
  }

  const filters = await getFilters(state.client)
  const f = filters.get(t.symbol)
  if (!f) return { ok: false, error: `No filter for ${t.symbol}` }

  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    return { ok: true, closed: true }
  }

  const closeSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY'
  // Cancel the safety-net SL first — see flattenAllOpenC for rationale.
  await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
  try {
    await state.client.placeOrder({
      symbol: t.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: true,
    })
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closes: [
          ...closesArr,
          {
            price: 0,
            percent: Math.round(remainingFrac * 100),
            pnlUsd: 0,
            closedAt: new Date().toISOString(),
            reason,
          },
        ] as any,
        binanceSlOrderId: null,
      },
    })
    console.log(`${LOG} flattened #${t.id} ${t.symbol} ${t.side} qty ${qty} via MARKET (${reason})`)
    return { ok: true, closed: true }
  } catch (e: any) {
    console.warn(`${LOG} flatten #${t.id} MARKET failed: ${e.message}`)
    return { ok: false, error: e.message }
  }
}

// ============================================================================
// Reconciliation — sync DB ↔ exchange on startup
// ============================================================================

interface ReconcileReport {
  hasUntrackedPositions: boolean
  hasUntrackedOrders: boolean
  summary: string
  details: {
    untrackedPositions: Array<{ symbol: string; amt: number }>
    untrackedOrders: Array<{ symbol: string; orderId: number; cid: string; type: string }>
    missingPositionsForDbOpen: number
  }
}

/**
 * Compare DB BreakoutLiveTradeC rows against the exchange. Used at startup to
 * detect drift caused by:
 *   - Process down while positions closed (DB still says OPEN)
 *   - Manual trading on the same account (positions/orders we never placed)
 *   - Pre-virtual-limit refactor leftover orders ('cL' LIMITs still on book)
 *
 * Policy:
 *   - Migration: cancel any pre-existing 'cL' LIMIT exchange orders + mark their
 *     DB rows CANCELLED so the new virtual cycle places fresh pairs.
 *   - DB OPEN with no matching exchange position → mark CLOSED (filled by
 *     SL/TP while we were down); exact P&L will be reconciled later.
 *   - Exchange position without matching DB row → flag as untracked, caller
 *     decides what to do (typically: kill switch + manual review).
 */
async function reconcileWithExchange(client: BinanceFuturesClient): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    hasUntrackedPositions: false,
    hasUntrackedOrders: false,
    summary: '',
    details: {
      untrackedPositions: [],
      untrackedOrders: [],
      missingPositionsForDbOpen: 0,
    },
  }

  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  let openOrders: Awaited<ReturnType<typeof client.getOpenOrders>>
  try {
    [positions, openOrders] = await Promise.all([
      client.getOpenPositions(),
      client.getOpenOrders(),
    ])
  } catch (e: any) {
    console.error(`${LOG} reconcile: exchange query failed: ${e.message} — skipping`)
    return report
  }

  // --- DB side ---
  const dbOpen = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })

  const positionsBySymbol = new Map<string, number>()
  for (const p of positions) {
    positionsBySymbol.set(p.symbol, Number(p.positionAmt))
  }

  // --- Migration cleanup: cancel any leftover 'cL' LIMIT entry orders on the
  // exchange (from the pre-virtual-limit version) and finalize their DB rows.
  // Virtual-limit refactor 2026-05-19: entries no longer publish to the book.
  // Any 'cL' order found on the exchange is a relic of the prior code path —
  // safe to cancel without checking DB state because we don't open new ones.
  let migrationCancelled = 0
  for (const o of openOrders) {
    if (!o.clientOrderId?.startsWith('cL')) continue
    if (o.type !== 'LIMIT') continue  // safety check; cL* is only used for LIMIT entries
    try {
      await client.cancelOrder(o.symbol, { orderId: o.orderId })
      migrationCancelled++
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} migration cancel ${o.symbol} cid=${o.clientOrderId} failed: ${e.message}`)
      }
    }
  }
  if (migrationCancelled > 0) {
    console.log(`${LOG} migration: cancelled ${migrationCancelled} leftover exchange LIMIT order(s) from pre-virtual era`)
  }

  // Finalize any DB PENDING_LIMIT row that has binanceOrderId set (i.e. was
  // placed on the exchange under the old model). Mark them CANCELLED so the
  // new virtual cycle places a fresh pair on its next tick.
  const oldPlaced = await prisma.breakoutLiveTradeC.updateMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      binanceOrderId: { not: null },
    },
    data: {
      limitOrderState: 'CANCELLED_OTHER_SIDE',
      status: 'CANCELLED',
      closedAt: new Date(),
    },
  })
  if (oldPlaced.count > 0) {
    console.log(`${LOG} migration: marked ${oldPlaced.count} stale exchange-backed PENDING rows as CANCELLED`)
  }

  // --- DB OPEN vs exchange positions ---
  // Our DB says we're in a position. If exchange has zero amt for the symbol,
  // SL or TP fully closed it while we were down.
  // Also: if position is still there, make sure the safety-net SL exists on
  // the exchange — bot restart shouldn't leave positions exposed.
  for (const t of dbOpen) {
    const exchangeAmt = positionsBySymbol.get(t.symbol)
    if (exchangeAmt && exchangeAmt !== 0) {
      // Position alive — ensure the safety-net SL is in place.
      if (!t.binanceSlOrderId) {
        await attachSlAfterEntry(t.id).catch((e) =>
          console.warn(`${LOG} reconcile: attachSl #${t.id} threw: ${e?.message ?? e}`))
      }
      continue
    }

    report.details.missingPositionsForDbOpen++
    // Position closed externally — finalize the row. Exact P&L will be inferred
    // later from userTrades; for now, just close.
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closes: [
          ...((t.closes as any[]) ?? []),
          {
            price: 0,
            percent: Math.max(0, 100 - ((t.closes as any[]) ?? []).reduce((a, c: any) => a + (c.percent ?? 0), 0)),
            pnlUsd: 0,
            closedAt: new Date().toISOString(),
            reason: 'RECONCILED',
          },
        ] as any,
      },
    })
    console.log(`${LOG} reconcile: #${t.id} ${t.symbol} position gone — closed`)
  }

  // --- Exchange positions without DB row ---
  // Symbols where we have a non-zero position on exchange but no OPEN row.
  const dbSymbolsOpen = new Set(dbOpen.map((t) => t.symbol))
  for (const [sym, amt] of positionsBySymbol) {
    if (amt === 0) continue
    if (dbSymbolsOpen.has(sym)) continue
    report.details.untrackedPositions.push({ symbol: sym, amt })
    report.hasUntrackedPositions = true
  }

  // (Exchange-orders-without-DB-row check removed 2026-05-19 — entry orders
  // are no longer placed on the exchange. The migration block above already
  // cancels any pre-existing 'cL' relics. Algo SL orders are tracked via
  // attachSlAfterEntry / cancelSlOnExchange which are id-based.)

  // Build human-readable summary for the kill-switch reason.
  const parts: string[] = []
  if (report.details.untrackedPositions.length > 0) {
    parts.push(`${report.details.untrackedPositions.length} untracked position(s): ${report.details.untrackedPositions.map((p) => `${p.symbol}=${p.amt}`).join(', ')}`)
  }
  if (migrationCancelled > 0 || oldPlaced.count > 0) {
    parts.push(`migration: cancelled ${migrationCancelled} exchange order(s), ${oldPlaced.count} stale DB PENDING`)
  }
  if (report.details.missingPositionsForDbOpen > 0) {
    parts.push(`${report.details.missingPositionsForDbOpen} OPEN reconciled to closed`)
  }
  report.summary = parts.join('; ') || 'no drift'
  console.log(`${LOG} reconcile: ${report.summary}`)

  return report
}

/**
 * Sum of marginUsd from all PENDING_LIMIT and OPEN/TP1_HIT/TP2_HIT live C
 * trades. Used by the placement guard to ensure new trades don't push total
 * margin past available balance.
 *
 * For OPEN positions with partial TP fills, we discount margin by the closed
 * fraction (remaining notional / leverage).
 */
async function sumExistingMarginC(): Promise<number> {
  // Only count OPEN/TP1_HIT/TP2_HIT — margin that's ACTUALLY locked on Binance.
  // PENDING_LIMIT rows are virtual since the 2026-05-19 refactor — no exchange
  // order, no real margin lock. Including them in the budget guard was double-
  // counting against budget when paired BUY+SELL waited for a fill: each pair
  // contributed 2x its margin while reality would lock only one side once one
  // arm filled (the other gets pair-cancelled).
  //
  // 10% safety buffer on the budget (currentDepositUsd × 0.90 in caller)
  // already covers the worst-case scenario of a pair fill happening before
  // the cancel cascade runs.
  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: {
      status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] },
    },
    select: { marginUsd: true, closes: true },
  })
  let sum = 0
  for (const r of rows) {
    const baseMargin = r.marginUsd ?? 0
    if (baseMargin <= 0) continue
    const closesArr = (r.closes as any[]) ?? []
    const closedFrac = closesArr.reduce((a, c: any) => a + (c.percent ?? 0), 0) / 100
    sum += baseMargin * Math.max(0, 1 - closedFrac)
  }
  return sum
}

// ============================================================================
// Circuit breaker — daily loss limit for live trading
// ============================================================================

interface CircuitBreakerResult {
  tripped: boolean
  reason: string
  realizedR: number
  netPnlUsd: number
  pnlPct: number
}

/**
 * Compute today's UTC realized loss across all live C trades closed today.
 * Trips when EITHER threshold is exceeded:
 *   - sum(realizedR) <= -cfg.dailyLossLimitR   (default -8R)
 *   - sum(netPnlUsd) / startOfDayDeposit <= -cfg.dailyLossLimitPct / 100   (default -10%)
 *
 * Start-of-day deposit is reconstructed as currentDepositUsd - sum(netPnlUsd today),
 * same approach as paper C. We pull currentDepositUsd from the most recent
 * refreshLiveBalance() snapshot rather than calling Binance — the breaker
 * needs to be cheap (called every placement cycle).
 */
async function isLiveCircuitBreakerTripped(cfg: any): Promise<CircuitBreakerResult> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  // Sum from rows closed today UTC.
  const closedToday = await prisma.breakoutLiveTradeC.findMany({
    where: {
      closedAt: { gte: todayStart },
      status: { in: ['CLOSED', 'SL_HIT', 'TP3_HIT'] },
    },
    select: { realizedR: true, netPnlUsd: true },
  })

  let sumR = 0
  let sumPnl = 0
  for (const t of closedToday) {
    sumR += t.realizedR ?? 0
    sumPnl += t.netPnlUsd ?? 0
  }

  const startOfDayDeposit = Math.max(1, (cfg.currentDepositUsd ?? 1) - sumPnl)
  const pnlPct = (sumPnl / startOfDayDeposit) * 100

  const rLimit = -Math.abs(cfg.dailyLossLimitR ?? 8)
  const pctLimit = -Math.abs(cfg.dailyLossLimitPct ?? 10)

  if (sumR <= rLimit) {
    return {
      tripped: true,
      reason: `daily R breaker: ${sumR.toFixed(2)}R <= ${rLimit}R`,
      realizedR: sumR, netPnlUsd: sumPnl, pnlPct,
    }
  }
  if (pnlPct <= pctLimit) {
    return {
      tripped: true,
      reason: `daily PnL breaker: ${pnlPct.toFixed(2)}% <= ${pctLimit}%`,
      realizedR: sumR, netPnlUsd: sumPnl, pnlPct,
    }
  }
  return { tripped: false, reason: '', realizedR: sumR, netPnlUsd: sumPnl, pnlPct }
}

/**
 * When the breaker trips, cancel all still-pending entry limits on the
 * exchange so no new exposure opens. Existing OPEN positions are left alone
 * (they have real SL/TP children that will close them in normal flow).
 */
async function cancelAllPendingForBreaker(client: BinanceFuturesClient, reason: string): Promise<void> {
  const pending = await prisma.breakoutLiveTradeC.findMany({
    where: { limitOrderState: 'PENDING_LIMIT' },
  })
  for (const t of pending) {
    try {
      if (t.binanceClientOrderId) {
        await client.cancelOrder(t.symbol, { origClientOrderId: t.binanceClientOrderId })
      }
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} breaker cancel ${t.symbol} failed: ${e.message}`)
      }
    }
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: new Date(),
      },
    })
  }
  if (pending.length > 0) {
    console.log(`${LOG} breaker cancelled ${pending.length} PENDING limits (${reason})`)
  }
}

// ============================================================================
// Attempt audit — every decision around a placement (placed, exchange-rejected,
// or skipped by our gate / pre-placement filter) writes a row to
// BreakoutLiveAttemptC. The LIVE UI 'Отклонённые' tab reads these so the user
// can see what each cycle tried and why it didn't open.
// ============================================================================

interface AttemptArgs {
  symbol: string
  side: 'BUY' | 'SELL'
  rangeDate: string
  // PLACED | REJECTED_EXCHANGE | SKIPPED_GATE | SKIPPED_FILTER
  status: 'PLACED' | 'REJECTED_EXCHANGE' | 'SKIPPED_GATE' | 'SKIPPED_FILTER'
  reasonCode?: string | null
  reasonText?: string | null
  limitPrice?: number | null
  markPrice?: number | null
  rangeHigh?: number | null
  rangeLow?: number | null
}

async function recordAttempt(a: AttemptArgs): Promise<void> {
  try {
    await prisma.breakoutLiveAttemptC.create({
      data: {
        symbol: a.symbol,
        side: a.side,
        rangeDate: a.rangeDate,
        status: a.status,
        reasonCode: a.reasonCode ?? null,
        reasonText: a.reasonText ?? null,
        limitPrice: a.limitPrice ?? null,
        markPrice: a.markPrice ?? null,
        rangeHigh: a.rangeHigh ?? null,
        rangeLow: a.rangeLow ?? null,
      },
    })
  } catch (e: any) {
    // Best-effort audit — never break the placement cycle if logging fails.
    console.warn(`${LOG} recordAttempt failed for ${a.symbol} ${a.side}: ${e.message}`)
  }
}

/**
 * Drop attempt rows older than today so the table stays bounded. Called at
 * EOD alongside cancelOrphanPendingLimits / flatten.
 */
async function pruneOldAttempts(): Promise<void> {
  const utcDate = new Date().toISOString().slice(0, 10)
  try {
    const r = await prisma.breakoutLiveAttemptC.deleteMany({
      where: { rangeDate: { lt: utcDate } },
    })
    if (r.count > 0) {
      console.log(`${LOG} pruned ${r.count} attempt(s) from prior UTC days`)
    }
  } catch (e: any) {
    console.warn(`${LOG} pruneOldAttempts failed: ${e.message}`)
  }
}

// ============================================================================
// Placement — pre-emptive limit pairs on rangeEdge (mirrors paper C, but real)
// ============================================================================

/**
 * For each enabled symbol with a formed 3h range today and no live row yet,
 * place ONE pair of LIMIT GTC orders on Binance: BUY @ rangeHigh + SELL @
 * rangeLow. Each placement creates a BreakoutLiveTradeC row with status
 * PENDING_LIMIT and the exchange order id / clientOrderId captured.
 *
 * Sizing is done HERE (at placement time, not at fill) because Binance locks
 * the margin when the order hits the book — we need to know how much qty fits
 * within the available balance and leverage. This differs from paper C where
 * sizing was deferred to fill; for live we can't ask the exchange to "size at
 * fill", and trying to place an order without committed sizing would be racy.
 *
 * Pair linkage: both rows are written first, then pairOrderId is filled into
 * each pointing at the other. Cancel cascade on fill uses this linkage.
 *
 * Idempotency: clientOrderId is deterministic per (net, rangeDate, symbol,
 * side), so even if the cycle runs twice within a day, Binance rejects the
 * second placement with -2014 (duplicate cID) and we don't create a duplicate
 * BreakoutLiveTradeC row.
 */
async function placeLimitsForRanges(
  cfg: any,
  client: BinanceFuturesClient,
  net: 'testnet' | 'prod',
): Promise<void> {
  // Daily circuit breaker. Per user decision 2026-05-17, live C in tripped state:
  //   - Blocks NEW limit placements
  //   - Also CANCELS any still-pending limits on the exchange
  // (Paper C only blocks new — live is stricter for real-money safety.)
  const cb = await isLiveCircuitBreakerTripped(cfg)
  if (cb.tripped) {
    console.warn(`${LOG} ${cb.reason} — blocking new placements + cancelling pending for the rest of UTC day`)
    await cancelAllPendingForBreaker(client, cb.reason)
    // One alert per UTC day — guarded by breakerNotifiedDate at module scope.
    await maybeNotifyBreaker(cb)
    return
  }

  // Same universe + range params as paper variants (single source of truth).
  const dbCfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  if (!dbCfg) return
  const symbols = (dbCfg.symbolsEnabled as string[]).length > 0
    ? dbCfg.symbolsEnabled as string[]
    : DEFAULT_BREAKOUT_SETUPS
  const engineCfg: BreakoutEngineConfig = {
    rangeBars: dbCfg.rangeBars,
    volumeMultiplier: dbCfg.volumeMultiplier,
    tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
  }

  const utcDate = new Date().toISOString().slice(0, 10)
  const todayStartUtc = new Date(`${utcDate}T00:00:00.000Z`)

  // Pull available balance from the WS-driven snapshot. No REST call — the
  // snapshot is updated by ACCOUNT_UPDATE on every fill / TP / SL / funding.
  // getLiveSnapshot() will refresh from REST if older than 5 min, so worst
  // case is one weight=5 call per 5 min instead of every 60s.
  const snap = await getLiveSnapshot()
  if (!snap || snap.available <= 0) {
    console.warn(`${LOG} skip cycle — no balance snapshot or zero USDT`)
    return
  }
  const available = snap.available

  const filters = await getFilters(client)

  for (const symbol of symbols) {
    try {
      // Skip if we already have any C-live row for this symbol today (PENDING,
      // OPEN, CLOSED — doesn't matter, only one pair per symbol per day).
      const existing = await prisma.breakoutLiveTradeC.findFirst({
        where: { symbol, openedAt: { gte: todayStartUtc } },
      })
      if (existing) continue

      // Live C trades on Binance — use Binance klines for range detection so
      // rangeHigh/rangeLow match the order book we're placing limits into.
      // (Paper variants use Bybit historical; live is exchange-aligned.)
      let candles: any[]
      try {
        // Binance USDT-M Futures — many perp-only pairs (FARTCOIN, KAS,
        // USELESS, SIREN, AERO, VVV, 1000BONK, UB, VANA) are not on the spot
        // endpoint at all and would 400 'Invalid symbol'. We trade on futures,
        // klines must come from there too.
        candles = await loadHistorical(symbol, '5m', 1, 'binance-futures')
      } catch (e: any) {
        // Not on Binance for this network (common on testnet for newer pairs),
        // or transient 400. Recorded as one SKIPPED_FILTER per cycle so the
        // user can see why those symbols never show up in Pending.
        console.warn(`${LOG} ${symbol} placement failed: ${e.message}`)
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'klines', reasonText: e.message,
        })
        continue
      }
      const range = detectRange(candles, utcDate, engineCfg)
      if (!range) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'noRange',
          reasonText: 'no 3h range detected for today yet',
        })
        continue
      }

      // SL distance guard — same as engine/paper.
      const slDistPct = (range.rangeSize / Math.min(range.rangeHigh, range.rangeLow)) * 100
      if (slDistPct < 0.4) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'slDist',
          reasonText: `range too tight: ${slDistPct.toFixed(2)}% < 0.4%`,
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }

      const f = filters.get(symbol)
      if (!f) {
        console.warn(`${LOG} ${symbol} — not on Binance Futures, skipping`)
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'noFilter',
          reasonText: 'symbol not on Binance Futures',
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }

      // Virtual placement — DB only, no exchange order. We use markPrice purely
      // to skip the "price already broke out" case (paper wouldn't open either
      // since paper requires `candle.high >= rangeHigh` AFTER placement to fill).
      // We do NOT use it for marketable check — there's no exchange order to be
      // marketable against.
      let livePrice: number | null = null
      try {
        livePrice = await client.getMarkPrice(symbol)
      } catch {
        // markPrice unavailable — proceed anyway. Virtual placement doesn't
        // need price; the only risk is opening past a level that already broke
        // out far. Acceptable on the margin.
      }

      // Hopeless-chase skip: if price is more than 1× rangeSize past either
      // edge, this signal is already burnt — paper wouldn't open either since
      // the breakout candle has already closed beyond the level.
      if (livePrice != null && isFinite(livePrice) && livePrice > 0) {
        if (livePrice > range.rangeHigh + range.rangeSize) {
          await recordAttempt({
            symbol, side: 'BUY', rangeDate: utcDate,
            status: 'SKIPPED_GATE',
            reasonCode: 'farBreakout',
            reasonText: `price ${livePrice} > rangeHigh ${range.rangeHigh} + rangeSize ${range.rangeSize} — already broke out`,
            limitPrice: range.rangeHigh, markPrice: livePrice,
            rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
          })
          continue
        }
        if (livePrice < range.rangeLow - range.rangeSize) {
          await recordAttempt({
            symbol, side: 'SELL', rangeDate: utcDate,
            status: 'SKIPPED_GATE',
            reasonCode: 'farBreakout',
            reasonText: `price ${livePrice} < rangeLow ${range.rangeLow} - rangeSize ${range.rangeSize} — already broke out`,
            limitPrice: range.rangeLow, markPrice: livePrice,
            rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
          })
          continue
        }
      }

      // Set leverage + isolated margin ONCE per symbol per day. Even though
      // there's no order yet, the eventual MARKET fill will use these settings.
      // setLeverage / setMarginType are idempotent (swallow -4046 already-set).
      try {
        await client.setMarginType(symbol, 'ISOLATED')
      } catch (e: any) {
        if (!(e instanceof BinanceApiError) || e.code !== -4046) {
          console.warn(`${LOG} ${symbol} setMarginType failed: ${e.message}`)
        }
      }

      const buyTpLadder = [
        range.rangeHigh + range.rangeSize * engineCfg.tp1Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp2Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp3Mult,
      ]
      const sellTpLadder = [
        range.rangeLow - range.rangeSize * engineCfg.tp1Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp2Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp3Mult,
      ]

      const placedRows: any[] = []
      const placedAt = new Date()

      // Place BUY @ rangeHigh (virtual — DB only)
      const buyRow = await placeOneSide({
        client, net, cfg, f, symbol, side: 'BUY',
        entryPrice: range.rangeHigh, stopLoss: range.rangeLow,
        tpLadder: buyTpLadder, rangeDate: utcDate, placedAt,
        markPrice: livePrice ?? range.rangeHigh,
        rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
      })
      if (buyRow) placedRows.push(buyRow)

      // Place SELL @ rangeLow (virtual — DB only)
      const sellRow = await placeOneSide({
        client, net, cfg, f, symbol, side: 'SELL',
        entryPrice: range.rangeLow, stopLoss: range.rangeHigh,
        tpLadder: sellTpLadder, rangeDate: utcDate, placedAt,
        markPrice: livePrice ?? range.rangeLow,
        rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
      })
      if (sellRow) placedRows.push(sellRow)

      // Link the pair so cancel cascade on fill works (one fill marks the
      // other CANCELLED_OTHER_SIDE in DB — no exchange call needed since the
      // pair is virtual).
      if (placedRows.length === 2) {
        await prisma.breakoutLiveTradeC.update({
          where: { id: placedRows[0].id }, data: { pairOrderId: placedRows[1].id },
        })
        await prisma.breakoutLiveTradeC.update({
          where: { id: placedRows[1].id }, data: { pairOrderId: placedRows[0].id },
        })
      }

      if (placedRows.length > 0) {
        const sides = placedRows.map(r => `${r.side}@${r.limitOrderPrice}`).join(', ')
        const adjusted = filters.get(symbol)?.quantityPrecision
        console.log(`${LOG} ${symbol} placed ${placedRows.length} virtual limit(s) [range ${range.rangeHigh}/${range.rangeLow}, slDist ${slDistPct.toFixed(2)}%, prec ${adjusted}]: ${sides}`)
      }
    } catch (e: any) {
      console.warn(`${LOG} ${symbol} placement failed: ${e.message}`)
    }
  }
}

interface PlaceOneSideArgs {
  client: BinanceFuturesClient
  net: 'testnet' | 'prod'
  cfg: any
  f: SymbolFilter
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  tpLadder: number[]
  rangeDate: string
  placedAt: Date
  // Audit context — passed through so attempt rows have full picture even
  // if the placement fails at a downstream step (sizing, exchange reject).
  markPrice: number
  rangeHigh: number
  rangeLow: number
}

/**
 * Virtual limit — writes a PENDING_LIMIT row to DB. No order is placed on the
 * exchange. The order is filled by the aggTrade WS watcher (tryFillVirtualLimit)
 * which sends MARKET reduceOnly=false when price crosses limitOrderPrice.
 *
 * This mirrors paper C 1:1: paper holds limits in DB and "fills" them when the
 * candle high/low crosses the level. We do the same with WS aggTrade for sub-
 * second latency. The previous design used GTX post-only on the exchange but
 * narrow ranges had book spread overlapping rangeEdge → 99%+ -5022 rejection.
 */
async function placeOneSide(a: PlaceOneSideArgs): Promise<any> {
  // Sizing — uses the configured risk/margin knobs and current balance.
  const sizing = computeSizing({
    symbol: a.symbol,
    deposit: a.cfg.currentDepositUsd,
    riskPct: a.cfg.riskPctPerTrade,
    targetMarginPct: a.cfg.targetMarginPct,
    entry: a.entryPrice,
    sl: a.stopLoss,
  })
  if (!sizing || sizing.positionUnits <= 0) {
    console.warn(`${LOG} ${a.symbol} ${a.side} — sizing failed`)
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'sizing',
      reasonText: 'sizing returned zero units',
      limitPrice: a.entryPrice, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  // Free margin guard. `currentDepositUsd` IS available balance — Binance
  // already subtracted margin locked in OPEN positions from it. So we just
  // compare the new trade's required margin against 90% of available, no
  // need to add existingMargin again (that was a double-count bug pre-2026-05-19).
  //
  // 10% buffer covers: funding fees, exit slippage on existing positions,
  // and the pair-fill race window where both sides could fill before the
  // cancel cascade runs (paper-equivalent worst case).
  const required = sizing.marginUsd
  const budget = a.cfg.currentDepositUsd * 0.90
  if (required > budget) {
    const msg = `new margin ${required.toFixed(2)} > available × 0.9 = ${budget.toFixed(2)} (avail ${a.cfg.currentDepositUsd.toFixed(2)})`
    console.log(`${LOG} ${a.symbol} ${a.side} — skip: ${msg}`)
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'margin', reasonText: msg,
      limitPrice: a.entryPrice, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  const targetLev = Math.max(1, Math.round(sizing.leverage))

  // Round price to tick (limitOrderPrice is the trigger level; we use exactly
  // rangeHigh/rangeLow, no offsets, no spread compensation — mirrors paper).
  const tick = a.f.tickSize
  const priceRounded = a.side === 'BUY'
    ? Math.floor(a.entryPrice / tick) * tick
    : Math.ceil(a.entryPrice / tick) * tick

  // Round qty DOWN to step.
  const step = a.f.stepSize
  let qty = Math.floor(sizing.positionUnits / step) * step
  qty = Number(qty.toFixed(a.f.quantityPrecision))

  const notional = qty * priceRounded
  const minNotional = Math.max(a.f.minNotional || 5, 5) + 1
  if (notional < minNotional || qty < a.f.minQty) {
    const msg = `qty ${qty} × ${priceRounded} = ${notional.toFixed(2)} below minNotional ${minNotional}`
    console.warn(`${LOG} ${a.symbol} ${a.side} — ${msg}`)
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'minNotional', reasonText: msg,
      limitPrice: priceRounded, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  const cid = buildEntryCid(a.net, a.rangeDate, a.symbol, a.side)

  let row: any
  try {
    row = await prisma.breakoutLiveTradeC.create({
      data: {
        signalId: 0,
        symbol: a.symbol,
        side: a.side,
        entryPrice: priceRounded,
        stopLoss: a.stopLoss,
        initialStop: a.stopLoss,
        currentStop: a.stopLoss,
        tpLadder: a.tpLadder as any,
        depositAtEntryUsd: a.cfg.currentDepositUsd,
        riskUsd: sizing.riskUsd,
        positionSizeUsd: priceRounded * qty,
        positionUnits: qty,
        leverage: targetLev,
        marginUsd: (priceRounded * qty) / targetLev,
        status: 'PENDING_LIMIT',
        limitOrderState: 'PENDING_LIMIT',
        limitOrderPrice: priceRounded,
        limitPlacedAt: a.placedAt,
        openedAt: a.placedAt,
        feeTakerPct: a.cfg.feeTakerPct,
        feeMakerPct: a.cfg.feeMakerPct,
        slipTakerPct: a.cfg.slipTakerPct,
        autoTrailingSL: a.cfg.autoTrailingSL,
        binanceClientOrderId: cid,
        // binanceOrderId stays null — entry is filled via MARKET on aggTrade
        // crossing, not via a real LIMIT order on the exchange.
      },
    })
  } catch (e: any) {
    // Duplicate cID — row from prior cycle already exists. Skip silently.
    if (e.code === 'P2002') return null
    throw e
  }

  await recordAttempt({
    symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
    status: 'PLACED',
    reasonCode: null, reasonText: null,
    limitPrice: priceRounded, markPrice: a.markPrice,
    rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
  })

  return row
}

// ============================================================================
// User data WS handlers
// ============================================================================

async function handleUserDataEvent(ev: any): Promise<void> {
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
 * Route an ORDER_TRADE_UPDATE event to the right handler. clientOrderId prefix
 * convention:
 *   - 'enL{tradeId}'           → entry MARKET fill (tryFillVirtualLimit)
 *   - 'exL{tradeId}_{REASON}'  → exit MARKET fill (exitLiveTradeSlice)
 *   - 'slL{tradeId}'           → safety-net STOP_MARKET fired (exchange-driven SL)
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
  if (trade.status !== 'OPEN') return  // not in entry-fill window
  // Idempotency: binanceOrderId is null after the optimistic write and set
  // here. If it's already populated, this event is a replay.
  if (trade.binanceOrderId != null) return

  const exactPrice = Number(o.ap) || Number(o.L) || trade.entryPrice
  const exactQty = Number(o.z) || trade.positionUnits
  const exactFee = Number(o.n) || 0  // commission in USDT (N field gives asset)
  const exchangeOrderId = BigInt(o.i)

  // Compute the fee delta vs the optimistic estimate we already wrote. The
  // estimate ran with feeTakerPct% of (placeholder fillPrice × qty); now we
  // know the real number from Binance. Net effect on netPnlUsd is delta.
  const optimisticFee = trade.positionUnits * trade.entryPrice * ((trade.feeTakerPct ?? 0.04) / 100)
  const feeDelta = exactFee - optimisticFee

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      entryPrice: exactPrice,
      positionUnits: exactQty,
      positionSizeUsd: exactPrice * exactQty,
      marginUsd: trade.leverage ? (exactPrice * exactQty) / trade.leverage : trade.marginUsd,
      feesPaidUsd: { increment: feeDelta },
      netPnlUsd: { decrement: feeDelta },
      binanceOrderId: exchangeOrderId,
    },
  })

  console.log(`${LOG} ↻ entry refined #${tradeId} ${trade.symbol} entry ${trade.entryPrice} → ${exactPrice}, fee ${optimisticFee.toFixed(4)} → ${exactFee.toFixed(4)}`)
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

  const prevFee = (prev as any).feePaidUsd ?? 0
  const prevNetPnl = prev.pnlUsd ?? 0
  const pnlDelta = exactRealizedPnl - prevNetPnl
  const feeDelta = exactFee - prevFee

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
      realizedPnlUsd: { increment: pnlDelta },
      netPnlUsd: { increment: pnlDelta - feeDelta },
      feesPaidUsd: { increment: feeDelta },
    },
  })

  console.log(`${LOG} ↻ exit refined #${tradeId} ${trade.symbol} ${reason} @ ${exactFillPrice} realizedPnl=${exactRealizedPnl.toFixed(4)} fee=${exactFee.toFixed(4)} (delta pnl ${pnlDelta.toFixed(4)} fee ${feeDelta.toFixed(4)})`)
}

/**
 * Cancel the paired entry virtual limit (DB-only — no exchange call). When one
 * side fills, the other side is no longer needed. Atomic — only flips state
 * if still PENDING_LIMIT (skip if already filled or cancelled).
 */
async function cancelPairOrder(pairTradeId: number): Promise<void> {
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

// ============================================================================
// Virtual SL/TP tracking — mirrors paper C, exits via MARKET reduceOnly.
//
// Why virtual instead of real algo orders on the exchange:
// - paper C logic is battle-tested over 2+ weeks of live trading
// - real algo orders need /fapi/v1/algoOrder migration, separate cID space,
//   and immediate-trigger handling when price already past stop
// - one ws layer (aggTrade) drives all exits; one exit path (MARKET reduceOnly)
//
// Each aggTrade tick on a tracked symbol → check if it crosses any
// remaining SL/TP level → if so, send MARKET reduceOnly for the appropriate
// slice and update DB row (currentStop trails, status moves through TP1_HIT
// → TP2_HIT → TP3_HIT or CLOSED/SL_HIT).
// ============================================================================

const SPLITS = [0.5, 0.3, 0.2]  // TP1/TP2/TP3 fractions of position units

// Per-trade in-flight lock — prevents concurrent aggTrade ticks from sending
// two MARKET reduceOnlys for the same level. Keyed by trade.id.
const tradeBusy = new Set<number>()

async function trackLiveTrade(trade: any, price: number, ts: number): Promise<void> {
  if (tradeBusy.has(trade.id)) return  // already processing a tick for this trade
  if (!state) return
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(trade.status)) return

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
  if (!state) return
  // Idempotency: check the row hasn't already been advanced past this reason
  // (e.g. by a slower duplicate tick that beat us to the lock).
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
  if (!fresh) return
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) return
  const freshCloses = ((fresh.closes as any[]) ?? []) as Array<{ reason?: string }>
  if (freshCloses.some((c) => c.reason === reason)) return

  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) return

  const step = f.stepSize
  const closeUnits = fresh.positionUnits * frac
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
  // gets -2022). For TP exits the SL is *not* at this price level — leaving
  // it is fine, retrailSlOnExchange below repositions it after the partial.
  if (reason === 'SL') {
    await cancelSlOnExchange(fresh).catch(() => { /* best-effort */ })
  }
  // Tagged clientOrderId — when ORDER_TRADE_UPDATE arrives for this MARKET,
  // handleExitFillUpdate uses the cid to find the trade row + reason and
  // overwrite the closes[] entry with exact avgPrice + commission.
  const exitCid = `exL${fresh.id}_${reason}`
  try {
    const resp = await state.client.placeOrder({
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

  await applyVirtualClose(fresh, reason, actualFillPrice, frac, pnlR, actualPnlUsd - feePaid, ts, feePaid)
}

async function applyVirtualClose(
  fresh: any,
  reason: 'SL' | 'TP1' | 'TP2' | 'TP3',
  fillPrice: number,
  frac: number,
  pnlR: number,
  netPnl: number,
  ts: number,
  feePaid: number = 0,
): Promise<void> {
  const newCloses = [
    ...((fresh.closes as any[]) ?? []),
    {
      price: fillPrice,
      percent: frac * 100,
      pnlR,
      pnlUsd: netPnl + feePaid,  // gross pnl for reporting; fees split below
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
      realizedPnlUsd: { increment: netPnl + feePaid },
      feesPaidUsd: { increment: feePaid },
      netPnlUsd: { increment: netPnl },
      ...(terminal ? { closedAt: new Date(ts) } : {}),
    },
  })

  // Telegram + trailing console log.
  const emoji = reason === 'SL' ? '🔴' : '✅'
  const trailNote = reason === 'TP1' ? 'SL → BE'
    : reason === 'TP2' ? 'SL → TP1'
    : reason === 'TP3' ? 'позиция закрыта полностью'
    : 'позиция закрыта'
  sendLiveTelegram([
    `${emoji} <b>${fresh.symbol}</b> <b>${reason}</b>  · ${reason === 'SL' ? 'позиция закрыта' : 'частичное закрытие'}`,
    `━━━━━━━━━━━━━━━━━━`,
    `💰 Цена   <code>${fmtPrice(fillPrice)}</code>`,
    `📊 Закрыто  ${Math.round(frac * 100)}%`,
    `💵 P&L    <b>${fmtPnl(netPnl)}</b>`,
    `🛡 ${trailNote}`,
  ].join('\n'))
  console.log(`${LOG} ${emoji} ${reason} hit #${fresh.id} ${fresh.symbol} @ ${fillPrice} pnl ${netPnl.toFixed(4)}`)

  // Sync the exchange-side SL with the new currentStop / position size.
  //  - TP1/TP2: position shrunk + currentStop trailed (BE / TP1) — replace old
  //    STOP_MARKET with a fresh one at the new trigger.
  //  - SL / TP3: position is closed (terminal) — cancel the safety-net SL so
  //    it doesn't dangle on the book.
  if (terminal) {
    await cancelSlOnExchange(fresh).catch(() => { /* best-effort */ })
  } else if (reason === 'TP1' || reason === 'TP2') {
    await retrailSlOnExchange(fresh.id).catch((e) =>
      console.warn(`${LOG} retrailSlOnExchange threw: ${e?.message ?? e}`))
  }

  // Force-refresh balance from REST after any exit. Realized PnL just hit the
  // wallet — without a refresh, sizing/UI keeps reading stale currentDepositUsd
  // until the next 30s tick. One weight=5 call per close.
  if (state) {
    await seedSnapshotFromRest(state.client, state.net, 'rest-refresh').catch((e) =>
      console.warn(`${LOG} post-close balance refresh failed: ${e?.message ?? e}`))
  }
}


// ============================================================================
// Exchange-side SL (hybrid model)
//
// The virtual tracker above (trackLiveTrade) is our primary exit path: it
// watches aggTrade ticks and sends MARKET reduceOnly when price crosses a
// level. It's robust and identical to paper C.
//
// On top of that we *also* place a STOP_MARKET reduceOnly on Binance as a
// safety net for the SL specifically. Rationale:
//
//   - If the bot dies (PM2 restart, VPS reboot, WS disconnect storm) the
//     exchange-side SL still triggers — no naked position.
//   - SL closes via STOP_MARKET cost taker fee anyway (the exit IS a market
//     order once it triggers), so we don't lose on commissions vs the virtual
//     path. Avg slippage is comparable.
//   - TPs stay virtual — trailing requires "cancel old SL + place new SL"
//     after each TP, which is simpler than juggling 3 child orders that all
//     need recalibration.
//
// When the exchange SL fires:
//   - ORDER_TRADE_UPDATE arrives with clientOrderId='slL{tradeId}', X=FILLED
//   - handleSlOrderUpdate() invokes applyVirtualClose(reason='SL') so the DB
//     and Telegram path is exactly the same as a virtual SL hit.
//   - trackLiveTrade is a no-op because the row has already moved to
//     SL_HIT/CLOSED.
//
// When the bot's virtual SL fires first (price crossed currentStop, bot sent
// MARKET reduceOnly before exchange triggered):
//   - exitLiveTradeSlice cancels the exchange SL before sending MARKET (see
//     below), avoiding -2022 ReduceOnly rejected.
//
// Binance migrated STOP_MARKET to the Algo Order API in 2025-12 — the regular
// /fapi/v1/order endpoint returns -4120. So we use placeAlgoOrder. The
// trigger price uses MARK_PRICE (not last trade) to avoid wick-out flashes,
// matching paper-C semantics.
// ============================================================================

type PlaceSlResult = { ok: true; algoId: bigint } | { ok: false; error: string }

async function placeSlOnExchange(trade: any): Promise<PlaceSlResult> {
  if (!state) return { ok: false, error: 'live trader not running' }
  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) return { ok: false, error: `no filter for ${trade.symbol}` }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const tick = f.tickSize
  const triggerPrice = Number((Math.round(trade.currentStop / tick) * tick).toFixed(f.pricePrecision))
  const slClientId = `slL${trade.id}`

  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await state.client.placeAlgoOrder({
        symbol: trade.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        triggerPrice,
        quantity: trade.positionUnits,
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

async function cancelSlOnExchange(trade: any): Promise<void> {
  if (!state) return
  if (!trade.binanceSlOrderId) return
  try {
    await state.client.cancelAlgoOrder(trade.symbol, {
      algoId: Number(trade.binanceSlOrderId),
    })
  } catch (e: any) {
    // -2011 unknown order, -2013 doesn't exist — already gone, fine.
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) return
    console.warn(`${LOG} cancel SL #${trade.id} ${trade.symbol} failed: ${e.message}`)
  }
}

// Place SL after entry fill. Best-effort: on failure we keep the position
// open with a virtual-only SL (trackLiveTrade still owns the exit) and warn
// via Telegram so the operator can intervene.
async function attachSlAfterEntry(tradeId: number): Promise<void> {
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
  } else {
    console.warn(`${LOG} ⚠ SL placement failed for #${tradeId} ${fresh.symbol}: ${r.error} — virtual SL still active`)
    sendLiveTelegram([
      `⚠️ <b>${fresh.symbol}</b> · SL не выставлен на бирже`,
      `━━━━━━━━━━━━━━━━━━`,
      `Причина: <code>${r.error}</code>`,
      `Виртуальный SL продолжает работать (бот закроет MARKET при касании).`,
    ].join('\n'))
  }
}

// Retrail SL on Binance after TP1/TP2 hit. Cancels the old algo order and
// places a fresh STOP_MARKET at the new currentStop level. If anything fails,
// we just clear binanceSlOrderId — virtual tracker owns the exit.
async function retrailSlOnExchange(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh) return
  // Only retrail while position is still open.
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) return

  await cancelSlOnExchange(fresh)
  // Reset stored algoId so attachSlAfterEntry can re-place idempotently.
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
    console.warn(`${LOG} ⚠ SL retrail failed #${tradeId}: ${r.error} — virtual SL still active`)
  }
}

// Handle the case where the exchange SL fires before our virtual tracker
// gets a chance to act. The MARKET fill arrives as a regular order update
// with clientOrderId='slL{tradeId}' (Binance preserves clientAlgoId as the
// resulting fill's clientOrderId per Algo Order docs).
async function handleSlOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return  // we only care about the fill event
  // Position may already be CLOSED if our virtual tracker beat the exchange.
  // Idempotent — applyVirtualClose checks status.
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
  if (!fresh) return
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) return
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
  if (!liveSnapshot) return  // snapshot not yet seeded; first seedSnapshotFromRest will pick this up

  const usdt = ev.a?.B?.find((b) => b.a === 'USDT')
  if (usdt) {
    // wb = wallet balance (post-event); cw = cross wallet balance
    liveSnapshot.total = Number(usdt.wb)
    // Binance doesn't broadcast availableBalance per WS — derive: total minus
    // isolated-margin locked in positions. Close enough for the UI; the next
    // REST refresh (≤5 min) will resync if drift accumulates.
    let isolatedLocked = 0
    for (const p of liveSnapshot.positions) {
      if (p.marginType === 'isolated' && p.positionAmt !== 0) {
        isolatedLocked += Math.abs(p.positionAmt * p.entryPrice) / Math.max(p.leverage, 1)
      }
    }
    liveSnapshot.available = Math.max(0, liveSnapshot.total - isolatedLocked)
  }

  const positionDeltas = ev.a?.P ?? []
  for (const d of positionDeltas) {
    const amt = Number(d.pa)
    const idx = liveSnapshot.positions.findIndex((p) => p.symbol === d.s)
    if (amt === 0) {
      // position closed
      if (idx >= 0) liveSnapshot.positions.splice(idx, 1)
      continue
    }
    const updated = {
      symbol: d.s,
      positionAmt: amt,
      entryPrice: Number(d.ep),
      markPrice: lastMarkPriceWs.get(d.s) ?? Number(d.ep),
      unRealizedProfit: Number(d.up),
      leverage: idx >= 0 ? liveSnapshot.positions[idx].leverage : 1,  // not in event; keep last
      marginType: (d.mt === 'isolated' ? 'isolated' : 'cross') as 'isolated' | 'cross',
    }
    if (idx >= 0) liveSnapshot.positions[idx] = updated
    else liveSnapshot.positions.push(updated)
  }

  liveSnapshot.updatedAt = Date.now()
  liveSnapshot.source = 'ws-account-update'

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
  const positions = ev.a?.P ?? []
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
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
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

// ============================================================================
// Market data WS — aggTrade safety net
// ============================================================================

// Per-symbol freshness ticker — last seen trade ts. Used by the UI / status
// endpoint to indicate which symbols are receiving live data, AND drives
// virtual SL/TP exits — each aggTrade tick on a symbol with open positions
// runs trackLiveTrade() to check if any TP/SL level has been crossed and
// sends MARKET reduceOnly when so. (Entry fills still come from
// ORDER_TRADE_UPDATE on the user-data stream.)
const lastAggTradeAt = new Map<string, number>()

// Per-symbol throttle so a hot symbol (e.g. BTC at 100tps) doesn't hammer
// the DB. 100ms = 10 checks/sec is enough to catch any SL/TP without melting.
const TICK_THROTTLE_MS = 100
const lastTickProcessedAt = new Map<string, number>()

function handleAggTrade(sym: string, price: number, ts: number): void {
  lastAggTradeAt.set(sym, ts)
  lastMarkPriceWs.set(sym, price)

  // Keep the snapshot's per-position markPrice in sync (no DB write — just
  // in-memory). Lets /status return current mark without a REST hit.
  if (liveSnapshot) {
    const pos = liveSnapshot.positions.find((p) => p.symbol === sym)
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
        status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] },
      },
    })
    for (const t of openTrades) {
      await trackLiveTrade(t, price, ts)
    }
  } catch (e: any) {
    console.warn(`${LOG} aggTrade tracker ${sym} threw: ${e.message}`)
  }
}

// Per-trade fill lock — prevents two aggTrade ticks racing on the same PENDING.
const fillBusy = new Set<number>()

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
  if (!state) return

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

    const filters = await getFilters(state.client)
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
      await state.client.setLeverage(trade.symbol, newLev)
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
    let feePaid = 0
    const entryCid = `enL${trade.id}`
    try {
      const resp = await state.client.placeOrder({
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
      // Best-effort fee estimate; replaced by exact value when WS event arrives.
      feePaid = fillQty * fillPrice * (cfg.feeTakerPct ?? 0.04) / 100
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
    await prisma.breakoutLiveTradeC.update({
      where: { id: trade.id },
      data: {
        status: 'OPEN',
        limitOrderState: 'FILLED',
        limitFilledAt: fillTime,
        openedAt: fillTime,
        entryPrice: fillPrice,
        positionUnits: fillQty,
        positionSizeUsd: fillPrice * fillQty,
        depositAtEntryUsd: cfg.currentDepositUsd,
        riskUsd: sizing.riskUsd,
        leverage: newLev,
        marginUsd: (fillPrice * fillQty) / newLev,
        feesPaidUsd: { increment: feePaid },
        netPnlUsd: { decrement: feePaid },
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

    // Refresh balance — fee was just charged, margin was just locked, next
    // sizing cycle needs accurate currentDepositUsd.
    if (state) {
      await seedSnapshotFromRest(state.client, state.net, 'rest-refresh').catch((e) =>
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
async function refreshAggTradeSubscriptions(): Promise<void> {
  if (!state) return
  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { limitOrderState: 'PENDING_LIMIT' },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      ],
    },
    select: { symbol: true },
  })
  const symbols = Array.from(new Set(rows.map((r) => r.symbol)))
  state.marketDataWs.setSubscriptions(symbols)
}
