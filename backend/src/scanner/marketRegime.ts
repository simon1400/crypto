import { CoinIndicators } from '../services/indicators'
import { MarketOverview } from '../services/market'

// Market regime determines which strategies are active
export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE'

export interface RegimeContext {
  regime: MarketRegime
  confidence: number // 0-100
  btcTrend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  fearGreedZone: 'EXTREME_FEAR' | 'FEAR' | 'NEUTRAL' | 'GREED' | 'EXTREME_GREED'
  volatility: 'LOW' | 'NORMAL' | 'HIGH'
}

export function detectMarketRegime(
  btcIndicators: { tf1h: CoinIndicators; tf4h: CoinIndicators },
  market: MarketOverview
): RegimeContext {
  const { tf1h, tf4h } = btcIndicators

  // Fear & Greed zone
  let fearGreedZone: RegimeContext['fearGreedZone'] = 'NEUTRAL'
  if (market.fearGreed <= 25) fearGreedZone = 'EXTREME_FEAR'
  else if (market.fearGreed <= 45) fearGreedZone = 'FEAR'
  else if (market.fearGreed <= 55) fearGreedZone = 'NEUTRAL'
  else if (market.fearGreed <= 75) fearGreedZone = 'GREED'
  else fearGreedZone = 'EXTREME_GREED'

  // Volatility from BB width and ATR
  const avgBBWidth = (tf1h.bbWidth + tf4h.bbWidth) / 2
  let volatility: RegimeContext['volatility'] = 'NORMAL'
  if (avgBBWidth < 2) volatility = 'LOW'
  else if (avgBBWidth > 5) volatility = 'HIGH'

  // BTC trend from multi-timeframe
  const btcTrend = tf4h.trend

  // Determine regime
  let regime: MarketRegime
  let confidence = 0

  const adxStrong = tf4h.adx > 25
  const adxWeak = tf4h.adx < 20
  const trendAligned = tf1h.trend === tf4h.trend

  if (adxStrong && tf4h.trend === 'BULLISH' && trendAligned) {
    regime = 'TRENDING_UP'
    confidence = Math.min(100, 50 + tf4h.adx + (tf1h.trend === 'BULLISH' ? 15 : 0))
  } else if (adxStrong && tf4h.trend === 'BEARISH' && trendAligned) {
    regime = 'TRENDING_DOWN'
    confidence = Math.min(100, 50 + tf4h.adx + (tf1h.trend === 'BEARISH' ? 15 : 0))
  } else if (volatility === 'HIGH') {
    regime = 'VOLATILE'
    confidence = Math.min(100, 40 + Math.round(avgBBWidth * 8))
  } else {
    regime = 'RANGING'
    confidence = adxWeak ? Math.min(100, 60 + (20 - tf4h.adx) * 2) : 50
  }

  return { regime, confidence, btcTrend, fearGreedZone, volatility }
}
