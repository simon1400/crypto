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
import { fetchPricesBatch } from './market'
import { computeSizing } from './marginGuard'
import { DEFAULT_BREAKOUT_SETUPS } from './dailyBreakoutLiveScanner'
import { refreshLiveBalance } from '../routes/_liveBalanceShared'

const LOG = '[BreakoutLiveC]'

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

    // Slow tick — every 5 min, mirrors paper C cycle (placement + safety net).
    const tickTimer = setInterval(() => {
      runLiveCycle().catch((e) => console.error(`${LOG} cycle error:`, e.message))
    }, 5 * 60 * 1000)

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
      // 1. Cancel SL + TP children so they don't fire after we market-close.
      await cancelRemainingChildren(t.id, reason)

      // 2. Compute remaining qty (units not yet closed by partial TPs).
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
  return { closed, failed }
}

/**
 * Cancel any BreakoutLiveTradeC rows still PENDING_LIMIT from before today's
 * UTC midnight — both in DB and on the exchange. Defensive cleanup so the
 * book doesn't accumulate stale limits across restarts/EOD failures.
 */
async function cancelOrphanPendingLimits(): Promise<void> {
  if (!state) return
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const orphans = await prisma.breakoutLiveTradeC.findMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      limitPlacedAt: { lt: todayStart },
    },
  })
  if (orphans.length === 0) return

  for (const o of orphans) {
    try {
      if (o.binanceClientOrderId) {
        await state.client.cancelOrder(o.symbol, { origClientOrderId: o.binanceClientOrderId })
      }
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} orphan cancel ${o.symbol} failed: ${e.message}`)
      }
    }
    await prisma.breakoutLiveTradeC.update({
      where: { id: o.id },
      data: {
        limitOrderState: 'CANCELLED_EOD',
        status: 'EXPIRED',
        closedAt: new Date(),
      },
    })
  }
  console.log(`${LOG} cancelled ${orphans.length} orphan PENDING_LIMIT from prior days`)
}

// Exposed for the kill-switch route (POST /api/breakout-live-c/kill-switch).
export async function flattenAllOpenLiveC(reason: string): Promise<{ closed: number; failed: number }> {
  return flattenAllOpenC(reason)
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
    missingOrdersForDbPending: number
    missingPositionsForDbOpen: number
  }
}

/**
 * Compare DB BreakoutLiveTradeC rows against the exchange. Used at startup to
 * detect drift caused by:
 *   - Process down while orders filled/expired (orders don't match DB state)
 *   - Manual trading on the same account (positions/orders we never placed)
 *   - Successful EOD flatten right before restart (positions gone, DB rows
 *     not yet marked CLOSED in some edge cases)
 *
 * Policy:
 *   - Our PENDING_LIMIT with no matching exchange order → fetch via getOrder()
 *     to learn the final state, update DB accordingly.
 *   - Our OPEN with no matching exchange position → mark CLOSED (filled by
 *     SL/TP while we were down); exact P&L will be reconciled later.
 *   - Exchange position/order without matching DB row → flag as untracked,
 *     caller decides what to do.
 */
async function reconcileWithExchange(client: BinanceFuturesClient): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    hasUntrackedPositions: false,
    hasUntrackedOrders: false,
    summary: '',
    details: {
      untrackedPositions: [],
      untrackedOrders: [],
      missingOrdersForDbPending: 0,
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
  const dbPending = await prisma.breakoutLiveTradeC.findMany({
    where: { limitOrderState: 'PENDING_LIMIT' },
  })
  const dbOpen = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })

  // Index exchange data for fast lookup.
  const orderIdsOnExchange = new Set<number>()
  const cidsOnExchange = new Set<string>()
  for (const o of openOrders) {
    orderIdsOnExchange.add(o.orderId)
    if (o.clientOrderId) cidsOnExchange.add(o.clientOrderId)
  }
  const positionsBySymbol = new Map<string, number>()
  for (const p of positions) {
    positionsBySymbol.set(p.symbol, Number(p.positionAmt))
  }

  // --- DB PENDING_LIMIT vs exchange openOrders ---
  // Our DB says PENDING. If exchange has no matching openOrder, find out what
  // happened via getOrder() (FILLED, CANCELED, EXPIRED).
  for (const t of dbPending) {
    if (!t.binanceClientOrderId || !t.binanceOrderId) continue
    if (orderIdsOnExchange.has(Number(t.binanceOrderId))) continue  // still pending — fine

    report.details.missingOrdersForDbPending++
    try {
      const o = await client.getOrder(t.symbol, { orderId: Number(t.binanceOrderId) })
      if (o.status === 'FILLED') {
        // Late fill — we missed the WS event. Synthesize one so the fill
        // handler runs (places SL/TPs, cancels pair). Note: WS would normally
        // deliver this; for safety we mark FILLED via direct DB update.
        const fillPrice = Number(o.avgPrice) || t.entryPrice
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: {
            status: 'OPEN',
            limitOrderState: 'FILLED',
            limitFilledAt: new Date(),
            entryPrice: fillPrice,
            positionUnits: Number(o.executedQty) || t.positionUnits,
            positionSizeUsd: fillPrice * (Number(o.executedQty) || t.positionUnits),
          },
        })
        // Place SL+TPs that the WS-driven handler would have placed. Pair
        // cancel: best-effort (if pair filled too, we'll catch on next loop).
        if (t.pairOrderId) await cancelPairOrder(t.pairOrderId).catch(() => { /* noop */ })
        await placeSlAndTpsForTrade(t.id).catch((e) => {
          console.warn(`${LOG} reconcile: post-fill SL/TP placement failed for #${t.id}: ${e.message}`)
        })
        console.log(`${LOG} reconcile: #${t.id} ${t.symbol} late FILL detected, recovered`)
      } else if (o.status === 'CANCELED' || o.status === 'EXPIRED') {
        await prisma.breakoutLiveTradeC.update({
          where: { id: t.id },
          data: {
            limitOrderState: o.status === 'EXPIRED' ? 'CANCELLED_EOD' : 'CANCELLED_OTHER_SIDE',
            status: 'CANCELLED',
            closedAt: new Date(),
          },
        })
        console.log(`${LOG} reconcile: #${t.id} ${t.symbol} ${o.status} — finalized`)
      }
      // else: NEW/PARTIALLY_FILLED — orderIdsOnExchange should've caught it,
      // weird race; leave alone for next cycle to retry.
    } catch (e: any) {
      console.warn(`${LOG} reconcile: getOrder for #${t.id} ${t.symbol} failed: ${e.message}`)
    }
  }

  // --- DB OPEN vs exchange positions ---
  // Our DB says we're in a position. If exchange has zero amt for the symbol,
  // SL or TP fully closed it while we were down.
  for (const t of dbOpen) {
    const exchangeAmt = positionsBySymbol.get(t.symbol)
    if (exchangeAmt && exchangeAmt !== 0) continue  // position still there — fine

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

  // --- Exchange orders without DB row ---
  // Our orders use cID prefix 'cL'. Anything else is foreign (manual, other
  // bot, leftover from test placement, etc.).
  const dbCidsKnown = new Set<string>()
  for (const t of [...dbPending, ...dbOpen]) {
    if (t.binanceClientOrderId) dbCidsKnown.add(t.binanceClientOrderId)
  }
  for (const o of openOrders) {
    if (!o.clientOrderId?.startsWith('cL')) continue  // not ours by cID convention
    if (dbCidsKnown.has(o.clientOrderId)) continue
    report.details.untrackedOrders.push({
      symbol: o.symbol, orderId: o.orderId, cid: o.clientOrderId, type: o.type,
    })
    report.hasUntrackedOrders = true
  }

  // Build human-readable summary for the kill-switch reason.
  const parts: string[] = []
  if (report.details.untrackedPositions.length > 0) {
    parts.push(`${report.details.untrackedPositions.length} untracked position(s): ${report.details.untrackedPositions.map((p) => `${p.symbol}=${p.amt}`).join(', ')}`)
  }
  if (report.details.untrackedOrders.length > 0) {
    parts.push(`${report.details.untrackedOrders.length} untracked order(s)`)
  }
  if (report.details.missingOrdersForDbPending > 0) {
    parts.push(`${report.details.missingOrdersForDbPending} PENDING resolved from exchange`)
  }
  if (report.details.missingPositionsForDbOpen > 0) {
    parts.push(`${report.details.missingPositionsForDbOpen} OPEN reconciled to closed`)
  }
  report.summary = parts.join('; ') || 'no drift'
  console.log(`${LOG} reconcile: ${report.summary}`)

  return report
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

  // Fresh balance snapshot for sizing — pulled once per cycle, all symbols share it.
  let available: number
  try {
    const bal = await refreshLiveBalance(client)
    available = bal.available
  } catch (e: any) {
    console.warn(`${LOG} skip cycle — balance fetch failed: ${e.message}`)
    return
  }
  if (available <= 0) {
    console.warn(`${LOG} skip cycle — zero available USDT`)
    return
  }

  const filters = await getFilters(client)

  for (const symbol of symbols) {
    try {
      // Skip if we already have any C-live row for this symbol today (PENDING,
      // OPEN, CLOSED — doesn't matter, only one pair per symbol per day).
      const existing = await prisma.breakoutLiveTradeC.findFirst({
        where: { symbol, openedAt: { gte: todayStartUtc } },
      })
      if (existing) continue

      const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
      const range = detectRange(candles, utcDate, engineCfg)
      if (!range) continue

      // SL distance guard — same as engine/paper.
      const slDistPct = (range.rangeSize / Math.min(range.rangeHigh, range.rangeLow)) * 100
      if (slDistPct < 0.4) continue

      let livePrice: number | null = null
      try {
        const prices = await fetchPricesBatch([symbol])
        const live = prices[symbol]
        if (live && live > 0) livePrice = live
      } catch { /* ok — place both sides if live price unknown */ }

      const canPlaceBuy = livePrice == null || livePrice <= range.rangeHigh
      const canPlaceSell = livePrice == null || livePrice >= range.rangeLow
      if (!canPlaceBuy && !canPlaceSell) continue

      const f = filters.get(symbol)
      if (!f) {
        console.warn(`${LOG} ${symbol} — not on Binance Futures, skipping`)
        continue
      }

      // Ensure leverage + margin type per symbol. Idempotent: setMarginType
      // swallows -4046 (already isolated), setLeverage just returns ok if same.
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

      // Place BUY @ rangeHigh
      if (canPlaceBuy) {
        const row = await placeOneSide({
          client, net, cfg, f, symbol, side: 'BUY',
          entryPrice: range.rangeHigh, stopLoss: range.rangeLow,
          tpLadder: buyTpLadder, rangeDate: utcDate, placedAt,
        })
        if (row) placedRows.push(row)
      }

      // Place SELL @ rangeLow
      if (canPlaceSell) {
        const row = await placeOneSide({
          client, net, cfg, f, symbol, side: 'SELL',
          entryPrice: range.rangeLow, stopLoss: range.rangeHigh,
          tpLadder: sellTpLadder, rangeDate: utcDate, placedAt,
        })
        if (row) placedRows.push(row)
      }

      // Link the pair so cancel cascade on fill works (one fill triggers cancel
      // of the other via REST DELETE).
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
        console.log(`${LOG} ${symbol} placed ${placedRows.length} limit(s) [range ${range.rangeHigh}/${range.rangeLow}, slDist ${slDistPct.toFixed(2)}%, prec ${adjusted}]: ${sides}`)
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
}

/**
 * Single-side placement helper. Computes sizing, rounds to tick/step, places
 * the LIMIT order on Binance, and writes a PENDING_LIMIT row with the captured
 * exchange identifiers. Returns the row or null if placement was rejected.
 */
async function placeOneSide(a: PlaceOneSideArgs): Promise<any> {
  // Sizing — uses the configured risk/margin knobs and current balance.
  // Balance has already been refreshed for this cycle (passed into the cfg by
  // refreshLiveBalance via currentDepositUsd cache).
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
    return null
  }

  // Apply requested leverage. Cap at the exchange's maxLeverage for this
  // symbol — Binance rejects setLeverage above tier limits, and we'd rather
  // size down than have the placement fail. setLeverage is idempotent.
  const targetLev = Math.max(1, Math.round(sizing.leverage))
  try {
    await a.client.setLeverage(a.symbol, targetLev)
  } catch (e: any) {
    console.warn(`${LOG} ${a.symbol} setLeverage(${targetLev}) failed: ${e.message} — placement may use exchange default`)
  }

  // Round price to tick. For maker BUY we want price <= target (won't cross);
  // for maker SELL price >= target. Binance LIMIT GTC sits in the book and
  // pays maker fee on fill.
  const tick = a.f.tickSize
  const priceRounded = a.side === 'BUY'
    ? Math.floor(a.entryPrice / tick) * tick
    : Math.ceil(a.entryPrice / tick) * tick

  // Round qty DOWN to step (Binance rejects qty above step granularity).
  const step = a.f.stepSize
  let qty = Math.floor(sizing.positionUnits / step) * step
  qty = Number(qty.toFixed(a.f.quantityPrecision))

  // Enforce min notional with $1 margin above the published floor (some testnet
  // pairs enforce a stricter floor than the filter advertises).
  const notional = qty * priceRounded
  const minNotional = Math.max(a.f.minNotional || 5, 5) + 1
  if (notional < minNotional || qty < a.f.minQty) {
    console.warn(`${LOG} ${a.symbol} ${a.side} — qty ${qty} × ${priceRounded} = ${notional.toFixed(2)} below minNotional ${minNotional}`)
    return null
  }

  const cid = buildEntryCid(a.net, a.rangeDate, a.symbol, a.side)

  let orderId: number
  let exchangePrice: number
  let exchangeQty: number
  try {
    const order = await a.client.placeOrder({
      symbol: a.symbol,
      side: a.side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: qty,
      price: Number(priceRounded.toFixed(a.f.pricePrecision)),
      newClientOrderId: cid,
    })
    orderId = order.orderId
    exchangePrice = Number(order.price)
    exchangeQty = Number(order.origQty)
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2014) {
      // Duplicate cID — order from a prior tick already exists. Skip silently.
      return null
    }
    console.warn(`${LOG} ${a.symbol} ${a.side} placement REJECTED: ${e.message}`)
    return null
  }

  // Persist row. signalId=0 because pre-emptive — no upstream BreakoutSignal
  // when we place (scanner creates one later on actual breakout, see paper C).
  const row = await prisma.breakoutLiveTradeC.create({
    data: {
      signalId: 0,
      symbol: a.symbol,
      side: a.side,
      entryPrice: exchangePrice,
      stopLoss: a.stopLoss,
      initialStop: a.stopLoss,
      currentStop: a.stopLoss,
      tpLadder: a.tpLadder as any,
      depositAtEntryUsd: a.cfg.currentDepositUsd,
      riskUsd: sizing.riskUsd,
      positionSizeUsd: exchangePrice * exchangeQty,
      positionUnits: exchangeQty,
      leverage: targetLev,
      marginUsd: (exchangePrice * exchangeQty) / targetLev,
      status: 'PENDING_LIMIT',
      limitOrderState: 'PENDING_LIMIT',
      limitOrderPrice: exchangePrice,
      limitPlacedAt: a.placedAt,
      openedAt: a.placedAt,
      feeTakerPct: a.cfg.feeTakerPct,
      feeMakerPct: a.cfg.feeMakerPct,
      slipTakerPct: a.cfg.slipTakerPct,
      autoTrailingSL: a.cfg.autoTrailingSL,
      binanceClientOrderId: cid,
      binanceOrderId: BigInt(orderId),
    },
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
 * Route an ORDER_TRADE_UPDATE event to the right handler based on which trade
 * row owns the order. Three categories:
 *   1. Entry limit (binanceClientOrderId or binanceOrderId match)
 *   2. SL child (binanceSlOrderId match)
 *   3. TP child (binanceTpOrderIds array contains the orderId)
 *
 * We use clientOrderId where possible (text, deterministic) and fall back to
 * orderId (numeric, exchange-assigned) for children since we don't generate
 * cIDs for SL/TP children — Binance assigns them.
 */
async function handleOrderUpdate(ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  const cid = o.c
  const orderId = o.i
  const execStatus = o.X // NEW / PARTIALLY_FILLED / FILLED / CANCELED / EXPIRED

  // 1. Entry limit — match by clientOrderId (deterministic).
  if (cid && cid.startsWith('cL')) {
    const trade = await prisma.breakoutLiveTradeC.findUnique({
      where: { binanceClientOrderId: cid },
    })
    if (trade) {
      await handleEntryOrderUpdate(trade, ev)
      return
    }
  }

  // 2. SL child — match by binanceSlOrderId.
  const tradeBySl = await prisma.breakoutLiveTradeC.findFirst({
    where: { binanceSlOrderId: BigInt(orderId) },
  })
  if (tradeBySl) {
    await handleSlOrderUpdate(tradeBySl, ev)
    return
  }

  // 3. TP child — orderId stored in tpOrderIds JSON array.
  const tradeByTp = await prisma.breakoutLiveTradeC.findFirst({
    where: {
      binanceTpOrderIds: { array_contains: String(orderId) as any },
    },
  })
  if (tradeByTp) {
    await handleTpOrderUpdate(tradeByTp, ev)
    return
  }

  // Order doesn't belong to any tracked trade — could be manual, or a stale
  // event for a row we've already finalized. Log only on actual fills.
  if (execStatus === 'FILLED') {
    console.log(`${LOG} untracked FILLED order cid=${cid} id=${orderId} ${o.s} — manual or already reconciled`)
  }
}

/**
 * Handle update for the entry LIMIT order. We care primarily about FILLED
 * (mark trade OPEN, cancel pair, place SL+TPs) and CANCELED/EXPIRED (mark
 * trade as cancelled if it never filled).
 */
async function handleEntryOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  const X = o.X

  if (X === 'FILLED') {
    // Idempotency: if we've already processed this fill (status moved past
    // PENDING_LIMIT), don't re-place children. Binance can deliver the same
    // event twice on reconnects.
    if (trade.limitOrderState !== 'PENDING_LIMIT') {
      return
    }

    const fillPrice = Number(o.ap) || Number(o.L) || trade.entryPrice
    const fillTime = new Date(o.T || ev.E)
    const cumQty = Number(o.z) || trade.positionUnits
    const feePaid = Number(o.n) || 0

    // Atomic claim — flip PENDING_LIMIT → FILLING, then to OPEN. Without this,
    // a duplicate WS event could double-place TP/SL children.
    const claim = await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'PENDING_LIMIT' },
      data: { limitOrderState: 'FILLING' },
    })
    if (claim.count !== 1) return  // someone else handling

    try {
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          status: 'OPEN',
          limitOrderState: 'FILLED',
          limitFilledAt: fillTime,
          openedAt: fillTime,
          entryPrice: fillPrice,
          positionUnits: cumQty,
          positionSizeUsd: fillPrice * cumQty,
          feesPaidUsd: { increment: feePaid },
          netPnlUsd: { decrement: feePaid },
        },
      })

      console.log(`${LOG} ✓ entry filled #${trade.id} ${trade.symbol} ${trade.side} @ ${fillPrice} qty ${cumQty}`)

      // Cancel the pair limit (if any) — one side filled, other no longer needed.
      // Best-effort: if cancel fails (e.g. already filled itself), surface but don't crash.
      if (trade.pairOrderId) {
        await cancelPairOrder(trade.pairOrderId)
      }

      // Place SL + TPs as reduceOnly children.
      await placeSlAndTpsForTrade(trade.id)
    } catch (e: any) {
      console.error(`${LOG} entry fill handler failed for #${trade.id}: ${e.message}`)
      // Try to rollback claim so next event can retry.
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      }).catch(() => { /* noop */ })
    }
    return
  }

  if (X === 'CANCELED' || X === 'EXPIRED') {
    // Only finalize if we haven't already (cancel cascade from pair fill may
    // have moved us to CANCELLED_OTHER_SIDE already).
    if (trade.limitOrderState === 'PENDING_LIMIT') {
      const reason = X === 'EXPIRED' ? 'CANCELLED_EOD' : 'CANCELLED_OTHER_SIDE'
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: reason,
          status: 'CANCELLED',
          closedAt: new Date(),
        },
      })
      console.log(`${LOG} entry ${X.toLowerCase()} #${trade.id} ${trade.symbol} ${trade.side}`)
    }
    return
  }
}

/**
 * Cancel the paired entry LIMIT order on Binance. Uses the live trader's
 * client (state.client) — caller should ensure state is set.
 */
async function cancelPairOrder(pairTradeId: number): Promise<void> {
  if (!state) return
  const pair = await prisma.breakoutLiveTradeC.findUnique({ where: { id: pairTradeId } })
  if (!pair || pair.limitOrderState !== 'PENDING_LIMIT') return  // already gone or filled

  try {
    await state.client.cancelOrder(pair.symbol, {
      origClientOrderId: pair.binanceClientOrderId ?? undefined,
    })
    // WS will deliver the CANCELED event which finalizes the row; but we mark
    // it now optimistically so the UI catches up immediately.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: pairTradeId, limitOrderState: 'PENDING_LIMIT' },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: new Date(),
      },
    })
    console.log(`${LOG} cancelled pair #${pairTradeId} ${pair.symbol} ${pair.side}`)
  } catch (e: any) {
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) {
      // -2011 unknown order (already cancelled), -2013 order does not exist — ok
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: pairTradeId, limitOrderState: 'PENDING_LIMIT' },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(),
        },
      })
      return
    }
    console.warn(`${LOG} cancel pair #${pairTradeId} failed: ${e.message}`)
  }
}

/**
 * After an entry fills, place the four reduceOnly children on Binance:
 *   - STOP_MARKET on stopLoss (SL)
 *   - 3× TAKE_PROFIT_MARKET on tpLadder (TP1/TP2/TP3), split 50/30/20
 *
 * Splits are notional-proportional in qty terms with step-size rounding.
 * Any leftover qty from rounding goes to TP3 so we don't leave dust on the
 * book unmonitored.
 */
async function placeSlAndTpsForTrade(tradeId: number): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade || trade.status !== 'OPEN') return

  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) {
    console.warn(`${LOG} #${tradeId} cannot place SL/TPs — no filter for ${trade.symbol}`)
    return
  }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const totalQty = trade.positionUnits

  // Split 50/30/20 with step-size rounding. Last bucket absorbs the remainder.
  const step = f.stepSize
  let tp1Qty = Math.floor((totalQty * 0.5) / step) * step
  let tp2Qty = Math.floor((totalQty * 0.3) / step) * step
  let tp3Qty = totalQty - tp1Qty - tp2Qty  // remainder
  // Round tp3Qty down to step to keep all qty grids aligned.
  tp3Qty = Math.floor(tp3Qty / step) * step
  tp1Qty = Number(tp1Qty.toFixed(f.quantityPrecision))
  tp2Qty = Number(tp2Qty.toFixed(f.quantityPrecision))
  tp3Qty = Number(tp3Qty.toFixed(f.quantityPrecision))

  const tpLadder = trade.tpLadder as number[]
  const tick = f.tickSize
  const roundStop = (p: number): number => Math.round(p / tick) * tick

  // SL — STOP_MARKET reduceOnly, closePosition=false (we explicitly set qty).
  // Using stopPrice = trade.currentStop (initially equals stopLoss).
  let slOrderId: bigint | null = null
  try {
    const slOrder = await state.client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: Number(roundStop(trade.currentStop).toFixed(f.pricePrecision)),
      quantity: totalQty,
      reduceOnly: true,
      workingType: 'MARK_PRICE',
    })
    slOrderId = BigInt(slOrder.orderId)
  } catch (e: any) {
    console.error(`${LOG} #${tradeId} SL placement failed: ${e.message}`)
  }

  // TPs — TAKE_PROFIT_MARKET reduceOnly, one per ladder level.
  const tpOrderIds: string[] = []
  const tpBuckets = [
    { price: tpLadder[0], qty: tp1Qty },
    { price: tpLadder[1], qty: tp2Qty },
    { price: tpLadder[2], qty: tp3Qty },
  ]
  for (let i = 0; i < tpBuckets.length; i++) {
    const bucket = tpBuckets[i]
    if (bucket.qty <= 0) continue
    try {
      const tpOrder = await state.client.placeOrder({
        symbol: trade.symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: Number(roundStop(bucket.price).toFixed(f.pricePrecision)),
        quantity: bucket.qty,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
      })
      tpOrderIds.push(String(tpOrder.orderId))
    } catch (e: any) {
      console.error(`${LOG} #${tradeId} TP${i + 1} placement failed: ${e.message}`)
    }
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      binanceSlOrderId: slOrderId,
      binanceTpOrderIds: tpOrderIds as any,
    },
  })
  console.log(`${LOG} #${tradeId} ${trade.symbol} children placed: SL=${slOrderId} TPs=${tpOrderIds.length}`)
}

/**
 * Handle SL order update — when STOP_MARKET fills, position is fully closed
 * (or partially if SL trailed up after TP1/TP2 and only the trailing slice
 * triggered). Records close and finalizes if no remaining qty.
 */
async function handleSlOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return  // ignore intermediate NEW/CANCELED

  const fillPrice = Number(o.ap) || Number(o.L) || trade.currentStop
  const fillQty = Number(o.z) || trade.positionUnits
  const realizedPnl = Number(o.rp) || 0
  const feePaid = Number(o.n) || 0
  const fillTime = new Date(o.T || ev.E)

  const closesArr = ((trade.closes as any[]) ?? []).slice()
  const totalClosedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0)
  const remainingPct = Math.max(0, 100 - totalClosedFrac)

  closesArr.push({
    price: fillPrice,
    percent: remainingPct,
    pnlUsd: realizedPnl,
    closedAt: fillTime.toISOString(),
    reason: 'SL',
  })

  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      closes: closesArr as any,
      realizedPnlUsd: { increment: realizedPnl },
      feesPaidUsd: { increment: feePaid },
      netPnlUsd: { increment: realizedPnl - feePaid },
      status: 'SL_HIT',
      closedAt: fillTime,
    },
  })

  // Cancel any remaining TP children so they don't fire and reopen exposure.
  await cancelRemainingChildren(trade.id, 'sl filled')

  console.log(`${LOG} ✗ SL hit #${trade.id} ${trade.symbol} @ ${fillPrice} pnl ${realizedPnl.toFixed(4)}`)
}

/**
 * Handle TP order update — when TAKE_PROFIT_MARKET fills, record partial close
 * and trail the SL: TP1 → SL to entry (BE), TP2 → SL to TP1.
 * After TP3 the position is fully out — cancel SL.
 */
async function handleTpOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return

  const fillPrice = Number(o.ap) || Number(o.L)
  const fillQty = Number(o.z) || 0
  const realizedPnl = Number(o.rp) || 0
  const feePaid = Number(o.n) || 0
  const fillTime = new Date(o.T || ev.E)

  // Figure out which TP this was (1/2/3) by matching orderId against the array.
  const tpIds = (trade.binanceTpOrderIds as string[]) ?? []
  const tpIndex = tpIds.indexOf(String(o.i))
  if (tpIndex === -1) {
    console.warn(`${LOG} TP fill for #${trade.id} but orderId ${o.i} not in tpOrderIds — drift`)
    return
  }
  const tpLabel = `TP${tpIndex + 1}`

  // Idempotency — don't double-record same TP.
  const closesArr = ((trade.closes as any[]) ?? []).slice()
  if (closesArr.some((c: any) => c.reason === tpLabel)) return

  // Calculate percent share of this TP (50/30/20 nominal). Use actual fillQty /
  // positionUnits in case rounding made it different.
  const percent = trade.positionUnits > 0
    ? Math.round((fillQty / trade.positionUnits) * 100)
    : (tpIndex === 0 ? 50 : tpIndex === 1 ? 30 : 20)

  closesArr.push({
    price: fillPrice,
    percent,
    pnlUsd: realizedPnl,
    closedAt: fillTime.toISOString(),
    reason: tpLabel,
  })

  // Trailing SL: after TP1 → SL to entry; after TP2 → SL to TP1 level.
  const tpLadder = trade.tpLadder as number[]
  let newStop = trade.currentStop
  let newStatus = trade.status
  if (tpIndex === 0) {
    newStop = trade.entryPrice  // BE
    newStatus = 'TP1_HIT'
  } else if (tpIndex === 1) {
    newStop = tpLadder[0]  // TP1 level
    newStatus = 'TP2_HIT'
  } else if (tpIndex === 2) {
    // TP3 — position fully out. Mark CLOSED, cancel any remaining children.
    newStatus = 'TP3_HIT'
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      closes: closesArr as any,
      realizedR: { increment: tpIndex === 0 ? 0.5 : tpIndex === 1 ? 0.6 : 0.6 }, // 50% × 1R, 30% × 2R, 20% × 3R
      realizedPnlUsd: { increment: realizedPnl },
      feesPaidUsd: { increment: feePaid },
      netPnlUsd: { increment: realizedPnl - feePaid },
      currentStop: newStop,
      status: newStatus,
      ...(tpIndex === 2 ? { closedAt: fillTime } : {}),
    },
  })

  console.log(`${LOG} ✓ ${tpLabel} hit #${trade.id} ${trade.symbol} @ ${fillPrice} pnl ${realizedPnl.toFixed(4)} → SL to ${newStop}`)

  if (tpIndex === 2) {
    // Full exit — cancel SL (no remaining qty for it to close).
    await cancelRemainingChildren(trade.id, 'tp3 filled')
  } else {
    // Trailing: replace the SL order at the new stop level.
    await replaceSlOrder(trade.id, newStop)
  }
}

/**
 * Replace the existing SL STOP_MARKET with a new one at a different stopPrice
 * (trailing). Cancels the old one first, places new, updates binanceSlOrderId.
 */
async function replaceSlOrder(tradeId: number, newStopPrice: number): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return

  // Compute remaining qty (positionUnits - already closed).
  const closesArr = ((trade.closes as any[]) ?? [])
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingQty = trade.positionUnits * (1 - closedFrac)
  if (remainingQty <= 0) return

  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) return

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) return

  const tick = f.tickSize
  const stopPriceRounded = Math.round(newStopPrice / tick) * tick

  // Cancel old SL (best-effort).
  if (trade.binanceSlOrderId) {
    try {
      await state.client.cancelOrder(trade.symbol, { orderId: Number(trade.binanceSlOrderId) })
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} #${tradeId} cancel old SL failed: ${e.message}`)
      }
    }
  }

  // Place new SL at trailing stop.
  let newSlOrderId: bigint | null = null
  try {
    const order = await state.client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: Number(stopPriceRounded.toFixed(f.pricePrecision)),
      quantity: qty,
      reduceOnly: true,
      workingType: 'MARK_PRICE',
    })
    newSlOrderId = BigInt(order.orderId)
  } catch (e: any) {
    console.error(`${LOG} #${tradeId} replace SL failed at ${stopPriceRounded}: ${e.message}`)
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      binanceSlOrderId: newSlOrderId,
      currentStop: stopPriceRounded,
    },
  })
}

/**
 * Cancel any still-open SL/TP children for a trade. Used when the trade is
 * fully closed (SL hit or TP3 hit) so leftover orders don't sit on the book
 * waiting to fire on a stale stop level.
 */
async function cancelRemainingChildren(tradeId: number, reason: string): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return

  const toCancel: Array<{ id: number; kind: string }> = []
  if (trade.binanceSlOrderId) toCancel.push({ id: Number(trade.binanceSlOrderId), kind: 'SL' })
  for (const tpIdStr of ((trade.binanceTpOrderIds as string[]) ?? [])) {
    toCancel.push({ id: Number(tpIdStr), kind: 'TP' })
  }

  for (const c of toCancel) {
    try {
      await state.client.cancelOrder(trade.symbol, { orderId: c.id })
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        // -2011 / -2013: already cancelled or doesn't exist — ok.
        console.warn(`${LOG} #${tradeId} cancel ${c.kind} ${c.id} failed: ${e.message}`)
      }
    }
  }
  console.log(`${LOG} #${tradeId} ${trade.symbol} cancelled ${toCancel.length} children (${reason})`)
}

async function handleAccountUpdate(ev: AccountUpdateEvent): Promise<void> {
  // FUNDING_FEE → log to BreakoutLiveFundingC. Binance posts funding every
  // 8h (00:00, 08:00, 16:00 UTC) for every open perp position; the event's
  // 'a.B' deltas contain the actual USDT amount charged/credited.
  if (ev.a?.m === 'FUNDING_FEE') {
    await logFundingFromEvent(ev)
    return
  }
  // Position/balance updates feed reconciliation; for now we only consume them
  // implicitly via REST when the cycle/status endpoint queries.
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
// endpoint to indicate which symbols are receiving live data; the actual
// trade lifecycle is driven by ORDER_TRADE_UPDATE events from the user-data
// stream, not by aggTrade.
const lastAggTradeAt = new Map<string, number>()

function handleAggTrade(sym: string, _price: number, ts: number): void {
  lastAggTradeAt.set(sym, ts)
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
