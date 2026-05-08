/**
 * LIMIT trade simulator.
 *
 * Difference from market simulator:
 *   - Wait for price to reach limit_plan.preferred_limit_price (or anywhere in zone)
 *   - If TTL expires (default 4h) without fill → cancel, return null
 *   - If invalidation level hits before fill → cancel, return null
 *   - On fill: simulate as a normal trade starting at fill time, with limit price
 *     as entry (NOT current price at signal time)
 */

import { OHLCV } from '../../services/market'
import { EnrichedSignal } from '../../scanner/scoring/index'
import { simulateTrade, TradeResult, ExitReason } from './tradeSimulator'

export type LimitOutcome =
  | { kind: 'FILLED'; trade: TradeResult; fillTime: number; fillPrice: number }
  | { kind: 'TTL_EXPIRED'; signalTime: number }
  | { kind: 'INVALIDATED'; invalTime: number; invalPrice: number }

export interface LimitTradeResult extends TradeResult {
  // Same shape as TradeResult, but with extra fields tracking limit-specific outcome
  limitFillTime: number | null
  limitWaitMinutes: number | null
}

/**
 * Simulate a limit-entry signal. Returns:
 *   - LimitTradeResult if the order filled and a trade resolved
 *   - null if cancelled (TTL or invalidation) — these are not counted as trades
 */
export function simulateLimitTrade(
  signal: EnrichedSignal,
  futureCandles5m: OHLCV[],
  signalTime: number,
): LimitTradeResult | null {
  const plan = signal.limit_plan
  if (!plan) return null
  const isLong = signal.type === 'LONG'
  const limitPrice = plan.preferred_limit_price
  const invalPrice = plan.invalidation_price
  const ttlMs = (plan.ttl_minutes || 240) * 60_000
  const expiry = signalTime + ttlMs

  // Walk forward until fill, invalidation, or TTL
  let fillIdx = -1
  let fillPrice = 0
  for (let i = 0; i < futureCandles5m.length; i++) {
    const c = futureCandles5m[i]
    if (c.time > expiry) break

    // Check invalidation FIRST (defensive — price blew through stop level)
    if (isLong && c.low <= invalPrice) return null
    if (!isLong && c.high >= invalPrice) return null

    // Check fill: price must touch the limit zone
    if (isLong && c.low <= limitPrice) {
      fillIdx = i
      fillPrice = limitPrice
      break
    }
    if (!isLong && c.high >= limitPrice) {
      fillIdx = i
      fillPrice = limitPrice
      break
    }
  }
  if (fillIdx < 0) return null // TTL expired or invalidation

  // Recompute trade with the fill price as entry. The original SL and TPs
  // were computed for current_price, but limit fills at a more favorable price.
  // For accurate R-multiple, we need to recompute SL distance and TP positions.
  //
  // For simplicity in v1: keep the same SL/TP prices from the signal.
  // R-multiple is now (TP - fillPrice) / |fillPrice - SL|, naturally giving
  // better R for limit fills (the desired effect).

  const fillTime = futureCandles5m[fillIdx].time
  const futureFromFill = futureCandles5m.slice(fillIdx)

  // Build a synthetic signal with entry = fillPrice
  const adjustedSignal: EnrichedSignal = {
    ...signal,
    entry: fillPrice,
    // SL stays at signal.initial_stop, TPs stay at signal.take_profits
    // simulator uses entry/initial_stop/take_profits to compute R
  }

  const t = simulateTrade(adjustedSignal, futureFromFill, fillTime)

  // Override executionType for clarity in aggregation
  return {
    ...t,
    executionType: signal.execution_type, // keep LIMIT_LONG / LIMIT_SHORT label
    entry: fillPrice,
    limitFillTime: fillTime,
    limitWaitMinutes: Math.round((fillTime - signalTime) / 60_000),
  }
}

// Re-export for convenience
export type { ExitReason, TradeResult }
