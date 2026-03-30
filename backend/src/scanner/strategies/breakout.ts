import { MultiTFIndicators } from '../../services/indicators'
import { MarketRegime } from '../marketRegime'
import { RawSignal } from './index'

// Breakout Strategy
// Best when: After RANGING/low volatility periods (BB squeeze)
// Logic: Detect consolidation → breakout with volume confirmation
// Key: BB width squeeze + Volume spike + S/R break + OI increase

export function breakout(
  coin: string,
  ind: MultiTFIndicators,
  regime: MarketRegime
): RawSignal | null {
  const { tf15m, tf1h, tf4h } = ind

  const longConditions = checkLong(tf15m, tf1h, tf4h)
  const shortConditions = checkShort(tf15m, tf1h, tf4h)

  if (longConditions.score > shortConditions.score && longConditions.score >= 4) {
    return {
      coin,
      type: 'LONG',
      strategy: 'breakout',
      confidence: longConditions.score,
      maxConfidence: 9,
      reasons: longConditions.reasons,
      indicators: ind,
    }
  }

  if (shortConditions.score > longConditions.score && shortConditions.score >= 4) {
    return {
      coin,
      type: 'SHORT',
      strategy: 'breakout',
      confidence: shortConditions.score,
      maxConfidence: 9,
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

  // Bollinger Band squeeze on 4h or 1h (low volatility before breakout)
  const squeezed4h = tf4h.bbWidth < 3
  const squeezed1h = tf1h.bbWidth < 2.5
  if (squeezed4h || squeezed1h) {
    score += 2
    reasons.push(`BB сжатие: 4h=${tf4h.bbWidth}% 1h=${tf1h.bbWidth}% — готовность к пробою`)
  }

  // Price breaking above resistance
  if (tf1h.price > tf1h.resistance * 0.998) {
    score += 2
    reasons.push(`Пробой сопротивления $${tf1h.resistance}`)
  }

  // Price above upper BB (explosive move)
  if (tf15m.price > tf15m.bbUpper) {
    score += 1
    reasons.push('Цена выше верхней BB на 15m — импульс вверх')
  }

  // Volume spike (critical for breakout confirmation)
  if (tf1h.volRatio > 1.8) {
    score += 2
    reasons.push(`Всплеск объёма: ${tf1h.volRatio}x — подтверждение пробоя`)
  } else if (tf1h.volRatio > 1.3) {
    score += 1
    reasons.push(`Объём растёт: ${tf1h.volRatio}x`)
  }

  // MACD momentum
  if (tf1h.macdHistogram > 0 && tf15m.macdHistogram > 0) {
    score += 1
    reasons.push('MACD положительный на 1h и 15m')
  }

  // ADX rising (new trend forming)
  if (tf1h.adx > 20 && tf4h.plusDI > tf4h.minusDI) {
    score += 1
    reasons.push(`ADX = ${tf1h.adx} с +DI > -DI — формирование тренда вверх`)
  }

  return { score, reasons }
}

function checkShort(tf15m: MultiTFIndicators['tf15m'], tf1h: MultiTFIndicators['tf1h'], tf4h: MultiTFIndicators['tf4h']): ConditionResult {
  let score = 0
  const reasons: string[] = []

  // BB squeeze
  const squeezed4h = tf4h.bbWidth < 3
  const squeezed1h = tf1h.bbWidth < 2.5
  if (squeezed4h || squeezed1h) {
    score += 2
    reasons.push(`BB сжатие: 4h=${tf4h.bbWidth}% 1h=${tf1h.bbWidth}% — готовность к пробою`)
  }

  // Price breaking below support
  if (tf1h.price < tf1h.support * 1.002) {
    score += 2
    reasons.push(`Пробой поддержки $${tf1h.support}`)
  }

  // Price below lower BB
  if (tf15m.price < tf15m.bbLower) {
    score += 1
    reasons.push('Цена ниже нижней BB на 15m — импульс вниз')
  }

  // Volume spike
  if (tf1h.volRatio > 1.8) {
    score += 2
    reasons.push(`Всплеск объёма: ${tf1h.volRatio}x — подтверждение пробоя`)
  } else if (tf1h.volRatio > 1.3) {
    score += 1
    reasons.push(`Объём растёт: ${tf1h.volRatio}x`)
  }

  // MACD momentum down
  if (tf1h.macdHistogram < 0 && tf15m.macdHistogram < 0) {
    score += 1
    reasons.push('MACD отрицательный на 1h и 15m')
  }

  // ADX rising with -DI leading
  if (tf1h.adx > 20 && tf4h.minusDI > tf4h.plusDI) {
    score += 1
    reasons.push(`ADX = ${tf1h.adx} с -DI > +DI — формирование тренда вниз`)
  }

  return { score, reasons }
}
