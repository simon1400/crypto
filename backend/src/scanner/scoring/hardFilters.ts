import { MultiTFIndicators } from '../../services/indicators'
import { RegimeContext } from '../marketRegime'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { LSRData } from '../../services/longShortRatio'
import {
  ExtendedMarketRegime,
  BtcRegime,
  HardFilterResult,
  ScoringInput,
} from './types'
import { round2 } from '../utils/round'

// === Extended Market Regime Detection ===
// Adds STRONG_TRENDING_UP/DOWN based on ADX and confidence
export function detectExtendedRegime(regime: RegimeContext): ExtendedMarketRegime {
  if (regime.regime === 'TRENDING_UP' && regime.confidence >= 80) return 'STRONG_TRENDING_UP'
  if (regime.regime === 'TRENDING_UP') return 'TRENDING_UP'
  if (regime.regime === 'TRENDING_DOWN' && regime.confidence >= 80) return 'STRONG_TRENDING_DOWN'
  if (regime.regime === 'TRENDING_DOWN') return 'TRENDING_DOWN'
  if (regime.regime === 'RANGING') return 'RANGING'
  return 'VOLATILE'
}

// === BTC Regime Detection ===
// Simplified BTC posture for hard filter gating
export function detectBtcRegime(regime: RegimeContext): BtcRegime {
  if (regime.btcTrend === 'BULLISH' && regime.regime === 'TRENDING_UP') return 'RISK_ON_UP_ONLY'
  if (regime.btcTrend === 'BEARISH' && regime.regime === 'TRENDING_DOWN') return 'RISK_OFF'
  return 'NEUTRAL'
}

// === Data Completeness ===
// Measures how many expected data fields are actually available
export function calculateDataCompleteness(
  funding?: FundingData | null,
  oi?: OIData | null,
  lsr?: LSRData | null,
): number {
  let available = 0
  let total = 3 // funding, OI, LSR are the core data fields

  if (funding && funding.fundingRate !== undefined) available++
  if (oi && oi.openInterest > 0) available++
  if (lsr) available++

  return round2(available / total)
}

// === Impulse Extension ===
// Measures how far price has moved from EMA20 in ATR units
// High values = chasing after impulse, bad for entry
export function calculateImpulseExtension(
  price: number,
  ema20: number,
  atr: number,
): number {
  if (atr <= 0) return 0
  return round2(Math.abs(price - ema20) / atr)
}

// === Distance to Level in R-multiples ===
export function distanceToLevelR(
  price: number,
  level: number,
  stopLoss: number,
): number {
  const risk = Math.abs(price - stopLoss)
  if (risk <= 0) return 0
  return round2(Math.abs(level - price) / risk)
}

// === Liquidity Check ===
// Simplified: volume must be above minimum threshold
export function checkLiquidity(volRatio: number): boolean {
  return volRatio >= 0.5
}

// === HARD FILTERS ===
// These are pass/fail gates. A signal that fails ANY hard filter is not eligible.

export function calculateHardFilters(input: ScoringInput): HardFilterResult {
  const { raw, extendedRegime, btcRegime } = input
  const { type, strategy, indicators } = raw
  const { tf1h, tf4h } = indicators
  const isLong = type === 'LONG'

  const failures: string[] = []

  // Calculate helper values
  const price = tf1h.price
  const atr = tf1h.atr
  const riskPct = atr > 0 ? round2((atr * 1.5 / price) * 100) : 5 // rough SL estimate
  const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr)
  const dataCompleteness = calculateDataCompleteness(input.funding, input.oi, input.lsr)
  const liquidityOk = checkLiquidity(tf1h.volRatio)

  // Rough R-distance to opposing level
  const roughStop = isLong ? price - atr * 1.5 : price + atr * 1.5
  const distResR = isLong ? distanceToLevelR(price, tf1h.resistance, roughStop) : 0
  const distSupR = !isLong ? distanceToLevelR(price, tf1h.support, roughStop) : 0

  // === Universal directional regime gate ===
  // Block direction-against-regime signals across ALL strategies.
  // Week 1 audit: 9 SHORT trades on bullish market lost -52 USDT (33% WR);
  // 70 LONG trades made +337 (69% WR). Counter-regime signals systematically
  // give back. Apply BEFORE strategy-specific filters so mean_revert and
  // breakout are gated too.
  let market_regime_ok = true
  let btc_regime_ok = true

  if (isLong) {
    if (btcRegime === 'RISK_OFF' || extendedRegime === 'STRONG_TRENDING_DOWN') {
      market_regime_ok = false
      btc_regime_ok = false
      failures.push(`Bearish regime (${extendedRegime}/${btcRegime}) — LONG disabled`)
    }
  } else {
    if (btcRegime === 'RISK_ON_UP_ONLY' || extendedRegime === 'STRONG_TRENDING_UP') {
      market_regime_ok = false
      btc_regime_ok = false
      failures.push(`Bullish regime (${extendedRegime}/${btcRegime}) — SHORT disabled`)
    }
  }

  // === Strategy-specific hard filters ===
  let trend_4h_ok = true
  let trend_1h_ok = true
  let risk_pct_ok = riskPct <= 4.0
  let distance_ok = true
  let impulse_ok = impulseExt <= 0.9
  let liquidity_ok_flag = liquidityOk
  let data_completeness_ok = dataCompleteness >= 0.9

  if (strategy === 'trend_follow') {
    if (isLong) {
      // LONG trend-follow hard filters — use EMA200 for long-term trend
      const stratRegimeOk = extendedRegime === 'TRENDING_UP' || extendedRegime === 'STRONG_TRENDING_UP'
      market_regime_ok = market_regime_ok && stratRegimeOk
      btc_regime_ok = btc_regime_ok && (btcRegime !== 'RISK_OFF')
      // 4h: price above EMA200 and EMA50 > EMA200 (true long-term bullish)
      trend_4h_ok = tf4h.price > tf4h.ema200 && tf4h.ema50 > tf4h.ema200
      // 1h: bullish or bullish pullback (allow entries on dips)
      trend_1h_ok = tf1h.trendDetail === 'BULLISH' || tf1h.trendDetail === 'BULLISH_PULLBACK'
      distance_ok = distResR >= 1.3

      if (!stratRegimeOk) failures.push(`Режим рынка ${extendedRegime} не подходит для LONG trend-follow`)
      if (!trend_4h_ok) failures.push(`4h: цена${tf4h.price <= tf4h.ema200 ? ' ниже EMA200' : ''}, EMA50${tf4h.ema50 <= tf4h.ema200 ? ' < EMA200' : ''} — нет бычьего контекста`)
      if (!trend_1h_ok) failures.push(`1h тренд ${tf1h.trendDetail} — нужен BULLISH или BULLISH_PULLBACK`)
      if (!distance_ok) failures.push(`Расстояние до сопротивления ${distResR}R < 1.3R`)
    } else {
      // SHORT trend-follow hard filters
      const stratRegimeOk = extendedRegime === 'TRENDING_DOWN' || extendedRegime === 'STRONG_TRENDING_DOWN'
      market_regime_ok = market_regime_ok && stratRegimeOk
      btc_regime_ok = btc_regime_ok && (btcRegime !== 'RISK_ON_UP_ONLY')
      trend_4h_ok = tf4h.price < tf4h.ema200 && tf4h.ema50 < tf4h.ema200
      trend_1h_ok = tf1h.trendDetail === 'BEARISH' || tf1h.trendDetail === 'BEARISH_PULLBACK'
      distance_ok = distSupR >= 1.3

      if (!stratRegimeOk) failures.push(`Режим рынка ${extendedRegime} не подходит для SHORT trend-follow`)
      if (!trend_4h_ok) failures.push(`4h: цена${tf4h.price >= tf4h.ema200 ? ' выше EMA200' : ''}, EMA50${tf4h.ema50 >= tf4h.ema200 ? ' > EMA200' : ''} — нет медвежьего контекста`)
      if (!trend_1h_ok) failures.push(`1h тренд ${tf1h.trendDetail} — нужен BEARISH или BEARISH_PULLBACK`)
      if (!distance_ok) failures.push(`Расстояние до поддержки ${distSupR}R < 1.3R`)
    }
  } else if (strategy === 'mean_revert') {
    // Mean-revert: only in RANGING (universal directional gate already applied above)
    const stratRegimeOk = extendedRegime === 'RANGING'
    market_regime_ok = market_regime_ok && stratRegimeOk
    trend_4h_ok = true
    trend_1h_ok = true

    if (!stratRegimeOk) failures.push(`Режим рынка ${extendedRegime} не RANGING для mean-revert`)
  } else {
    // Breakout: universal directional gate above already blocks STRONG counter-trend.
    // No further regime restriction here — keep breakout permissive within allowed direction.
  }

  // Universal checks
  if (!risk_pct_ok) failures.push(`Risk ${riskPct}% > 4.0% максимума`)
  if (!impulse_ok) failures.push(`Impulse extension ${impulseExt} ATR > 0.9 — вход после импульса`)
  if (!liquidity_ok_flag) failures.push(`Ликвидность низкая: volRatio=${tf1h.volRatio}x`)
  if (!data_completeness_ok) failures.push(`Полнота данных ${round2(dataCompleteness * 100)}% < 90%`)

  const passed = failures.length === 0

  return {
    passed,
    failures,
    market_regime_ok,
    btc_regime_ok,
    trend_4h_ok,
    trend_1h_ok,
    risk_pct_ok,
    distance_to_opposing_level_ok: distance_ok,
    impulse_extension_ok: impulse_ok,
    liquidity_ok: liquidity_ok_flag,
    data_completeness_ok,
  }
}
