import { RawSignal } from './strategies/index'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { OIData } from '../services/openInterest'
import { NewsSentiment } from '../services/news'

// Score a raw signal from 0-100 across 5 dimensions
// Volume is MANDATORY — if < 1.0x, signal is killed

export interface ScoredSignal extends RawSignal {
  score: number
  volumeKill: boolean // true = killed by low volume
  scoreBreakdown: {
    technical: number     // 0-25
    multiTF: number       // 0-15
    volume: number        // 0-30 (doubled from 15)
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

  // === VOLUME GATE: mandatory filter ===
  const volRatio = ind.tf1h.volRatio
  if (volRatio < 1.0) {
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

  // === 2. Multi-timeframe alignment (max 15) ===
  let multiTF = 0
  const { tf15m, tf1h, tf4h } = ind
  const expectedTrend = type === 'LONG' ? 'BULLISH' : 'BEARISH'

  if (tf4h.trend === expectedTrend) multiTF += 6
  if (tf1h.trend === expectedTrend) multiTF += 5
  if (tf15m.trend === expectedTrend) multiTF += 4
  multiTF = Math.min(15, multiTF)

  // === 3. Volume (max 30) — critical in crypto ===
  let volume = 0
  if (volRatio > 3.0) volume = 30
  else if (volRatio > 2.5) volume = 27
  else if (volRatio > 2.0) volume = 24
  else if (volRatio > 1.5) volume = 20
  else if (volRatio > 1.2) volume = 15
  else if (volRatio > 1.0) volume = 10
  // Below 1.0 is already killed above

  // === 4. Market context (max 15) ===
  let marketContext = 3 // base

  // Funding rate — stronger contrarian signal
  if (funding) {
    // Strong contrarian: funding heavily positive → SHORT is smart
    if (type === 'SHORT' && funding.fundingRate > 0.003) marketContext += 4
    if (type === 'LONG' && funding.fundingRate < -0.003) marketContext += 4
    // Moderate contrarian
    if (type === 'SHORT' && funding.fundingRate > 0.001) marketContext += 2
    if (type === 'LONG' && funding.fundingRate < -0.001) marketContext += 2
    // Crowded trade penalty
    if (type === 'LONG' && funding.fundingRate > 0.005) marketContext -= 3
    if (type === 'SHORT' && funding.fundingRate < -0.005) marketContext -= 3
  }

  // OI confirmation
  if (oi && oi.openInterest > 0) {
    // OI rising + price direction = trend confirmed
    // (we don't have OI change yet, but if OI is high it means active market)
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
