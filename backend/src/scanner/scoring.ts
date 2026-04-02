import { RawSignal } from './strategies/index'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { OIData } from '../services/openInterest'
import { NewsSentiment } from '../services/news'

// Score a raw signal from 0-100 across 5 dimensions
// Volume is strategy-aware: mandatory for breakout, weighted for trend, secondary for mean revert
// MTF alignment: 4h = bias, 1h = setup, 15m = trigger (not all must match)

export interface ScoredSignal extends RawSignal {
  score: number
  volumeKill: boolean // true = killed by low volume (only for breakout)
  scoreBreakdown: {
    technical: number     // 0-25
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
  oi?: OIData | null,
): ScoredSignal {
  const { indicators: ind, type } = raw

  const volRatio = ind.tf1h.volRatio

  // === VOLUME GATE: strategy-aware ===
  // Breakout: volume is mandatory (< 1.0 kills signal)
  // Trend follow: volume is desired but not mandatory (penalty instead of kill)
  // Mean revert: volume is secondary (small penalty)
  if (raw.strategy === 'breakout' && volRatio < 1.0) {
    return {
      ...raw,
      score: 0,
      volumeKill: true,
      scoreBreakdown: { technical: 0, multiTF: 0, volume: 0, marketContext: 0, patterns: 0 },
    }
  }

  // === 1. Technical score (max 25) ===
  const techRaw = (raw.confidence / raw.maxConfidence) * 18
  let regimeBonus = 0
  if (raw.strategy === 'trend_follow' && (regime.regime === 'TRENDING_UP' || regime.regime === 'TRENDING_DOWN')) regimeBonus = 7
  if (raw.strategy === 'mean_revert' && regime.regime === 'RANGING') regimeBonus = 7
  if (raw.strategy === 'breakout' && regime.regime === 'VOLATILE') regimeBonus = 6
  const technical = Math.min(25, Math.round(techRaw + regimeBonus))

  // === 2. Multi-timeframe alignment (max 20) ===
  // New approach: 4h = bias (direction), 1h = setup (structure), 15m = trigger
  // Not all must match — role-based scoring
  let multiTF = 0
  const { tf15m, tf1h, tf4h } = ind
  const expectedTrend = type === 'LONG' ? 'BULLISH' : 'BEARISH'
  const neutralTrend = 'SIDEWAYS'

  // 4h = bias (max 8): must be aligned OR neutral (not conflicting)
  if (tf4h.trend === expectedTrend) {
    multiTF += 8
  } else if (tf4h.trend === neutralTrend) {
    multiTF += 4 // neutral is OK, not conflicting
  }
  // tf4h opposing = 0 points (penalty is just absence of points)

  // 1h = setup (max 7): the main structural timeframe
  if (tf1h.trend === expectedTrend) {
    multiTF += 7
  } else if (tf1h.trend === neutralTrend) {
    multiTF += 3
  }

  // 15m = trigger (max 5): confirms timing, nice to have
  if (tf15m.trend === expectedTrend) {
    multiTF += 5
  } else if (tf15m.trend === neutralTrend) {
    multiTF += 2
  }

  multiTF = Math.min(20, multiTF)

  // === 3. Volume (max 15) — strategy-aware scoring ===
  let volume = 0

  if (raw.strategy === 'breakout') {
    // Breakout: volume is critical confirmation
    if (volRatio > 3.0) volume = 15
    else if (volRatio > 2.5) volume = 13
    else if (volRatio > 2.0) volume = 11
    else if (volRatio > 1.5) volume = 9
    else if (volRatio > 1.2) volume = 7
    else if (volRatio >= 1.0) volume = 5
    // Below 1.0 already killed above
  } else if (raw.strategy === 'trend_follow') {
    // Trend follow: volume desired but not mandatory
    if (volRatio > 2.5) volume = 15
    else if (volRatio > 2.0) volume = 13
    else if (volRatio > 1.5) volume = 11
    else if (volRatio > 1.2) volume = 9
    else if (volRatio > 1.0) volume = 7
    else if (volRatio > 0.8) volume = 4  // below average — small penalty, not kill
    else volume = 2  // very low volume — bigger penalty but still alive
  } else {
    // Mean revert: volume is secondary
    if (volRatio > 2.0) volume = 15
    else if (volRatio > 1.5) volume = 12
    else if (volRatio > 1.0) volume = 9
    else if (volRatio > 0.7) volume = 6  // low volume is OK for mean reversion
    else volume = 4  // even very low volume gets some points
  }

  // === 4. Market context (max 15) ===
  let marketContext = 3 // base

  // Funding rate — stronger contrarian signal
  if (funding) {
    if (type === 'SHORT' && funding.fundingRate > 0.003) marketContext += 4
    if (type === 'LONG' && funding.fundingRate < -0.003) marketContext += 4
    if (type === 'SHORT' && funding.fundingRate > 0.001) marketContext += 2
    if (type === 'LONG' && funding.fundingRate < -0.001) marketContext += 2
    if (type === 'LONG' && funding.fundingRate > 0.005) marketContext -= 3
    if (type === 'SHORT' && funding.fundingRate < -0.005) marketContext -= 3
  }

  // OI confirmation
  if (oi && oi.openInterest > 0) {
    marketContext += 1
  }

  // Fear & Greed
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext += 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_GREED') marketContext += 2
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_GREED') marketContext -= 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext -= 2

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
    volumeKill: false,
    scoreBreakdown: { technical, multiTF, volume, marketContext, patterns },
  }
}