import { MultiTFIndicators } from '../../services/indicators'
import { MarketRegime } from '../marketRegime'
import { RawSignal } from './index'

// Mean Reversion Strategy
// Best when: RANGING regime
// Logic: Buy at oversold levels near support, sell at overbought near resistance
// Key: RSI extremes + Bollinger Band touch + Support/Resistance + divergences

export function meanRevert(
  coin: string,
  ind: MultiTFIndicators,
  regime: MarketRegime
): RawSignal | null {
  const { tf15m, tf1h, tf4h } = ind

  // Works best in ranging, but can work in volatile too
  if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
    // In strong trends, mean reversion is risky — need higher threshold
  }

  const longConditions = checkLong(tf15m, tf1h, tf4h)
  const shortConditions = checkShort(tf15m, tf1h, tf4h)

  if (longConditions.score > shortConditions.score && longConditions.score >= 4) {
    return {
      coin,
      type: 'LONG',
      strategy: 'mean_revert',
      confidence: longConditions.score,
      maxConfidence: 10,
      reasons: longConditions.reasons,
      indicators: ind,
    }
  }

  if (shortConditions.score > longConditions.score && shortConditions.score >= 4) {
    return {
      coin,
      type: 'SHORT',
      strategy: 'mean_revert',
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

function checkLong(tf15m: MultiTFIndicators['tf15m'], tf1h: MultiTFIndicators['tf1h'], tf4h: MultiTFIndicators['tf4h']): ConditionResult {
  let score = 0
  const reasons: string[] = []

  // RSI oversold on 1h
  if (tf1h.rsi < 35) {
    score += 2
    reasons.push(`RSI 1h = ${tf1h.rsi} — перепроданность`)
  }

  // Stochastic oversold
  if (tf1h.stochK < 20 && tf1h.stochD < 20) {
    score += 1
    reasons.push(`Stochastic перепродан: %K=${tf1h.stochK} %D=${tf1h.stochD}`)
  }

  // Price at or below lower Bollinger Band
  if (tf1h.price <= tf1h.bbLower * 1.002) {
    score += 2
    reasons.push('Цена касается нижней Bollinger Band на 1h')
  }

  // Price near support level
  const nearSupport = tf1h.price <= tf1h.support * 1.01
  if (nearSupport) {
    score += 2
    reasons.push(`Цена у поддержки $${tf1h.support}`)
  }

  // RSI divergence: price making lower low but RSI higher low
  // Simplified: RSI on 15m recovering while price still low
  if (tf15m.rsi > tf1h.rsi && tf1h.rsi < 40) {
    score += 1
    reasons.push('Возможная бычья дивергенция RSI (15m > 1h)')
  }

  // Bullish candle patterns
  const bullishPatterns = tf1h.patterns.filter(p =>
    ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'DOUBLE_BOTTOM', 'DOJI'].includes(p)
  )
  if (bullishPatterns.length > 0) {
    score += 1
    reasons.push(`Бычьи паттерны: ${bullishPatterns.join(', ')}`)
  }

  // Price near VWAP or below (fair value)
  if (tf1h.price <= tf1h.vwap * 1.005) {
    score += 1
    reasons.push('Цена у VWAP — зона справедливой стоимости')
  }

  return { score, reasons }
}

function checkShort(tf15m: MultiTFIndicators['tf15m'], tf1h: MultiTFIndicators['tf1h'], tf4h: MultiTFIndicators['tf4h']): ConditionResult {
  let score = 0
  const reasons: string[] = []

  // RSI overbought
  if (tf1h.rsi > 65) {
    score += 2
    reasons.push(`RSI 1h = ${tf1h.rsi} — перекупленность`)
  }

  // Stochastic overbought
  if (tf1h.stochK > 80 && tf1h.stochD > 80) {
    score += 1
    reasons.push(`Stochastic перекуплен: %K=${tf1h.stochK} %D=${tf1h.stochD}`)
  }

  // Price at or above upper Bollinger Band
  if (tf1h.price >= tf1h.bbUpper * 0.998) {
    score += 2
    reasons.push('Цена касается верхней Bollinger Band на 1h')
  }

  // Price near resistance
  const nearResistance = tf1h.price >= tf1h.resistance * 0.99
  if (nearResistance) {
    score += 2
    reasons.push(`Цена у сопротивления $${tf1h.resistance}`)
  }

  // Bearish divergence
  if (tf15m.rsi < tf1h.rsi && tf1h.rsi > 60) {
    score += 1
    reasons.push('Возможная медвежья дивергенция RSI (15m < 1h)')
  }

  // Bearish patterns
  const bearishPatterns = tf1h.patterns.filter(p =>
    ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'DOUBLE_TOP'].includes(p)
  )
  if (bearishPatterns.length > 0) {
    score += 1
    reasons.push(`Медвежьи паттерны: ${bearishPatterns.join(', ')}`)
  }

  // Price above VWAP
  if (tf1h.price >= tf1h.vwap * 1.005) {
    score += 1
    reasons.push('Цена выше VWAP — зона переоценки')
  }

  return { score, reasons }
}
