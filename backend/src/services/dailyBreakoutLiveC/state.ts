/**
 * Shared module-level state for the LIVE C trader.
 *
 * The trader has substantial in-memory state (WS connections, snapshot, busy
 * locks, throttle timers) that's accessed from many places: lifecycle, cycle,
 * WS handlers, virtual SL/TP tracker, etc. Rather than chain re-imports across
 * files, all of it lives here as exported singletons.
 *
 * Mutability is intentional. These ARE the running trader's state.
 */

import type { BinanceFuturesClient, SymbolFilter } from '../exchanges/binanceFutures'
import type { BinanceUserDataStream, BinanceMarketDataStream } from '../exchanges/binanceFuturesWs'

export const LOG = '[BreakoutLiveC]'
export const TG_PREFIX = '⚠️ <b>[LIVE C]</b> '

// === Running state — set in startBreakoutLiveTraderC, cleared in stop. ===

export interface RunningState {
  client: BinanceFuturesClient
  userDataWs: BinanceUserDataStream
  marketDataWs: BinanceMarketDataStream
  tickTimer: NodeJS.Timeout | null
  eodTimer: NodeJS.Timeout | null
  net: 'testnet' | 'prod'
}

// Wrapped in an object so consumer modules can read the live reference without
// import-time freezing. `state.current` is the public way to access it.
export const state: { current: RunningState | null } = { current: null }

// startBreakoutLiveTraderC re-entrancy guard.
export const startGuard: { inFlight: boolean } = { inFlight: false }

// === Snapshot — WS-driven account view. ===

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

export const snapshot: { current: LiveSnapshot | null } = { current: null }

// Per-symbol last mark price from aggTrade WS — used to compute unrealized PnL
// in the snapshot without an extra REST call.
export const lastMarkPriceWs = new Map<string, number>()

export const SNAPSHOT_STALE_MS = 30 * 1000  // 30s — refresh REST. WS approximation
// drifts (it doesn't get an availableBalance value, only walletBalance, and we
// subtract entry-price-based margin which doesn't match Binance's mark-based
// internal calc). 30s REST keeps currentDepositUsd within $0.01 of reality
// without burning weight (weight 5 per refresh × 2/min = 10 weight/min).

// === Filters cache — exchangeInfo expires 1h. ===

export interface FiltersCache { at: number; map: Map<string, SymbolFilter> }
export const filtersCache: { current: FiltersCache | null } = { current: null }
export const FILTERS_TTL_MS = 60 * 60 * 1000

// === Cycle & EOD throttles. ===

// Track which UTC day we already EOD-flushed so the 1-min tick doesn't fire
// the flush repeatedly between 23:55 and 23:56.
export const eodGuard: { lastDate: string | null } = { lastDate: null }

// One breaker alert per UTC day. Set when notifyBreaker fires, cleared on the
// first cycle of a new UTC day (compared inside maybeNotifyBreaker).
export const breakerGuard: { notifiedDate: string | null } = { notifiedDate: null }

// Re-entrancy guard for the 60s placement cycle.
export const cycleGuard: { busy: boolean } = { busy: false }

// === Tracker locks. ===

// Per-trade in-flight lock — prevents concurrent aggTrade ticks from sending
// two MARKET reduceOnlys for the same level. Keyed by trade.id.
export const tradeBusy = new Set<number>()

// Per-trade fill lock — prevents two aggTrade ticks racing on the same PENDING.
export const fillBusy = new Set<number>()

// === aggTrade tracking. ===

// Per-symbol freshness ticker — last seen trade ts. Used by the UI / status
// endpoint to indicate which symbols are receiving live data.
export const lastAggTradeAt = new Map<string, number>()

// Per-symbol throttle so a hot symbol (e.g. BTC at 100tps) doesn't hammer
// the DB. 100ms = 10 checks/sec is enough to catch any SL/TP without melting.
export const TICK_THROTTLE_MS = 100
export const lastTickProcessedAt = new Map<string, number>()

// === Constants shared across modules — see breakoutCommon/constants.ts. ===

export { SPLITS, ACTIVE_STATUSES, CLOSED_STATUSES } from '../breakoutCommon/constants'
