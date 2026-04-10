import { MultiTFIndicators } from '../../services/indicators'
import { MarketRegime } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'
import { RawSignal } from './index'

// Trend Following Strategy
// Best when: TRENDING_UP or TRENDING_DOWN regime
// Logic: Trade with the trend on pullbacks to EMA
// Entry: On pullback to EMA9/EMA21 zone with momentum confirmation

export function trendFollow(
  coin: string,
  ind: MultiTFIndicators,
  regime: MarketRegime,
  _coinRegime?: CoinRegimeContext,
): RawSignal | null {
  const { tf15m, tf1h, tf4h } = ind

  // Only works in trending markets — hard filter
  if (regime === 'RANGING' || regime === 'VOLATILE') return null

  // === LONG conditions ===
  const longConditions = checkLong(tf15m, tf1h, tf4h)
  const shortConditions = checkShort(tf15m, tf1h, tf4h)

  if (longConditions.score > shortConditions.score && longConditions.score >= 3) {
    return {
      coin,
      type: 'LONG',
      strategy: 'trend_follow',
      confidence: longConditions.score,
      maxConfidence: 10,
      reasons: longConditions.reasons,
      indicators: ind,
    }
  }

  if (shortConditions.score > longConditions.score && shortConditions.score >= 3) {
    return {
      coin,
      type: 'SHORT',
      strategy: 'trend_follow',
      confidence: shortConditions.score,
      maxConfidence: 10,
      reasons: shortConditions.reasons,
      indicators: ind,
    }
  }

  return null
}

interface ConditionResult {
  score: number
  reasons: string[]
}

function checkLong(_tf15m: MultiTFIndicators['tf15m'], tf1h: MultiTFIndicators['tf1h'], tf4h: MultiTFIndicators['tf4h']): ConditionResult {
  let score = 0
  const reasons: string[] = []

  // 4h trend is bullish (EMA alignment)
  if (tf4h.ema20 > tf4h.ema50 && tf4h.price > tf4h.ema20) {
    score += 2
    reasons.push('4h тренд бычий: EMA20 > EMA50, цена > EMA20')
  }

  // 1h trend confirms
  if (tf1h.trend === 'BULLISH') {
    score += 1
    reasons.push('1h тренд подтверждает: BULLISH')
  }

  // ADX shows strong trend on 4h
  if (tf4h.adx > 25) {
    score += 1
    reasons.push(`4h ADX = ${tf4h.adx} — сильный тренд`)
  }

  // Price near EMA9 or EMA20 (pullback zone) on 1h
  const pullbackToEMA = tf1h.price <= tf1h.ema9 * 1.005 && tf1h.price >= tf1h.ema20 * 0.995
  if (pullbackToEMA) {
    score += 2
    reasons.push('Цена в зоне отката к EMA9-EMA20 на 1h')
  }

  // MACD positive or crossing up
  if (tf1h.macdHistogram > 0 || (tf1h.macd > tf1h.macdSignal && tf4h.macd > 0)) {
    score += 1
    reasons.push('MACD подтверждает рост')
  }

  // RSI not overbought (room to grow)
  if (tf1h.rsi > 40 && tf1h.rsi < 70) {
    score += 1
    reasons.push(`RSI 1h = ${tf1h.rsi} — есть запас для роста`)
  }

  // Volume confirmation
  if (tf1h.volRatio > 1.2) {
    score += 1
    reasons.push(`Объём 1h = ${tf1h.volRatio}x — повышенный`)
  }

  // +DI > -DI on 4h
  if (tf4h.plusDI > tf4h.minusDI) {
    score += 1
    reasons.push('+DI > -DI на 4h — покупатели доминируют')
  }

  return { score, reasons }
}

function checkShort(_tf15m: MultiTFIndicators['tf15m'], tf1h: MultiTFIndicators['tf1h'], tf4h: MultiTFIndicators['tf4h']): ConditionResult {
  let score = 0
  const reasons: string[] = []

  // 4h trend is bearish
  if (tf4h.ema20 < tf4h.ema50 && tf4h.price < tf4h.ema20) {
    score += 2
    reasons.push('4h тренд медвежий: EMA20 < EMA50, цена < EMA20')
  }

  // 1h trend confirms
  if (tf1h.trend === 'BEARISH') {
    score += 1
    reasons.push('1h тренд подтверждает: BEARISH')
  }

  // ADX shows strong trend
  if (tf4h.adx > 25) {
    score += 1
    reasons.push(`4h ADX = ${tf4h.adx} — сильный тренд`)
  }

  // Price bouncing up to EMA9/EMA20 zone (pullback in downtrend)
  const pullbackToEMA = tf1h.price >= tf1h.ema9 * 0.995 && tf1h.price <= tf1h.ema20 * 1.005
  if (pullbackToEMA) {
    score += 2
    reasons.push('Цена откатила к EMA9-EMA20 на 1h (зона продажи)')
  }

  // MACD negative
  if (tf1h.macdHistogram < 0 || (tf1h.macd < tf1h.macdSignal && tf4h.macd < 0)) {
    score += 1
    reasons.push('MACD подтверждает падение')
  }

  // RSI not oversold
  if (tf1h.rsi > 30 && tf1h.rsi < 60) {
    score += 1
    reasons.push(`RSI 1h = ${tf1h.rsi} — есть запас для падения`)
  }

  // Volume
  if (tf1h.volRatio > 1.2) {
    score += 1
    reasons.push(`Объём 1h = ${tf1h.volRatio}x — повышенный`)
  }

  // -DI > +DI
  if (tf4h.minusDI > tf4h.plusDI) {
    score += 1
    reasons.push('-DI > +DI на 4h — продавцы доминируют')
  }

  return { score, reasons }
}
