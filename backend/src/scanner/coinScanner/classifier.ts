import { SignalWithRisk } from '../riskCalc'
import { RegimeContext } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'
import { SignalCategory, ScoreBand, EntryQuality, TriggerState } from './types'

/**
 * Classification pipeline:
 *   scoreBand + entryQuality + conflicts + trigger → SignalCategory
 *
 * Вынесено из coinScanner.ts чтобы держать там только оркестрацию runScan().
 */

// === Score Band ===
export function getScoreBand(score: number): ScoreBand {
  if (score >= 70) return 'STRONG'
  if (score >= 60) return 'ACTIONABLE'
  if (score >= 50) return 'CONDITIONAL'
  if (score >= 40) return 'OBSERVATIONAL'
  return 'LOW_QUALITY'
}

// === Entry Quality ===
// Separate from signal quality: "is the idea good?" vs "can I enter now?"
// Checks: proximity to levels, RSI on BOTH timeframes, momentum fade,
//         conflicting patterns, volume, SL distance, model type
export function assessEntryQuality(signal: SignalWithRisk): EntryQuality {
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'
  let quality = 0 // higher = worse entry timing

  // 1. Price near resistance (LONG) or support (SHORT) — use both 1h and 4h (4h stronger)
  if (isLong) {
    const dist1h = (tf1h.resistance - tf1h.price) / tf1h.atr
    const dist4h = (tf4h.resistance - tf1h.price) / tf1h.atr
    if (dist1h < 0.5) quality += 2
    else if (dist1h < 1.0) quality += 1
    if (dist4h < 0.5) quality += 2
  } else {
    const dist1h = (tf1h.price - tf1h.support) / tf1h.atr
    const dist4h = (tf1h.price - tf4h.support) / tf1h.atr
    if (dist1h < 0.5) quality += 2
    else if (dist1h < 1.0) quality += 1
    if (dist4h < 0.5) quality += 2
  }

  // 2. RSI overextended — check BOTH 1h and 4h
  if (isLong) {
    if (tf1h.rsi > 68) quality += 2
    else if (tf1h.rsi > 60) quality += 1
    if (tf4h.rsi > 70) quality += 2
    else if (tf4h.rsi > 65) quality += 1
  } else {
    if (tf1h.rsi < 32) quality += 2
    else if (tf1h.rsi < 40) quality += 1
    if (tf4h.rsi < 30) quality += 2
    else if (tf4h.rsi < 35) quality += 1
  }

  // 3. MACD histogram — not just negative, also near zero (losing steam)
  if (isLong) {
    if (tf1h.macdHistogram < 0) quality += 2
    else if (Math.abs(tf1h.macdHistogram) < tf1h.atr * 0.01) quality += 1
  } else {
    if (tf1h.macdHistogram > 0) quality += 2
    else if (Math.abs(tf1h.macdHistogram) < tf1h.atr * 0.01) quality += 1
  }

  // 4. Conflicting candlestick patterns on 1h
  const bearish1h = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'DOUBLE_TOP']
  const bullish1h = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'DOUBLE_BOTTOM']
  const conflicting = isLong ? bearish1h : bullish1h
  const conflictCount = tf1h.patterns.filter(p => conflicting.includes(p)).length
  if (conflictCount >= 2) quality += 3
  else if (conflictCount === 1) quality += 1

  // 5. Volume weak
  if (tf1h.volRatio < 0.8) quality += 1

  // 6. SL distance too tight
  if (signal.slPercent < 0.8) quality += 1

  // 7. Best model is pullback only
  if (signal.bestEntryType === 'pullback') quality += 1

  // 8. Stochastic overextended
  if (isLong && tf1h.stochK > 80) quality += 1
  if (!isLong && tf1h.stochK < 20) quality += 1

  if (quality <= 1) return 'GOOD'
  if (quality <= 3) return 'FAIR'
  if (quality <= 5) return 'POOR'
  return 'CHASING'
}

// === Trigger State Detection ===
// For WAIT_CONFIRMATION: what specific event would validate entry?
export function detectTrigger(signal: SignalWithRisk): TriggerState | null {
  const { tf1h } = signal.indicators
  const isLong = signal.type === 'LONG'
  const r = (v: number) => Math.round(v * 10000) / 10000
  const r2 = (v: number) => Math.round(v * 100) / 100

  // Breakout: near level but not through with volume
  if (signal.strategy === 'breakout') {
    if (isLong && tf1h.price > tf1h.resistance * 0.995 && tf1h.price < tf1h.resistance * 1.005) {
      return {
        triggerType: 'breakout_close_above',
        triggerLevel: r(tf1h.resistance),
        triggerTf: '1h',
        invalidIf: `цена теряет EMA20 1h ($${r2(tf1h.ema20)})`,
      }
    }
    if (!isLong && tf1h.price < tf1h.support * 1.005 && tf1h.price > tf1h.support * 0.995) {
      return {
        triggerType: 'breakout_close_below',
        triggerLevel: r(tf1h.support),
        triggerTf: '1h',
        invalidIf: `цена возвращается выше EMA20 1h ($${r2(tf1h.ema20)})`,
      }
    }
  }

  // Trend follow: price above EMA but volume not confirming
  if (signal.strategy === 'trend_follow' && signal.scoreBreakdown.volume < 5) {
    return {
      triggerType: 'volume_confirm',
      triggerLevel: tf1h.price,
      triggerTf: '1h',
      invalidIf: `цена ниже EMA20 на 1h ($${r2(tf1h.ema20)})`,
    }
  }

  // Mean revert: RSI extreme but no reversal candle yet
  if (signal.strategy === 'mean_revert') {
    if (isLong && tf1h.rsi < 35 && tf1h.macdHistogram < 0) {
      return {
        triggerType: 'macd_cross',
        triggerLevel: tf1h.price,
        triggerTf: '1h',
        invalidIf: `новый лоу ниже $${r2(tf1h.support)}`,
      }
    }
    if (!isLong && tf1h.rsi > 65 && tf1h.macdHistogram > 0) {
      return {
        triggerType: 'macd_cross',
        triggerLevel: tf1h.price,
        triggerTf: '1h',
        invalidIf: `новый хай выше $${r2(tf1h.resistance)}`,
      }
    }
  }

  return null
}

// Detect strong cross-layer contradictions (quant only, no GPT)
export function detectStrongConflicts(signal: SignalWithRisk, coinRegime?: CoinRegimeContext): number {
  let conflicts = 0
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'

  // 1. Direction vs 4h bias with strong ADX (skip if coin has own momentum)
  const hasOwnMomentum = coinRegime?.ownMomentum ?? false
  if (!hasOwnMomentum) {
    if (isLong && tf4h.trend === 'BEARISH' && tf4h.adx > 25) conflicts++
    if (!isLong && tf4h.trend === 'BULLISH' && tf4h.adx > 25) conflicts++
  }

  // 2. Breakout directly into major resistance/support (< 0.5 ATR away on 4h)
  if (signal.strategy === 'breakout') {
    const distToLevel = isLong
      ? (tf4h.resistance - tf1h.price) / tf1h.atr
      : (tf1h.price - tf4h.support) / tf1h.atr
    if (distToLevel < 0.5 && distToLevel > 0) conflicts++
  }

  // 3. Trend follow with hostile market context
  if (signal.strategy === 'trend_follow' && signal.scoreBreakdown.marketContext <= 1) conflicts++

  // 4. Mean reversion in strong trend (ADX > 30)
  if (signal.strategy === 'mean_revert' && tf4h.adx > 30) conflicts++

  // 5. Mean reversion LONG while both TFs momentum falling
  if (signal.strategy === 'mean_revert') {
    if (isLong && tf1h.macdHistogram < 0 && tf4h.macdHistogram < 0 && tf4h.adx > 25) conflicts++
    if (!isLong && tf1h.macdHistogram > 0 && tf4h.macdHistogram > 0 && tf4h.adx > 25) conflicts++
  }

  // 6. Market context extremely hostile (funding squeeze risk)
  if (signal.scoreBreakdown.marketContext <= 0) conflicts++

  return conflicts
}

// === CLASSIFICATION ===
// Score band + entry quality + conflicts + triggers → category
export function classifySignal(
  signal: SignalWithRisk,
  scoreBand: ScoreBand,
  entryQuality: EntryQuality,
  trigger: TriggerState | null,
  coinRegime?: CoinRegimeContext,
): SignalCategory {
  const viableModels = signal.entryModels.filter(m => m.viable)

  // REJECTED: no viable entry at all
  if (viableModels.length === 0) return 'REJECTED'

  // REJECTED: score too low for any action
  if (scoreBand === 'LOW_QUALITY') return 'REJECTED'

  // CONFLICTED: 2+ strong cross-layer contradictions
  const strongConflicts = detectStrongConflicts(signal, coinRegime)
  if (strongConflicts >= 2) return 'CONFLICTED'

  // WAIT_CONFIRMATION: has a specific trigger
  if (trigger && scoreBand !== 'OBSERVATIONAL') {
    return 'WAIT_CONFIRMATION'
  }

  // LATE_ENTRY: only aggressive viable AND R:R is close to minimum
  if (viableModels.length === 1 && viableModels[0].type === 'aggressive') {
    if (scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE') {
      return 'READY_AGGRESSIVE'
    }
    return 'LATE_ENTRY'
  }

  // PULLBACK_WATCH: signal good but entry is chasing
  if (entryQuality === 'CHASING' && (scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE')) {
    return 'PULLBACK_WATCH'
  }

  // READY: score >= ACTIONABLE + entry at least FAIR + has viable models
  if ((scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE') && (entryQuality === 'GOOD' || entryQuality === 'FAIR')) {
    return 'READY'
  }

  // CONDITIONAL band (50-59): can be READY if entry is good and no conflicts
  if (scoreBand === 'CONDITIONAL' && entryQuality === 'GOOD' && strongConflicts === 0) {
    return 'READY'
  }

  // WATCHLIST: everything else that isn't broken
  return 'WATCHLIST'
}

// Dynamic top-N based on regime
export function getTopN(regime: RegimeContext): number {
  switch (regime.regime) {
    case 'TRENDING_UP':
    case 'TRENDING_DOWN':
    case 'VOLATILE':
      return 20
    case 'RANGING':
      return 8
    default:
      return 15
  }
}
