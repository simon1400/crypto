import { MultiTFIndicators } from '../services/indicators'

// Per-coin regime context — relative to BTC
export interface CoinRegimeContext {
  coinTrend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  btcTrend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  relativeStrength: 'OUTPERFORMING' | 'UNDERPERFORMING' | 'NEUTRAL'
  ownMomentum: boolean // true = coin has its own impulse independent of BTC
}

// Compares coin's momentum to BTC to detect independent impulse
export function detectCoinRegime(
  coinInd: MultiTFIndicators,
  btcInd: MultiTFIndicators | null,
): CoinRegimeContext {
  const coinTrend = coinInd.tf4h.trend
  const btcTrend = btcInd?.tf4h.trend || 'SIDEWAYS'

  // Relative strength: compare 24h change
  const coinChange = coinInd.tf1h.change24h
  const btcChange = btcInd?.tf1h.change24h || 0
  const diff = coinChange - btcChange

  let relativeStrength: CoinRegimeContext['relativeStrength'] = 'NEUTRAL'
  if (diff > 2) relativeStrength = 'OUTPERFORMING'
  else if (diff < -2) relativeStrength = 'UNDERPERFORMING'

  // Own momentum: coin trends differently from BTC AND has strong ADX
  const ownMomentum =
    coinTrend !== btcTrend &&
    coinInd.tf4h.adx > 20 &&
    Math.abs(coinChange) > 1.5

  return { coinTrend, btcTrend, relativeStrength, ownMomentum }
}
