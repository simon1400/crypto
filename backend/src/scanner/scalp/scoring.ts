import { ScalpSignal, ScalpIndicators } from './strategies'

// Scalp scoring — simpler than swing, focused on:
// 1. Signal strength (strategy confidence)
// 2. Multi-TF alignment (1m trigger, 5m setup, 15m context)
// 3. Spread/volatility suitability
// 4. Volume presence
// Max score: 60 (normalized to 0-100)

export interface ScalpScoreBreakdown {
  signal: number      // 0-25 (strategy confidence)
  alignment: number   // 0-20 (1m/5m/15m agreement)
  volatility: number  // 0-15 (BB width, ATR — needs enough range to scalp)
  volume: number      // 0-15 (volume confirms move is real)
  context: number     // 0-10 (15m not fighting direction)
}

export interface ScoredScalpSignal extends ScalpSignal {
  score: number
  scoreBreakdown: ScalpScoreBreakdown
}

export function scoreScalpSignal(raw: ScalpSignal): ScoredScalpSignal {
  const { tf1m, tf5m, tf15m } = raw.indicators
  const isLong = raw.type === 'LONG'

  // 1. Signal strength (0-25)
  const signal = Math.round((raw.confidence / raw.maxConfidence) * 25)

  // 2. Multi-TF alignment (0-20)
  let alignment = 0

  // 5m = setup TF (most important for scalp)
  const expected5m = isLong ? 'oversold-ish' : 'overbought-ish'
  if (isLong && tf5m.rsi < 40) alignment += 6
  else if (isLong && tf5m.rsi < 50) alignment += 3
  if (!isLong && tf5m.rsi > 60) alignment += 6
  else if (!isLong && tf5m.rsi > 50) alignment += 3

  // 1m = trigger (should show reversal starting)
  if (isLong && tf1m.rsi > tf5m.rsi) alignment += 5  // 1m recovering
  if (!isLong && tf1m.rsi < tf5m.rsi) alignment += 5  // 1m dropping

  // 15m = context (should not be strongly against)
  if (isLong && tf15m.trend !== 'BEARISH') alignment += 4
  else if (isLong && tf15m.trend === 'BEARISH') alignment -= 2
  if (!isLong && tf15m.trend !== 'BULLISH') alignment += 4
  else if (!isLong && tf15m.trend === 'BULLISH') alignment -= 2

  // Stoch alignment on 5m
  if (isLong && tf5m.stochK < 25) alignment += 3
  if (!isLong && tf5m.stochK > 75) alignment += 3

  alignment = Math.max(0, Math.min(20, alignment))

  // 3. Volatility (0-15) — need enough BB width for scalp to be worth it
  let volatility = 0
  const bbWidth5m = tf5m.bbWidth
  if (bbWidth5m >= 0.3 && bbWidth5m <= 2.0) {
    volatility = 10  // sweet spot — enough range, not crazy
  } else if (bbWidth5m >= 0.15 && bbWidth5m <= 3.0) {
    volatility = 6   // workable
  } else if (bbWidth5m < 0.15) {
    volatility = 2   // too compressed — no range to scalp
  } else {
    volatility = 4   // too volatile — SL gets hit easily
  }

  // ATR sanity — need at least some movement
  const atrPct = (tf5m.atr / tf5m.price) * 100
  if (atrPct >= 0.1 && atrPct <= 1.0) volatility += 5
  else if (atrPct > 1.0) volatility += 2 // risky but possible

  volatility = Math.min(15, volatility)

  // 4. Volume (0-15)
  let volume = 0
  if (tf5m.volRatio > 2.5) volume = 15
  else if (tf5m.volRatio > 2.0) volume = 12
  else if (tf5m.volRatio > 1.5) volume = 10
  else if (tf5m.volRatio > 1.0) volume = 7
  else if (tf5m.volRatio > 0.7) volume = 4
  else volume = 1 // dead volume = risky scalp

  // 5. Context (0-10)
  let context = 5 // base

  // MACD on 15m — if it's with our direction, bonus
  if (isLong && tf15m.macdHistogram > 0) context += 3
  if (!isLong && tf15m.macdHistogram < 0) context += 3

  // Price relative to VWAP on 15m
  if (isLong && tf15m.price < tf15m.vwap) context += 2
  if (!isLong && tf15m.price > tf15m.vwap) context += 2

  context = Math.min(10, context)

  const rawScore = signal + alignment + volatility + volume + context
  // Max theoretical: 25 + 20 + 15 + 15 + 10 = 85
  // Normalize to 0-100
  const score = Math.min(100, Math.round(rawScore * 100 / 85))

  return {
    ...raw,
    score,
    scoreBreakdown: { signal, alignment, volatility, volume, context },
  }
}
