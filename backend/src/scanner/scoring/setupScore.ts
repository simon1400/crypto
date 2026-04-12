import { MultiTFIndicators } from '../../services/indicators'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { LSRData } from '../../services/longShortRatio'
import { SetupScoreBreakdown, ScoringInput } from './types'
import { round2 } from '../utils/round'
import { calculateImpulseExtension, distanceToLevelR } from './hardFilters'

// === SETUP SCORE ===
// 6 components: trend(25) + location(25) + momentum(20) + derivatives(15) + geometry(15) + penalties
// Maximum = 100 (before penalties)
// Penalties can bring score below 0 (clamped to 0)

export function calculateSetupScore(input: ScoringInput): SetupScoreBreakdown {
  const { raw, funding, oi, lsr } = input
  const { type, strategy, indicators } = raw
  const { tf15m, tf1h, tf4h } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr = tf1h.atr

  const trend = calculateTrendScore(isLong, tf1h, tf4h)
  const location = calculateLocationScore(isLong, strategy, price, atr, tf1h, tf4h)
  const momentum = calculateMomentumScore(isLong, strategy, tf15m, tf1h)
  const derivatives = calculateDerivativesScore(isLong, funding, oi, lsr)
  const { score: geometry, riskPct, tp1Rr, tp2Rr } = calculateGeometryScore(isLong, price, atr, tf1h)
  const { score: penaltyScore, reasons: penaltyReasons } = calculatePenalties(
    isLong, strategy, price, atr, tf1h, tf4h, riskPct, funding, oi, input,
  )

  const total = Math.max(0, Math.min(100, trend + location + momentum + derivatives + geometry + penaltyScore))

  return {
    trend,
    location,
    momentum,
    derivatives,
    geometry,
    penalties: penaltyScore,
    total,
    penalties_applied: penaltyReasons,
  }
}

// === 3.1 Trend Score (0..25) ===
function calculateTrendScore(
  isLong: boolean,
  tf1h: MultiTFIndicators['tf1h'],
  tf4h: MultiTFIndicators['tf4h'],
): number {
  let score = 0

  if (isLong) {
    // +10: 4H close > EMA200 and EMA50 > EMA200
    if (tf4h.price > tf4h.ema200 && tf4h.ema50 > tf4h.ema200) score += 10
    else if (tf4h.price > tf4h.ema200) score += 6
    else if (tf4h.ema50 > tf4h.ema200) score += 3

    // +6: 1H close > EMA50
    if (tf1h.price > tf1h.ema50) score += 6
    else if (tf1h.price > tf1h.ema200) score += 3

    // +5: 1H structure is HH/HL (from swing detection)
    if (tf1h.marketStructure === 'HH_HL') score += 5
    else if (tf1h.trendDetail === 'BULLISH' || tf1h.trendDetail === 'BULLISH_PULLBACK') score += 3

    // +4: ADX 1H between 18 and 35
    if (tf1h.adx >= 18 && tf1h.adx <= 35) score += 4
    else if (tf1h.adx > 35) score += 2
  } else {
    // SHORT mirror
    if (tf4h.price < tf4h.ema200 && tf4h.ema50 < tf4h.ema200) score += 10
    else if (tf4h.price < tf4h.ema200) score += 6
    else if (tf4h.ema50 < tf4h.ema200) score += 3

    if (tf1h.price < tf1h.ema50) score += 6
    else if (tf1h.price < tf1h.ema200) score += 3

    // 1H structure is LH/LL
    if (tf1h.marketStructure === 'LH_LL') score += 5
    else if (tf1h.trendDetail === 'BEARISH' || tf1h.trendDetail === 'BEARISH_PULLBACK') score += 3

    if (tf1h.adx >= 18 && tf1h.adx <= 35) score += 4
    else if (tf1h.adx > 35) score += 2
  }

  return Math.min(25, score)
}

// === 3.2 Location Score (0..25) ===
function calculateLocationScore(
  isLong: boolean,
  strategy: string,
  price: number,
  atr: number,
  tf1h: MultiTFIndicators['tf1h'],
  tf4h: MultiTFIndicators['tf4h'],
): number {
  let score = 0

  if (isLong) {
    // +10: price near EMA20 / VWAP / local support
    const nearEma20 = Math.abs(price - tf1h.ema20) / atr < 0.5
    const nearVwap = Math.abs(price - tf1h.vwap) / atr < 0.5
    const nearSupport = Math.abs(price - tf1h.support) / atr < 0.5
    if (nearEma20 || nearVwap || nearSupport) score += 10
    else if (Math.abs(price - tf1h.ema20) / atr < 1.0) score += 5

    // +8: setup is after pullback, not after extended impulse
    // Use trendDetail for explicit pullback detection
    if (tf1h.trendDetail === 'BULLISH_PULLBACK') {
      score += 8 // explicit pullback in uptrend
    } else {
      const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr)
      if (impulseExt <= 0.3) score += 8
      else if (impulseExt <= 0.6) score += 4
    }

    // +7: nearest resistance at least 1.8R away
    const roughStop = price - atr * 1.5
    const distResR = distanceToLevelR(price, tf1h.resistance, roughStop)
    if (distResR >= 1.8) score += 7
    else if (distResR >= 1.3) score += 4
  } else {
    // SHORT mirror
    const nearEma20 = Math.abs(price - tf1h.ema20) / atr < 0.5
    const nearVwap = Math.abs(price - tf1h.vwap) / atr < 0.5
    const nearResistance = Math.abs(price - tf1h.resistance) / atr < 0.5
    if (nearEma20 || nearVwap || nearResistance) score += 10
    else if (Math.abs(price - tf1h.ema20) / atr < 1.0) score += 5

    if (tf1h.trendDetail === 'BEARISH_PULLBACK') {
      score += 8
    } else {
      const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr)
      if (impulseExt <= 0.3) score += 8
      else if (impulseExt <= 0.6) score += 4
    }

    const roughStop = price + atr * 1.5
    const distSupR = distanceToLevelR(price, tf1h.support, roughStop)
    if (distSupR >= 1.8) score += 7
    else if (distSupR >= 1.3) score += 4
  }

  return Math.min(25, score)
}

// === 3.3 Momentum Score (0..20) ===
function calculateMomentumScore(
  isLong: boolean,
  strategy: string,
  tf15m: MultiTFIndicators['tf15m'],
  tf1h: MultiTFIndicators['tf1h'],
): number {
  let score = 0

  if (isLong) {
    // +8: signal candle volume > 1.3x avg20
    if (tf1h.volRatio > 1.3) score += 8
    else if (tf1h.volRatio > 1.0) score += 4

    // +6: RSI 1H between 52 and 68
    if (strategy === 'mean_revert') {
      // Mean-revert LONG: extreme RSI is good
      if (tf1h.rsi < 30) score += 6
      else if (tf1h.rsi < 40) score += 3
    } else {
      if (tf1h.rsi >= 52 && tf1h.rsi <= 68) score += 6
      else if (tf1h.rsi >= 45 && tf1h.rsi <= 72) score += 3
    }

    // +6: MACD histogram rising, no bearish divergence on lower TF
    if (tf1h.macdHistogram > 0 && tf15m.macdHistogram > 0) score += 6
    else if (tf1h.macdHistogram > 0) score += 3
    // Check for bearish divergence on 15m (15m RSI falling while 1h rising)
    if (tf15m.rsi < tf1h.rsi - 10 && tf1h.rsi > 60) score -= 2
  } else {
    // SHORT mirror
    if (tf1h.volRatio > 1.3) score += 8
    else if (tf1h.volRatio > 1.0) score += 4

    if (strategy === 'mean_revert') {
      if (tf1h.rsi > 70) score += 6
      else if (tf1h.rsi > 60) score += 3
    } else {
      if (tf1h.rsi >= 32 && tf1h.rsi <= 48) score += 6
      else if (tf1h.rsi >= 28 && tf1h.rsi <= 55) score += 3
    }

    if (tf1h.macdHistogram < 0 && tf15m.macdHistogram < 0) score += 6
    else if (tf1h.macdHistogram < 0) score += 3
    if (tf15m.rsi > tf1h.rsi + 10 && tf1h.rsi < 40) score -= 2
  }

  return Math.max(0, Math.min(20, score))
}

// === 3.4 Derivatives Score (0..15) ===
function calculateDerivativesScore(
  isLong: boolean,
  funding?: FundingData | null,
  oi?: OIData | null,
  lsr?: LSRData | null,
): number {
  let score = 0

  if (isLong) {
    // +6: OI rising with price (healthy accumulation)
    if (oi && oi.oiChangePct1h > 0.5) score += 6
    else if (oi && oi.oiChangePct1h > 0) score += 3

    // +5: funding neutral or moderately supportive (-0.01% to +0.03%)
    if (funding) {
      const rate = funding.fundingRate
      if (rate >= -0.0001 && rate <= 0.0003) score += 5
      else if (rate >= -0.0003 && rate <= 0.0005) score += 3
      // Overheated long funding = bad for LONG
      if (rate > 0.001) score -= 2
    }

    // +4: long crowding not extreme
    if (lsr) {
      if (lsr.buyRatio <= 0.65) score += 4
      else if (lsr.buyRatio <= 0.75) score += 2
      // Extreme long crowding
      if (lsr.buyRatio > 0.8) score -= 2
    }
  } else {
    // SHORT mirror
    if (oi && oi.oiChangePct1h > 0.5) score += 6
    else if (oi && oi.oiChangePct1h > 0) score += 3

    // Funding overheated on long side supports short thesis
    if (funding) {
      const rate = funding.fundingRate
      if (rate > 0.0005) score += 5
      else if (rate > 0.0003) score += 3
      // Negative funding = bad for SHORT
      if (rate < -0.001) score -= 2
    }

    // Crowding supports short edge
    if (lsr) {
      if (lsr.buyRatio >= 0.65) score += 4
      else if (lsr.buyRatio >= 0.55) score += 2
      // Extreme short crowding
      if (lsr.buyRatio < 0.2) score -= 2
    }
  }

  return Math.max(0, Math.min(15, score))
}

// === 3.5 Geometry Score (0..15) ===
function calculateGeometryScore(
  isLong: boolean,
  price: number,
  atr: number,
  tf1h: MultiTFIndicators['tf1h'],
): { score: number; riskPct: number; tp1Rr: number; tp2Rr: number } {
  let score = 0

  // Calculate risk_pct (SL distance as % of entry)
  const slDistance = atr * 1.5
  const riskPct = round2((slDistance / price) * 100)

  // Calculate R:R for TPs with standardized exits (1.2R, 2.2R, 3.5R)
  const tp1Rr = 1.2
  const tp2Rr = 2.2

  // +6: risk_pct between 1.2 and 3.5
  if (riskPct >= 1.2 && riskPct <= 3.5) score += 6
  else if (riskPct >= 0.8 && riskPct <= 4.0) score += 3

  // +5: TP1 >= 1.2R (always true with standardized exits, but check actual room)
  const resistance = isLong ? tf1h.resistance : tf1h.support
  const roomR = distanceToLevelR(price, resistance, isLong ? price - slDistance : price + slDistance)
  if (roomR >= 1.2) score += 5
  else if (roomR >= 0.8) score += 2

  // +4: TP2 >= 2.2R
  if (roomR >= 2.2) score += 4
  else if (roomR >= 1.5) score += 2

  return { score: Math.min(15, score), riskPct, tp1Rr, tp2Rr }
}

// === 3.6 Penalties ===
function calculatePenalties(
  isLong: boolean,
  strategy: string,
  price: number,
  atr: number,
  tf1h: MultiTFIndicators['tf1h'],
  tf4h: MultiTFIndicators['tf4h'],
  riskPct: number,
  funding?: FundingData | null,
  oi?: OIData | null,
  input?: ScoringInput,
): { score: number; reasons: string[] } {
  let penalty = 0
  const reasons: string[] = []

  // -15: entry after impulse without pullback
  const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr)
  if (impulseExt > 0.9) {
    penalty -= 15
    reasons.push(`-15: вход после импульса без отката (extension=${impulseExt} ATR)`)
  }

  // -12: nearest opposing level < 1R away
  const slDistance = atr * 1.5
  const opposingLevel = isLong ? tf1h.resistance : tf1h.support
  const opposingR = distanceToLevelR(price, opposingLevel, isLong ? price - slDistance : price + slDistance)
  if (opposingR < 1.0 && opposingR > 0) {
    penalty -= 12
    reasons.push(`-12: ближайший уровень ${isLong ? 'сопротивления' : 'поддержки'} < 1R (${opposingR}R)`)
  }

  // -10: risk_pct > 4.5
  if (riskPct > 4.5) {
    penalty -= 10
    reasons.push(`-10: risk ${riskPct}% > 4.5% максимума`)
  }

  // -8: funding / OI context looks like late crowded move
  if (funding && oi) {
    const isLateCrowd = isLong
      ? funding.fundingRate > 0.001 && oi.oiChangePct1h > 2
      : funding.fundingRate < -0.001 && oi.oiChangePct1h > 2
    if (isLateCrowd) {
      penalty -= 8
      reasons.push(`-8: признаки позднего входа в перегруженную сторону (funding=${round2(funding.fundingRate * 100)}%, OI +${round2(oi.oiChangePct1h)}%)`)
    }
  }

  // -8: ADX < 15 for trend-follow
  if (strategy === 'trend_follow' && tf1h.adx < 15) {
    penalty -= 8
    reasons.push(`-8: ADX ${tf1h.adx} < 15 для trend-follow — тренд слабый`)
  }

  // -6: required data fields missing
  const dataCompleteness = input
    ? (input.funding ? 1 : 0) + (input.oi ? 1 : 0) + (input.lsr ? 1 : 0)
    : 3
  if (dataCompleteness < 2) {
    penalty -= 6
    reasons.push(`-6: отсутствуют данные (${3 - dataCompleteness} из 3 полей недоступны)`)
  }

  // -5: 1H and 4H trend conflict
  if (tf1h.trend !== tf4h.trend && tf1h.trend !== 'SIDEWAYS' && tf4h.trend !== 'SIDEWAYS') {
    penalty -= 5
    reasons.push(`-5: конфликт трендов 1h=${tf1h.trend} vs 4h=${tf4h.trend}`)
  }

  return { score: penalty, reasons }
}

// === Category Assignment ===
export function assignSignalCategory(setupScore: number): import('./types').SetupCategory {
  if (setupScore >= 72) return 'A_PLUS_READY'
  if (setupScore >= 64) return 'READY'
  if (setupScore >= 56) return 'WATCHLIST'
  return 'IGNORE'
}
