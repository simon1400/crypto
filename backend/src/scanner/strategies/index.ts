import { MultiTFIndicators } from '../../services/indicators'
import { MarketRegime } from '../marketRegime'
import { trendFollow } from './trendFollow'
import { meanRevert } from './meanRevert'
import { breakout } from './breakout'

export interface RawSignal {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  confidence: number     // raw score from strategy
  maxConfidence: number  // max possible score
  reasons: string[]
  indicators: MultiTFIndicators
}

type StrategyFn = (coin: string, ind: MultiTFIndicators, regime: MarketRegime) => RawSignal | null

const strategies: StrategyFn[] = [
  trendFollow,
  meanRevert,
  breakout,
]

// Run all strategies on a coin and return best signal (or null)
export function runStrategies(
  coin: string,
  indicators: MultiTFIndicators,
  regime: MarketRegime
): RawSignal | null {
  const signals: RawSignal[] = []

  for (const strategy of strategies) {
    const signal = strategy(coin, indicators, regime)
    if (signal) signals.push(signal)
  }

  if (signals.length === 0) return null

  // Return the signal with highest normalized confidence
  signals.sort((a, b) => (b.confidence / b.maxConfidence) - (a.confidence / a.maxConfidence))
  return signals[0]
}
