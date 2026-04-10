import { RawSignal } from './strategies/index'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { OIData } from '../services/openInterest'
import { NewsSentiment } from '../services/news'
import { LiquidationStats } from '../services/liquidations'
import { LSRData } from '../services/longShortRatio'

// === 7 Feature Groups ===
// Each group aggregates correlated indicators into 1 orthogonal subscore.
// No double-counting: EMA/MACD/ADX all go into "trend", not spread across dimensions.
//
// 1. trend        (0-15) — EMA alignment, MACD direction, ADX strength, DI
// 2. momentum     (0-15) — RSI zone, Stochastic, MACD histogram acceleration
// 3. volatility   (0-10) — BB width, ATR regime, squeeze detection
// 4. meanRevStretch (0-10) — distance from BB/VWAP/support-resistance (how stretched)
// 5. levelInteraction (0-15) — proximity to S/R, pivots, fib levels
// 6. volume       (0-15) — volume ratio (strategy-aware)
// 7. marketContext (0-15) — funding, F&G, news, OI (external data only)
//
// Patterns and MTF are modifiers, not standalone groups:
// - Candlestick patterns: bonus within relevant group (mean-rev stretch or level interaction)
// - Multi-TF alignment: multiplier on trend group score

export interface ScoreBreakdown {
  trend: number          // 0-15
  momentum: number       // 0-15
  volatility: number     // 0-10
  meanRevStretch: number // 0-10
  levelInteraction: number // 0-15
  volume: number         // 0-15
  marketContext: number  // 0-15
  mtfMultiplier: number  // 0.6 - 1.3 (applied to trend)
  patternBonus: number   // 0-5 bonus added to relevant group
}

export interface ScoredSignal extends RawSignal {
  score: number
  volumeKill: boolean
  scoreBreakdown: ScoreBreakdown
}

export function scoreSignal(
  raw: RawSignal,
  regime: RegimeContext,
  funding?: FundingData | null,
  news?: NewsSentiment | null,
  oi?: OIData | null,
  liquidations?: LiquidationStats | null,
  lsr?: LSRData | null,
): ScoredSignal {
  const { indicators: ind, type, strategy } = raw
  const { tf15m, tf1h, tf4h } = ind
  const isLong = type === 'LONG'

  const volRatio = tf1h.volRatio

  // === VOLUME GATE: softened for breakout ===
  // Hard kill only at very low volume (0.7x), soft penalty 0.7-1.2x
  if (strategy === 'breakout' && volRatio < 0.7) {
    return {
      ...raw,
      score: 0,
      volumeKill: true,
      scoreBreakdown: { trend: 0, momentum: 0, volatility: 0, meanRevStretch: 0, levelInteraction: 0, volume: 0, marketContext: 0, mtfMultiplier: 1, patternBonus: 0 },
    }
  }

  // === 1. Trend (max 15) ===
  // Aggregates: EMA alignment, MACD direction, ADX, +DI/-DI
  let trend = 0

  // EMA alignment on setup TF (1h)
  if (isLong) {
    if (tf1h.ema20 > tf1h.ema50 && tf1h.price > tf1h.ema20) trend += 4
    else if (tf1h.ema20 > tf1h.ema50) trend += 2
  } else {
    if (tf1h.ema20 < tf1h.ema50 && tf1h.price < tf1h.ema20) trend += 4
    else if (tf1h.ema20 < tf1h.ema50) trend += 2
  }

  // MACD direction (1h)
  if (isLong && tf1h.macdHistogram > 0) trend += 3
  else if (!isLong && tf1h.macdHistogram < 0) trend += 3
  else if (isLong && tf1h.macd > tf1h.macdSignal) trend += 1
  else if (!isLong && tf1h.macd < tf1h.macdSignal) trend += 1

  // ADX strength (1h)
  if (tf1h.adx > 25) trend += 3
  else if (tf1h.adx > 20) trend += 2
  else if (tf1h.adx > 15) trend += 1

  // DI dominance (4h — higher TF for bias)
  if (isLong && tf4h.plusDI > tf4h.minusDI) trend += 2
  else if (!isLong && tf4h.minusDI > tf4h.plusDI) trend += 2

  // Regime bonus: trend strategy in trending market, or mean_revert in ranging
  if (strategy === 'trend_follow' && (regime.regime === 'TRENDING_UP' || regime.regime === 'TRENDING_DOWN')) trend += 3
  if (strategy === 'mean_revert' && regime.regime === 'RANGING') trend += 2
  if (strategy === 'breakout' && regime.regime === 'VOLATILE') trend += 2

  trend = Math.min(15, trend)

  // === MTF Multiplier (applied to trend) ===
  // 4h = bias, 1h = setup, 15m = trigger
  // Instead of separate 0-20 score, this is a multiplier on trend
  let mtfAlignment = 0
  const expectedTrend = isLong ? 'BULLISH' : 'BEARISH'

  if (tf4h.trend === expectedTrend) mtfAlignment += 3
  else if (tf4h.trend === 'SIDEWAYS') mtfAlignment += 1
  else mtfAlignment -= 1 // opposing 4h trend

  if (tf1h.trend === expectedTrend) mtfAlignment += 2
  else if (tf1h.trend === 'SIDEWAYS') mtfAlignment += 1

  if (tf15m.trend === expectedTrend) mtfAlignment += 1
  else if (tf15m.trend === 'SIDEWAYS') mtfAlignment += 0

  // mtfAlignment: -1 to 6 → multiplier 0.6 to 1.3
  const mtfMultiplier = Math.max(0.6, Math.min(1.3, 0.8 + mtfAlignment * 0.083))
  const trendAdjusted = Math.round(trend * mtfMultiplier)

  // === 2. Momentum (max 15) ===
  // Aggregates: RSI zone, Stochastic, MACD histogram acceleration
  let momentum = 0

  // RSI zone — different scoring per strategy
  if (strategy === 'mean_revert') {
    // For mean revert: extreme RSI is GOOD
    if (isLong && tf1h.rsi < 30) momentum += 5
    else if (isLong && tf1h.rsi < 35) momentum += 3
    else if (!isLong && tf1h.rsi > 70) momentum += 5
    else if (!isLong && tf1h.rsi > 65) momentum += 3
  } else {
    // For trend/breakout: RSI in healthy zone is good
    if (isLong && tf1h.rsi > 45 && tf1h.rsi < 70) momentum += 4
    else if (isLong && tf1h.rsi > 40 && tf1h.rsi < 75) momentum += 2
    else if (!isLong && tf1h.rsi > 30 && tf1h.rsi < 55) momentum += 4
    else if (!isLong && tf1h.rsi > 25 && tf1h.rsi < 60) momentum += 2
  }

  // Stochastic
  if (strategy === 'mean_revert') {
    if (isLong && tf1h.stochK < 20) momentum += 3
    else if (!isLong && tf1h.stochK > 80) momentum += 3
  } else {
    // Stoch crossing in momentum direction
    if (isLong && tf1h.stochK > tf1h.stochD && tf1h.stochK < 80) momentum += 2
    else if (!isLong && tf1h.stochK < tf1h.stochD && tf1h.stochK > 20) momentum += 2
  }

  // MACD histogram acceleration (15m confirms momentum)
  if (isLong && tf15m.macdHistogram > 0 && tf1h.macdHistogram > 0) momentum += 3
  else if (!isLong && tf15m.macdHistogram < 0 && tf1h.macdHistogram < 0) momentum += 3
  else if (isLong && tf15m.macdHistogram > 0) momentum += 1
  else if (!isLong && tf15m.macdHistogram < 0) momentum += 1

  // RSI divergence bonus for mean revert
  if (strategy === 'mean_revert') {
    if (isLong && tf15m.rsi > tf1h.rsi && tf1h.rsi < 40) momentum += 2
    if (!isLong && tf15m.rsi < tf1h.rsi && tf1h.rsi > 60) momentum += 2
  }

  momentum = Math.min(15, Math.max(0, momentum))

  // === 3. Volatility (max 10) ===
  // BB width, ATR regime — measures market conditions
  let volatility = 0

  if (strategy === 'breakout') {
    // Breakout wants prior compression (low BB width) then expansion
    if (tf4h.bbWidth < 2.5) volatility += 4
    else if (tf4h.bbWidth < 3.5) volatility += 3
    else if (tf1h.bbWidth < 2.5) volatility += 2

    // 15m expansion after squeeze
    if (tf15m.bbWidth > tf1h.bbWidth) volatility += 3

    // ATR expanding (1h ATR-based movement)
    volatility += 2 // base for breakout context
  } else if (strategy === 'mean_revert') {
    // Mean revert wants moderate volatility (not too compressed, not too wild)
    if (tf1h.bbWidth >= 2 && tf1h.bbWidth <= 5) volatility += 4
    else if (tf1h.bbWidth > 5) volatility += 2 // high vol = wider stops needed
    else volatility += 1 // very compressed — may not revert
  } else {
    // Trend follow — moderate volatility is fine
    if (tf1h.bbWidth >= 1.5 && tf1h.bbWidth <= 4) volatility += 4
    else volatility += 2
  }

  // ATR vs price sanity
  const atrPct = (tf1h.atr / tf1h.price) * 100
  if (atrPct >= 0.5 && atrPct <= 4) volatility += 2
  // Extreme ATR = penalty
  if (atrPct > 6) volatility -= 2

  volatility = Math.min(10, Math.max(0, volatility))

  // === 4. Mean-Reversion Stretch (max 10) ===
  // How far is price from equilibrium (BB midline, VWAP, mean)
  let meanRevStretch = 0

  if (strategy === 'mean_revert') {
    // Distance from BB
    if (isLong && tf1h.price <= tf1h.bbLower * 1.002) meanRevStretch += 4
    else if (isLong && tf1h.price <= tf1h.bbLower * 1.01) meanRevStretch += 2
    if (!isLong && tf1h.price >= tf1h.bbUpper * 0.998) meanRevStretch += 4
    else if (!isLong && tf1h.price >= tf1h.bbUpper * 0.99) meanRevStretch += 2

    // Distance from VWAP
    if (isLong && tf1h.price <= tf1h.vwap * 0.995) meanRevStretch += 3
    else if (isLong && tf1h.price <= tf1h.vwap * 1.005) meanRevStretch += 1
    if (!isLong && tf1h.price >= tf1h.vwap * 1.005) meanRevStretch += 3
    else if (!isLong && tf1h.price >= tf1h.vwap * 0.995) meanRevStretch += 1

    // Bullish/bearish patterns at extremes
    const bullishPatterns = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'DOUBLE_BOTTOM', 'DOJI']
    const bearishPatterns = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'DOUBLE_TOP']
    const relevant = isLong ? bullishPatterns : bearishPatterns
    if (tf1h.patterns.some(p => relevant.includes(p))) meanRevStretch += 2
  } else {
    // For trend/breakout: not primary factor, but pullback entry benefits
    if (strategy === 'trend_follow') {
      // Pullback to EMA zone = mild stretch
      const inPullback = isLong
        ? tf1h.price <= tf1h.ema9 * 1.005 && tf1h.price >= tf1h.ema20 * 0.995
        : tf1h.price >= tf1h.ema9 * 0.995 && tf1h.price <= tf1h.ema20 * 1.005
      if (inPullback) meanRevStretch += 4
    }
    // Breakout doesn't use this group
  }

  meanRevStretch = Math.min(10, meanRevStretch)

  // === 5. Level Interaction (max 15) ===
  // Proximity to S/R, pivot points, fib levels
  let levelInteraction = 0

  if (strategy === 'breakout') {
    // Breaking through resistance/support
    if (isLong && tf1h.price > tf1h.resistance * 0.998) levelInteraction += 5
    if (!isLong && tf1h.price < tf1h.support * 1.002) levelInteraction += 5

    // Price through pivot
    if (isLong && tf1h.price > tf1h.pivotR1) levelInteraction += 3
    else if (!isLong && tf1h.price < tf1h.pivotS1) levelInteraction += 3

    // 15m above upper BB (explosive)
    if (isLong && tf15m.price > tf15m.bbUpper) levelInteraction += 2
    if (!isLong && tf15m.price < tf15m.bbLower) levelInteraction += 2

    // Room to next level (4h resistance)
    const roomToNext = isLong
      ? (tf4h.resistance - tf1h.price) / tf1h.price
      : (tf1h.price - tf4h.support) / tf1h.price
    if (roomToNext > 0.03) levelInteraction += 3 // >3% room to next major level
    else if (roomToNext > 0.015) levelInteraction += 1
  } else if (strategy === 'mean_revert') {
    // Near support/resistance for entry
    if (isLong && tf1h.price <= tf1h.support * 1.01) levelInteraction += 5
    if (!isLong && tf1h.price >= tf1h.resistance * 0.99) levelInteraction += 5

    // Near pivot level
    if (isLong && tf1h.price <= tf1h.pivotS1 * 1.01) levelInteraction += 3
    if (!isLong && tf1h.price >= tf1h.pivotR1 * 0.99) levelInteraction += 3

    // Fib levels (0.618, 0.786 are strong reversal zones)
    const fibLevels = tf1h.fibLevels || []
    const nearFib = fibLevels.some(fib => {
      const dist = Math.abs(tf1h.price - fib.price) / tf1h.price
      return dist < 0.005 // within 0.5% of a fib level
    })
    if (nearFib) levelInteraction += 3
  } else {
    // Trend follow: entry near EMA / key level
    if (isLong && tf1h.price >= tf1h.support * 0.99 && tf1h.price <= tf1h.support * 1.02) levelInteraction += 4
    if (!isLong && tf1h.price <= tf1h.resistance * 1.01 && tf1h.price >= tf1h.resistance * 0.98) levelInteraction += 4

    // Room to run (resistance for LONG, support for SHORT)
    const roomToTarget = isLong
      ? (tf1h.resistance - tf1h.price) / tf1h.price
      : (tf1h.price - tf1h.support) / tf1h.price
    if (roomToTarget > 0.03) levelInteraction += 4
    else if (roomToTarget > 0.015) levelInteraction += 2

    // 4h structure confirms direction
    if (isLong && tf4h.ema20 > tf4h.ema50) levelInteraction += 2
    if (!isLong && tf4h.ema20 < tf4h.ema50) levelInteraction += 2
  }

  // Candlestick pattern bonus for level interaction
  let patternBonus = 0
  const bullPatterns = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'THREE_WHITE_SOLDIERS', 'DOUBLE_BOTTOM']
  const bearPatterns = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'THREE_BLACK_CROWS', 'DOUBLE_TOP']
  const alignedPatterns = isLong ? bullPatterns : bearPatterns
  const conflictingPatterns = isLong ? bearPatterns : bullPatterns

  for (const p of tf1h.patterns) {
    if (alignedPatterns.includes(p)) patternBonus += 2
    if (conflictingPatterns.includes(p)) patternBonus -= 1
  }
  // 4h patterns (less weight — they're broader)
  for (const p of tf4h.patterns) {
    if (alignedPatterns.includes(p)) patternBonus += 1
  }
  patternBonus = Math.max(0, Math.min(5, patternBonus))

  levelInteraction = Math.min(15, levelInteraction + patternBonus)

  // === 6. Volume (max 15) — strategy-aware ===
  let volume = 0

  if (strategy === 'breakout') {
    // Composite breakout volume quality
    // Instead of binary kill, grade the quality
    if (volRatio > 3.0) volume = 15
    else if (volRatio > 2.5) volume = 13
    else if (volRatio > 2.0) volume = 11
    else if (volRatio > 1.5) volume = 9
    else if (volRatio > 1.2) volume = 7
    else if (volRatio >= 1.0) volume = 5
    else if (volRatio >= 0.7) volume = 2 // soft penalty zone (was kill before)

    // Composite quality additions for breakout
    // Candle close near high (bullish conviction) or near low (bearish conviction)
    const lastCandle = tf1h
    if (lastCandle.atr > 0) {
      const candleSpread = Math.abs(lastCandle.price - (isLong ? lastCandle.support : lastCandle.resistance))
      const spreadRatio = candleSpread / lastCandle.atr
      if (spreadRatio > 1.2) volume = Math.min(15, volume + 2) // strong candle
    }
  } else if (strategy === 'trend_follow') {
    if (volRatio > 2.5) volume = 15
    else if (volRatio > 2.0) volume = 13
    else if (volRatio > 1.5) volume = 11
    else if (volRatio > 1.2) volume = 9
    else if (volRatio > 1.0) volume = 7
    else if (volRatio > 0.8) volume = 4
    else volume = 2
  } else {
    // Mean revert — volume is secondary
    if (volRatio > 2.0) volume = 15
    else if (volRatio > 1.5) volume = 12
    else if (volRatio > 1.0) volume = 9
    else if (volRatio > 0.7) volume = 6
    else volume = 4
  }

  // === 7. Market Context (max 15) — external data only ===
  let marketContext = 3 // base

  if (funding) {
    // Contrarian funding
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

  // === OI delta % (новый фактор) ===
  // Растущий OI + цена в направлении сделки = подтверждение набора позиций
  // Растущий OI против сделки = build-up против → риск ликвидации
  if (oi && Math.abs(oi.oiChangePct1h) > 0.1) {
    const oiUp = oi.oiChangePct1h > 0
    const oiStrong = Math.abs(oi.oiChangePct1h) > 2 // >2% за час = сильный набор
    if (isLong && oiUp) marketContext += oiStrong ? 2 : 1
    else if (!isLong && oiUp) marketContext += oiStrong ? 2 : 1
    // Падение OI на сильном движении = закрытие позиций (умеренный негатив)
    else if (oiStrong && !oiUp) marketContext -= 1
  }

  // === Liquidations cascade (новый фактор) ===
  // После массовых ликвидаций часто бывает reversal в обратную сторону.
  // Sell-сторонние ликвидации = вынесли лонгов → потенциал отскока (LONG бонус).
  // Buy-сторонние ликвидации = вынесли шортов → потенциал отката (SHORT бонус).
  if (liquidations && liquidations.totalUsd > 0) {
    const longLiq = liquidations.longsLiqUsd
    const shortLiq = liquidations.shortsLiqUsd
    const total = liquidations.totalUsd

    // Контртренд: сильно вынесли лонгов → reversal LONG
    if (isLong && longLiq > 100_000 && longLiq / total > 0.7) {
      if (longLiq > 1_000_000) marketContext += 4
      else if (longLiq > 500_000) marketContext += 3
      else marketContext += 2
    }
    // Контртренд: сильно вынесли шортов → reversal SHORT
    else if (!isLong && shortLiq > 100_000 && shortLiq / total > 0.7) {
      if (shortLiq > 1_000_000) marketContext += 4
      else if (shortLiq > 500_000) marketContext += 3
      else marketContext += 2
    }
    // По тренду: ликвидации в нашу сторону = риск, мы можем стать следующими
    else if (isLong && shortLiq > 500_000 && shortLiq / total > 0.7) {
      marketContext -= 1 // мы на стороне которая выносит — perekuplennost'
    }
    else if (!isLong && longLiq > 500_000 && longLiq / total > 0.7) {
      marketContext -= 1
    }
  }

  // === Long/Short Ratio (новый фактор) ===
  // Crowd extremes → contrarian
  // buyRatio > 0.7 = большинство в лонгах → contrarian SHORT
  // buyRatio < 0.3 = большинство в шортах → contrarian LONG
  if (lsr) {
    const longShare = lsr.buyRatio
    if (!isLong && longShare > 0.75) marketContext += 3 // crowded longs → SHORT
    else if (!isLong && longShare > 0.65) marketContext += 1
    else if (isLong && longShare < 0.25) marketContext += 3 // crowded shorts → LONG
    else if (isLong && longShare < 0.35) marketContext += 1
    // По тренду crowd = небольшой штраф
    else if (isLong && longShare > 0.75) marketContext -= 2
    else if (!isLong && longShare < 0.25) marketContext -= 2
  }

  // Fear & Greed
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext += 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_GREED') marketContext += 2
  if (type === 'LONG' && regime.fearGreedZone === 'EXTREME_GREED') marketContext -= 2
  if (type === 'SHORT' && regime.fearGreedZone === 'EXTREME_FEAR') marketContext -= 2

  // News
  if (news && news.total > 0) {
    if (type === 'LONG' && news.score > 30) marketContext += 2
    if (type === 'SHORT' && news.score < -30) marketContext += 2
  }

  marketContext = Math.max(0, Math.min(15, marketContext))

  // === Total Score ===
  // trendAdjusted already includes MTF multiplier
  // patternBonus already included in levelInteraction
  const rawScore = trendAdjusted + momentum + volatility + meanRevStretch + levelInteraction + volume + marketContext
  // Max theoretical: 15 + 15 + 10 + 10 + 15 + 15 + 15 = 95 (+ MTF multiplier can push trend)
  // Normalize to 0-100
  const score = Math.max(0, Math.min(100, rawScore))

  return {
    ...raw,
    score,
    volumeKill: false,
    scoreBreakdown: {
      trend: trendAdjusted,
      momentum,
      volatility,
      meanRevStretch,
      levelInteraction,
      volume,
      marketContext,
      mtfMultiplier: Math.round(mtfMultiplier * 100) / 100,
      patternBonus,
    },
  }
}
