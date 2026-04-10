import { MultiTFIndicators } from '../../services/indicators'
import { RegimeContext } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'

/**
 * Определяет направление сделки (LONG/SHORT) из multi-TF анализа.
 * Использует 4h/1h тренды, EMA alignment, RSI, MACD, режим рынка и ADX.
 */
export function determineDirection(
  ind: MultiTFIndicators,
  regime: RegimeContext,
  _coinRegime: CoinRegimeContext,
): 'LONG' | 'SHORT' {
  let longScore = 0
  let shortScore = 0

  const { tf1h, tf4h } = ind

  // 4h trend (strongest signal)
  if (tf4h.trend === 'BULLISH') longScore += 3
  else if (tf4h.trend === 'BEARISH') shortScore += 3

  // 1h trend
  if (tf1h.trend === 'BULLISH') longScore += 2
  else if (tf1h.trend === 'BEARISH') shortScore += 2

  // EMA alignment
  if (tf4h.ema20 > tf4h.ema50) longScore += 2
  else shortScore += 2

  // RSI bias
  if (tf4h.rsi > 55) longScore += 1
  if (tf4h.rsi < 45) shortScore += 1
  if (tf1h.rsi > 55) longScore += 1
  if (tf1h.rsi < 45) shortScore += 1

  // MACD
  if (tf4h.macdHistogram > 0) longScore += 1
  else shortScore += 1
  if (tf1h.macdHistogram > 0) longScore += 1
  else shortScore += 1

  // Market regime
  if (regime.regime === 'TRENDING_UP') longScore += 2
  else if (regime.regime === 'TRENDING_DOWN') shortScore += 2

  // ADX + directional
  if (tf4h.adx > 25) {
    if (tf4h.plusDI > tf4h.minusDI) longScore += 1
    else shortScore += 1
  }

  return longScore >= shortScore ? 'LONG' : 'SHORT'
}
