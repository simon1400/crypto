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
  getBinanceClient, getBinanceCreds, BinanceFuturesClient,
} from './exchanges/binanceFutures'
import {
  BinanceUserDataStream, BinanceMarketDataStream,
  type OrderTradeUpdateEvent, type AccountUpdateEvent,
} from './exchanges/binanceFuturesWs'

const LOG = '[BreakoutLiveC]'

// ============================================================================
// Lifecycle
// ============================================================================

interface RunningState {
  client: BinanceFuturesClient
  userDataWs: BinanceUserDataStream
  marketDataWs: BinanceMarketDataStream
  tickTimer: NodeJS.Timeout | null
  net: 'testnet' | 'prod'
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

    // Slow tick — every 5 min, mirrors paper C cycle (placement + safety net + EOD).
    // Implementation lands in follow-up commits; for now it just logs heartbeat.
    const tickTimer = setInterval(() => {
      runLiveCycle().catch((e) => console.error(`${LOG} cycle error:`, e.message))
    }, 5 * 60 * 1000)

    state = { client, userDataWs, marketDataWs, tickTimer, net: creds.net }
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
    // TODO: placement (placeLimitsForRanges)
    // TODO: safety net fill check (cross 5m candle against limit price)
    // TODO: EOD-FLAT at 23:55 UTC
    // TODO: market data WS subscription diff (which symbols need aggTrade)
  } catch (e: any) {
    console.error(`${LOG} cycle threw:`, e.message)
  } finally {
    cycleBusy = false
  }
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

async function handleOrderUpdate(_ev: OrderTradeUpdateEvent): Promise<void> {
  // TODO (next commit):
  //  - Match ev.o.c (clientOrderId) → BreakoutLiveTradeC row by binanceClientOrderId
  //    OR a child TP/SL order (via binanceSlOrderId / binanceTpOrderIds)
  //  - Switch on ev.o.X (NEW / PARTIALLY_FILLED / FILLED / CANCELED / EXPIRED)
  //  - FILLED entry limit → mark trade OPEN, cancel pair, place TP/SL children
  //  - FILLED TP child → record close, advance trailing SL
  //  - FILLED SL child → record close, finalize
}

async function handleAccountUpdate(ev: AccountUpdateEvent): Promise<void> {
  // FUNDING_FEE → log to BreakoutLiveFundingC.
  if (ev.a?.m === 'FUNDING_FEE') {
    // TODO (funding logging commit): write BreakoutLiveFundingC rows
    return
  }
  // Position/balance updates feed reconciliation; for now we only consume them
  // implicitly via REST when the cycle/status endpoint queries.
}

// ============================================================================
// Market data WS — aggTrade safety net
// ============================================================================

function handleAggTrade(_sym: string, _price: number, _ts: number): void {
  // TODO (next commit): safety net for entry limit fill detection — Binance
  // fills the order on its side authoritatively, and ORDER_TRADE_UPDATE WS will
  // deliver the event. This aggTrade handler is reserved for virtual TP/SL
  // trigger logic that we won't use (we use real reduceOnly orders), but the
  // stream still gives us a fast freshness signal for the UI / cycle.
}
