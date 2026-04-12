import { MultiTFIndicators } from '../../services/indicators'
import { OHLCV } from '../../services/market'
import { EntryTriggerResult } from './types'
import { fmtPrice } from '../utils/round'

// === ENTRY TRIGGER SCORE ===
// Separate pass/fail evaluation: is the entry valid RIGHT NOW?
// A high setup_score without a valid entry trigger must stay WATCHLIST / WAIT.
//
// For LONG, entry allowed if at least 3 of 4 are true:
//   1. Price returned into pullback zone (EMA20 / VWAP / reclaim level)
//   2. Recent candle closed back above trigger level (from actual OHLC)
//   3. Reversal candle volume above average
//   4. Current price within 0.35 ATR(15m) from trigger level

export function calculateEntryTrigger(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  candles5m?: OHLCV[],
  candles15m?: OHLCV[],
): EntryTriggerResult {
  const { tf15m, tf1h } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr15m = tf15m.atr
  const details: string[] = []

  // === Condition 1: Price in pullback zone ===
  let pullback_zone = false
  if (isLong) {
    const nearEma20 = price <= tf1h.ema20 * 1.003
    const nearVwap = price <= tf1h.vwap * 1.003
    const nearSupport = price <= tf1h.support * 1.01
    pullback_zone = nearEma20 || nearVwap || nearSupport
    if (pullback_zone) {
      const zones: string[] = []
      if (nearEma20) zones.push(`EMA20($${fmtPrice(tf1h.ema20)})`)
      if (nearVwap) zones.push(`VWAP($${fmtPrice(tf1h.vwap)})`)
      if (nearSupport) zones.push(`Support($${fmtPrice(tf1h.support)})`)
      details.push(`Цена в зоне отката: ${zones.join(', ')}`)
    } else {
      details.push(`Цена не в зоне отката (EMA20=$${fmtPrice(tf1h.ema20)}, VWAP=$${fmtPrice(tf1h.vwap)})`)
    }
  } else {
    const nearEma20 = price >= tf1h.ema20 * 0.997
    const nearVwap = price >= tf1h.vwap * 0.997
    const nearResistance = price >= tf1h.resistance * 0.99
    pullback_zone = nearEma20 || nearVwap || nearResistance
    if (pullback_zone) {
      const zones: string[] = []
      if (nearEma20) zones.push(`EMA20($${fmtPrice(tf1h.ema20)})`)
      if (nearVwap) zones.push(`VWAP($${fmtPrice(tf1h.vwap)})`)
      if (nearResistance) zones.push(`Resistance($${fmtPrice(tf1h.resistance)})`)
      details.push(`Цена в зоне отката: ${zones.join(', ')}`)
    } else {
      details.push(`Цена не в зоне отката`)
    }
  }

  // === Condition 2: Recent candle closed back above/below trigger level ===
  // Uses actual 5m/15m candles when available, falls back to indicator-based check
  let candle_reclaim = false
  const triggerLevel = isLong
    ? Math.max(tf1h.ema20, tf1h.vwap)
    : Math.min(tf1h.ema20, tf1h.vwap)

  const recentCandles = candles5m?.length ? candles5m : candles15m
  if (recentCandles && recentCandles.length >= 3) {
    // Check last 3 candles for reclaim pattern
    const last3 = recentCandles.slice(-3)
    if (isLong) {
      // Look for: candle dipped below trigger then closed above it
      const dippedBelow = last3.some(c => c.low < triggerLevel)
      const closedAbove = last3[last3.length - 1].close > triggerLevel
      candle_reclaim = dippedBelow && closedAbove
      if (candle_reclaim) {
        details.push(`Свеча отскочила от $${fmtPrice(triggerLevel)}: лоу ниже, закрытие выше`)
      } else {
        // Also check for rejection from support (wick touch near trigger without body penetration)
        const lastCandle = last3[last3.length - 1]
        const bodyLow = Math.min(lastCandle.open, lastCandle.close)
        const nearTrigger = lastCandle.low < triggerLevel * 1.005 // wick must actually touch near trigger
        const wickRatio = bodyLow > lastCandle.low && lastCandle.high > lastCandle.low
          ? (bodyLow - lastCandle.low) / (lastCandle.high - lastCandle.low) : 0
        if (nearTrigger && wickRatio > 0.3 && lastCandle.close > lastCandle.open) {
          candle_reclaim = true
          details.push(`Свеча с длинной нижней тенью (${fmtPrice(wickRatio * 100)}%) у триггера — отскок`)
        } else {
          details.push(`Нет рекавери свечи от триггера $${fmtPrice(triggerLevel)}`)
        }
      }
    } else {
      // SHORT: candle spiked above trigger then closed below
      const spikedAbove = last3.some(c => c.high > triggerLevel)
      const closedBelow = last3[last3.length - 1].close < triggerLevel
      candle_reclaim = spikedAbove && closedBelow
      if (candle_reclaim) {
        details.push(`Свеча отвержена от $${fmtPrice(triggerLevel)}: хай выше, закрытие ниже`)
      } else {
        const lastCandle = last3[last3.length - 1]
        const bodyHigh = Math.max(lastCandle.open, lastCandle.close)
        const nearTrigger = lastCandle.high > triggerLevel * 0.995 // wick must actually touch near trigger
        const wickRatio = lastCandle.high > bodyHigh && lastCandle.high > lastCandle.low
          ? (lastCandle.high - bodyHigh) / (lastCandle.high - lastCandle.low) : 0
        if (nearTrigger && wickRatio > 0.3 && lastCandle.close < lastCandle.open) {
          candle_reclaim = true
          details.push(`Свеча с длинной верхней тенью (${fmtPrice(wickRatio * 100)}%) у триггера — отвержение`)
        } else {
          details.push(`Нет рекавери свечи от триггера $${fmtPrice(triggerLevel)}`)
        }
      }
    }
  } else {
    // Fallback: use 15m indicators when no raw candles available
    if (isLong) {
      candle_reclaim = tf15m.price > tf15m.ema9 && tf15m.macdHistogram > 0
      details.push(candle_reclaim
        ? '15m: цена > EMA9 + MACD положительный (индикаторный fallback)'
        : '15m: не подтвердила рекавери (индикаторный fallback)')
    } else {
      candle_reclaim = tf15m.price < tf15m.ema9 && tf15m.macdHistogram < 0
      details.push(candle_reclaim
        ? '15m: цена < EMA9 + MACD отрицательный (индикаторный fallback)'
        : '15m: не подтвердила рекавери (индикаторный fallback)')
    }
  }

  // === Condition 3: Reversal candle volume above average ===
  let reversal_volume = false
  if (recentCandles && recentCandles.length >= 20) {
    const last = recentCandles[recentCandles.length - 1]
    const avgVol = recentCandles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
    reversal_volume = last.volume > avgVol
    details.push(reversal_volume
      ? `Объём свечи ${fmtPrice(last.volume / avgVol)}x > среднего`
      : `Объём свечи ${fmtPrice(last.volume / avgVol)}x ≤ среднего`)
  } else {
    reversal_volume = tf15m.volRatio > 1.0
    details.push(reversal_volume
      ? `Объём 15m = ${tf15m.volRatio}x > среднего`
      : `Объём 15m = ${tf15m.volRatio}x — ниже среднего`)
  }

  // === Condition 4: Current price within 0.35 ATR(15m) from trigger level ===
  const distFromTrigger = atr15m > 0
    ? Math.abs(price - triggerLevel) / atr15m
    : 999
  const distance_from_trigger = distFromTrigger <= 0.35
  details.push(distance_from_trigger
    ? `Расстояние от триггера ${fmtPrice(distFromTrigger)} ATR(15m) <= 0.35`
    : `Расстояние от триггера ${fmtPrice(distFromTrigger)} ATR(15m) > 0.35`)

  // Score: need 3 of 4
  const conditionsMet = [pullback_zone, candle_reclaim, reversal_volume, distance_from_trigger]
    .filter(Boolean).length
  const passed = conditionsMet >= 3

  return {
    passed,
    score: conditionsMet,
    conditions: {
      pullback_zone,
      candle_reclaim,
      reversal_volume,
      distance_from_trigger,
    },
    details,
  }
}
