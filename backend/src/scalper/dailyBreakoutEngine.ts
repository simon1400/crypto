/**
 * Daily Breakout strategy engine — pure logic, no DB / no I/O.
 *
 * Logic:
 *   1. Range = first N 5m bars of UTC day (default 36 = 3h: 00:00-03:00 UTC)
 *   2. After range close, scan remaining bars for breakout:
 *      - LONG: candle.high > rangeHigh AND candle.close > rangeHigh
 *      - SHORT: candle.low < rangeLow AND candle.close < rangeLow
 *   3. Volume confirmation: current 5m volume >= avg(last 24 5m bars) × volumeMultiplier
 *   4. SL = opposite range edge
 *   5. TP ladder = entry ± 1×rangeSize, ±2×rangeSize, ±3×rangeSize (splits 50/30/20)
 *   6. First valid breakout per day per symbol — second sig blocked
 *
 * Backtest 365d (runBacktest_dailybreak_detailed.ts) — optimal config:
 *   3h range, vol×2.0, 11 monetах: TRAIN +0.16 R/tr, TEST +0.34 R/tr
 *   With 0.05% slippage included.
 */

import { OHLCV } from '../services/market'

export interface BreakoutEngineConfig {
  rangeBars: number          // first N 5m bars define the range
  volumeMultiplier: number   // current vol must >= avg×this
  tp1Mult: number            // TP1 = entry + rangeSize × this
  tp2Mult: number
  tp3Mult: number
}

export const DEFAULT_BREAKOUT_CFG: BreakoutEngineConfig = {
  rangeBars: 36,             // 3h × 12 bars/h = 36 5m bars
  volumeMultiplier: 2.0,
  tp1Mult: 1.0,
  tp2Mult: 2.0,
  tp3Mult: 3.0,
}

export interface BreakoutRange {
  rangeHigh: number
  rangeLow: number
  rangeSize: number
  rangeDate: string          // 'YYYY-MM-DD' UTC
  rangeStartTime: number     // unix ms
  rangeEndTime: number       // unix ms (= rangeStartTime + rangeBars × 5min)
}

export interface BreakoutSignal {
  side: 'BUY' | 'SELL'
  triggerTime: number        // unix ms of breakout candle
  triggerPrice: number       // close of breakout candle (for diagnostic)
  entryPrice: number         // = rangeHigh (BUY) or rangeLow (SELL)
  stopLoss: number
  tpLadder: number[]
  rangeHigh: number
  rangeLow: number
  rangeSize: number
  rangeDate: string
  volumeAtBreakout: number
  avgVolume: number
  reason: string
}

/**
 * Производные: для UTC даты (YYYY-MM-DD) определяет range (если в данных есть
 * первые `cfg.rangeBars` свечей этого дня).
 *
 * Возвращает null если range еще не сформирован (мало данных).
 */
export function detectRange(
  candles: OHLCV[],
  utcDate: string,
  cfg: BreakoutEngineConfig,
): BreakoutRange | null {
  // Find candles for this UTC date
  const dayCandles = candles.filter(c => new Date(c.time).toISOString().slice(0, 10) === utcDate)
  if (dayCandles.length < cfg.rangeBars) return null

  const rangeBars = dayCandles.slice(0, cfg.rangeBars)
  const rangeHigh = Math.max(...rangeBars.map(c => c.high))
  const rangeLow = Math.min(...rangeBars.map(c => c.low))
  const rangeSize = rangeHigh - rangeLow
  if (rangeSize <= 0) return null

  return {
    rangeHigh, rangeLow, rangeSize,
    rangeDate: utcDate,
    rangeStartTime: rangeBars[0].time,
    rangeEndTime: rangeBars[rangeBars.length - 1].time + 5 * 60_000,
  }
}

/**
 * Проверяет последнюю закрытую свечу: даёт ли она breakout signal?
 *
 * Возвращает signal если:
 *   - candle.time >= range.rangeEndTime (после конца range)
 *   - same UTC day as range
 *   - candle wick + close пробивает rangeHigh (BUY) или rangeLow (SELL)
 *   - volume confirmation passes
 *
 * NOTE: Calling code должен проверять что за этот день ещё нет triggered signal
 * (per-day per-symbol uniqueness — handled at scanner level через DB lookup).
 */
export function generateBreakoutSignal(
  candles: OHLCV[],
  range: BreakoutRange,
  candleIdx: number,
  cfg: BreakoutEngineConfig,
): BreakoutSignal | null {
  const c = candles[candleIdx]
  if (!c) return null

  // Must be after range end and same day
  if (c.time < range.rangeEndTime) return null
  const candleDate = new Date(c.time).toISOString().slice(0, 10)
  if (candleDate !== range.rangeDate) return null

  // Volume confirmation: avg of prev 24 bars
  const avgWindowStart = Math.max(0, candleIdx - 24)
  const avgWindowBars = candles.slice(avgWindowStart, candleIdx)
  if (avgWindowBars.length === 0) return null
  const avgVolume = avgWindowBars.reduce((s, x) => s + x.volume, 0) / avgWindowBars.length
  if (c.volume < avgVolume * cfg.volumeMultiplier) return null

  // Breakout check
  let side: 'BUY' | 'SELL' | null = null
  let entryPrice = 0
  if (c.high > range.rangeHigh && c.close > range.rangeHigh) {
    side = 'BUY'
    entryPrice = range.rangeHigh
  } else if (c.low < range.rangeLow && c.close < range.rangeLow) {
    side = 'SELL'
    entryPrice = range.rangeLow
  }
  if (!side) return null

  const sl = side === 'BUY' ? range.rangeLow : range.rangeHigh
  const tpLadder = side === 'BUY'
    ? [entryPrice + range.rangeSize * cfg.tp1Mult, entryPrice + range.rangeSize * cfg.tp2Mult, entryPrice + range.rangeSize * cfg.tp3Mult]
    : [entryPrice - range.rangeSize * cfg.tp1Mult, entryPrice - range.rangeSize * cfg.tp2Mult, entryPrice - range.rangeSize * cfg.tp3Mult]

  const reason = `Daily Breakout ${side} of ${range.rangeDate} range [${range.rangeLow.toFixed(4)} – ${range.rangeHigh.toFixed(4)}], vol ${(c.volume / avgVolume).toFixed(1)}× avg`

  return {
    side, triggerTime: c.time, triggerPrice: c.close,
    entryPrice, stopLoss: sl, tpLadder,
    rangeHigh: range.rangeHigh, rangeLow: range.rangeLow, rangeSize: range.rangeSize,
    rangeDate: range.rangeDate, volumeAtBreakout: c.volume, avgVolume, reason,
  }
}

/**
 * UTC date string (YYYY-MM-DD) for given unix ms.
 */
export function utcDateOf(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10)
}

/**
 * End-of-day unix ms (UTC 23:55:00 of given date) — for signal expiry.
 */
export function endOfDayUTC(utcDate: string): number {
  return new Date(`${utcDate}T23:55:00.000Z`).getTime()
}
