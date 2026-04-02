import { RawSignal } from './strategies/index'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { OIData } from '../services/openInterest'
import { NewsSentiment } from '../services/news'

// Score a raw signal from 0-100 across 5 dimensions
// Volume is strategy-aware: mandatory for breakout, weighted for trend, secondary for mean revert
// MTF alignment: 4h = bias, 1h = setup, 15m = trigger (not all must match)
// Decorrelation: factors that overlap get discounted to avoid double-counting

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
  if (raw.strategy === 'breakout' && volRatio < 1.0) {
    return {
      ...raw,
      score: 0,
      volumeKill: true,
      scoreBreakdown: { technical: 0, multiTF: 0, volume: 0, marketContext: 0, patterns: 0 },
    }
  }

  // === 1. Technical score (max 25) ===
  // This is pure strategy confidence — how well conditions match the strategy
  const techRaw = (raw.confidence / raw.maxConfidence) * 18
  let regimeBonus = 0
  if (raw.strategy === 'trend_follow' && (regime.regime === 'TRENDING_UP' || regime.regime === 'TRENDING_DOWN')) regimeBonus = 7
  if (raw.strategy === 'mean_revert' && regime.regime === 'RANGING') regimeBonus = 7
  if (raw.strategy === 'breakout' && regime.regime === 'VOLATILE') regimeBonus = 6
  const technical = Math.min(25, Math.round(techRaw + regimeBonus))

  // === 2. Multi-timeframe alignment (max 20) ===
  // 4h = bias, 1h = setup, 15m = trigger
  let multiTF = 0
  const { tf15m, tf1h, tf4h } = ind
  const expectedTrend = type === 'LONG' ? 'BULLISH' : 'BEARISH'
  const neutralTrend = 'SIDEWAYS'

  // Track what MTF contributed for decorrelation
  let mtfUsed4hTrend = false

  // 4h = bias (max 8)
  if (tf4h.trend === expectedTrend) {
    multiTF += 8
    mtfUsed4hTrend = true
  } else if (tf4h.trend === neutralTrend) {
    multiTF += 4
  }

  // 1h = setup (max 7)
  if (tf1h.trend === expectedTrend) {
    multiTF += 7
  } else if (tf1h.trend === neutralTrend) {
    multiTF += 3
  }

  // 15m = trigger (max 5)
  if (tf15m.trend === expectedTrend) {
    multiTF += 5
  } else if (tf15m.trend === neutralTrend) {
    multiTF += 2
  }

  multiTF = Math.min(20, multiTF)

  // === 3. Volume (max 15) — strategy-aware scoring ===
  let volume = 0

  if (raw.strategy === 'breakout') {
    if (volRatio > 3.0) volume = 15
    else if (volRatio > 2.5) volume = 13
    else if (volRatio > 2.0) volume = 11
    else if (volRatio > 1.5) volume = 9
    else if (volRatio > 1.2) volume = 7
    else if (volRatio >= 1.0) volume = 5
  } else if (raw.strategy === 'trend_follow') {
    if (volRatio > 2.5) volume = 15
    else if (volRatio > 2.0) volume = 13
    else if (volRatio > 1.5) volume = 11
    else if (volRatio > 1.2) volume = 9
    else if (volRatio > 1.0) volume = 7
    else if (volRatio > 0.8) volume = 4
    else volume = 2
  } else {
    if (volRatio > 2.0) volume = 15
    else if (volRatio > 1.5) volume = 12
    else if (volRatio > 1.0) volume = 9
    else if (volRatio > 0.7) volume = 6
    else volume = 4
  }

  // === 4. Market context (max 15) ===
  // Only INDEPENDENT signals: funding, fear&greed, news, OI
  // These don't overlap with technical/MTF because they are external data sources
  let marketContext = 3 // base

  if (funding) {
    // Contrarian funding — independent signal (exchange-level positioning data)
    if (type === 'SHORT' && funding.fundingRate > 0.003) marketContext += 4
    else if (type === 'LONG' && funding.fundingRate < -0.003) marketContext += 4
    else if (type === 'SHORT' && funding.fundingRate > 0.001) marketContext += 2
    else if (type === 'LONG' && funding.fundingRate < -0.001) marketContext += 2

    // Crowded trade penalty
    if (type === 'LONG' && funding.fundingRate > 0.005) marketContext -= 3
    if (type === 'SHORT' && funding.fundingRate < -0.005) marketContext -= 3
  }

  if (oi && oi.openInterest > 0) {
    marketContext += 1
  }

  // Fear & Greed — independent sentiment data
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext += 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_GREED') marketContext += 2
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_GREED') marketContext -= 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext -= 2

  // News — independent external data
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

  // 4h patterns: discount if MTF already scored 4h trend alignment
  // This prevents double-counting: "4h trend bullish" + "4h bullish engulfing" measure the same thing
  const tf4hPatternWeight = mtfUsed4hTrend ? 2 : 4 // discount from 4 to 2 if MTF already counted 4h
  for (const p of tf4h.patterns) {
    if (relevantPatterns.includes(p)) patterns += tf4hPatternWeight
  }
  patterns = Math.max(0, Math.min(15, patterns))

  // === Decorrelation adjustment ===
  // If technical score is high AND MTF is high, it often means the same thing:
  // "strategy conditions met" and "timeframes aligned" are correlated for trend_follow
  // Apply a small discount when both are near max to prevent inflated totals
  let decorrelationPenalty = 0
  if (raw.strategy === 'trend_follow') {
    // Technical includes EMA alignment checks, MTF also checks EMA trends
    const techNorm = technical / 25
    const mtfNorm = multiTF / 20
    if (techNorm > 0.7 && mtfNorm > 0.7) {
      // Both high → they're partly measuring the same thing
      decorrelationPenalty = Math.round((techNorm + mtfNorm - 1) * 5) // max ~5 pts penalty
    }
  }

  const rawScore = technical + multiTF + volume + marketContext + patterns
  const score = Math.max(0, rawScore - decorrelationPenalty)

  return {
    ...raw,
    score,
    volumeKill: false,
    scoreBreakdown: { technical, multiTF, volume, marketContext, patterns },
  }
}
