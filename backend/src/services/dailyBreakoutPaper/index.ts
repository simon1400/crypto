/**
 * Daily Breakout Paper Trader — virtual ($) trading engine.
 *
 * Tick architecture:
 *   - 60s tick (lifecycle.ts): opens new paper trades from BreakoutSignal
 *     stream and replays 5m klines as a SAFETY-NET for SL/TP detection.
 *   - WebSocket tracker (breakoutWsTracker.ts): real-time SL/TP detection via
 *     Bybit publicTrade stream — every actual trade triggers trackOnePaper
 *     for matching symbols, with 200ms per-symbol throttle. Replaces the old
 *     2s fast-poll tick.
 *
 * Trailing: FULL (TP1→BE, TP2→TP1, TP3→TP2) — backtest showed TEST R/tr +0.34.
 * Splits: 50/30/20 (default ladder).
 *
 * Variant routing:
 *   Parameterised by `variant: 'A' | 'B' | 'C'`. All variants observe the same
 *   BreakoutSignal stream but maintain independent deposits and trade tables.
 *   Variant A (legacy prod) also mirrors trade state back into BreakoutSignal
 *   so the "Сигналы" tab and Telegram tracker stay in sync. Variants B/C do
 *   NOT mutate the shared BreakoutSignal table — they only read from it.
 */

// === Public API ===

export { startBreakoutPaperTrader, stopBreakoutPaperTrader, startBreakoutEodSummary, stopBreakoutEodSummary } from './lifecycle'
export { runBreakoutPaperCycle } from './cycle'
export { runTrackForSymbol } from './track'
export { resetBreakoutPaperAccount } from './reset'
export { forceOpenSignal } from './open'
export { syncSignalStatus } from './signalSync'
export { applyDepositDelta } from './deposit'
export { getRealisticRates, takerFillPrice, isMakerFill } from './fees'
export { isVariantBusyOnSymbol, isCircuitBreakerTripped } from './gating'

// === Public types ===

export type { OpenedTradeInfo } from './types'
