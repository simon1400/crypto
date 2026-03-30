import { RawSignal } from './strategies/index'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { NewsSentiment } from '../services/news'

// Score a raw signal from 0-100 across 5 dimensions

export interface ScoredSignal extends RawSignal {
  score: number
  scoreBreakdown: {
    technical: number     // 0-35
    multiTF: number       // 0-20
    volume: number        // 0-15
    marketContext: number  // 0-15
    patterns: number      // 0-15
  }
}

export function scoreSignal(
  raw: RawSignal,
  regime: RegimeContext,
  funding?: FundingData | null,
  news?: NewsSentiment | null,
): ScoredSignal {
  const { indicators: ind, type } = raw

  // === 1. Technical score (max 35) ===
  // Normalized confidence from strategy
  const techRaw = (raw.confidence / raw.maxConfidence) * 25
  // Bonus: strategy matches regime
  let regimeBonus = 0
  if (raw.strategy === 'trend_follow' && (regime.regime === 'TRENDING_UP' || regime.regime === 'TRENDING_DOWN')) regimeBonus = 10
  if (raw.strategy === 'mean_revert' && regime.regime === 'RANGING') regimeBonus = 10
  if (raw.strategy === 'breakout' && regime.regime === 'VOLATILE') regimeBonus = 8
  const technical = Math.min(35, Math.round(techRaw + regimeBonus))

  // === 2. Multi-timeframe alignment (max 20) ===
  let multiTF = 0
  const { tf15m, tf1h, tf4h } = ind
  const expectedTrend = type === 'LONG' ? 'BULLISH' : 'BEARISH'

  if (tf4h.trend === expectedTrend) multiTF += 8
  if (tf1h.trend === expectedTrend) multiTF += 7
  if (tf15m.trend === expectedTrend) multiTF += 5
  multiTF = Math.min(20, multiTF)

  // === 3. Volume (max 15) ===
  let volume = 0
  if (tf1h.volRatio > 2.0) volume = 15
  else if (tf1h.volRatio > 1.5) volume = 12
  else if (tf1h.volRatio > 1.2) volume = 9
  else if (tf1h.volRatio > 1.0) volume = 6
  else if (tf1h.volRatio > 0.8) volume = 3
  // Penalty for very low volume
  if (tf1h.volRatio < 0.5) volume = 0

  // === 4. Market context (max 15) ===
  let marketContext = 5 // base

  // Funding rate: positive funding + LONG = crowded (bad), negative funding + LONG = contrarian (good)
  if (funding) {
    if (type === 'LONG' && funding.fundingRate < -0.001) marketContext += 3  // shorts paying longs
    if (type === 'SHORT' && funding.fundingRate > 0.001) marketContext += 3  // longs paying shorts
    if (type === 'LONG' && funding.fundingRate > 0.005) marketContext -= 2   // too many longs
    if (type === 'SHORT' && funding.fundingRate < -0.005) marketContext -= 2 // too many shorts
  }

  // Fear & Greed
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext += 3  // contrarian buy
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_GREED') marketContext += 3 // contrarian sell
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_GREED') marketContext -= 2  // buying at top
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext -= 2  // selling at bottom

  // News sentiment
  if (news && news.total > 0) {
    if (type === 'LONG' && news.score > 30) marketContext += 2
    if (type === 'SHORT' && news.score < -30) marketContext += 2
  }

  marketContext = Math.max(0, Math.min(15, marketContext))

  // === 5. Candlestick patterns (max 15) ===
  let patterns = 0
  const bullishPatterns = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'THREE_WHITE_SOLDIERS', 'DOUBLE_BOTTOM']
  const bearishPatterns = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'THREE_BLACK_CROWS', 'DOUBLE_TOP']

  const relevantPatterns = type === 'LONG' ? bullishPatterns : bearishPatterns
  const conflictPatterns = type === 'LONG' ? bearishPatterns : bullishPatterns

  for (const p of tf1h.patterns) {
    if (relevantPatterns.includes(p)) patterns += 5
    if (conflictPatterns.includes(p)) patterns -= 3
  }
  for (const p of tf4h.patterns) {
    if (relevantPatterns.includes(p)) patterns += 4
  }
  patterns = Math.max(0, Math.min(15, patterns))

  const score = technical + multiTF + volume + marketContext + patterns

  return {
    ...raw,
    score,
    scoreBreakdown: { technical, multiTF, volume, marketContext, patterns },
  }
}
