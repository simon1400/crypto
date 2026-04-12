import { MultiTFIndicators } from '../../services/indicators'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { LSRData } from '../../services/longShortRatio'
import {
  SignalExplanation,
  SignalContext,
  HardFilterResult,
  SetupScoreBreakdown,
  EntryTriggerResult,
  SetupCategory,
  ExecutionType,
  EntryModelType,
  RiskProfile,
  LimitEntryPlan,
  MarketEntryPlan,
  ExtendedMarketRegime,
  BtcRegime,
} from './types'
import { round2 } from '../utils/round'
import { calculateImpulseExtension, calculateDataCompleteness, distanceToLevelR } from './hardFilters'

// === BUILD SIGNAL CONTEXT ===
// All context fields persisted with each signal for historical analysis

export function buildSignalContext(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  extendedRegime: ExtendedMarketRegime,
  btcRegime: BtcRegime,
  entryModel: EntryModelType,
  stopLoss: number,
  takeProfits: { price: number; rr: number }[],
  funding?: FundingData | null,
  oi?: OIData | null,
  lsr?: LSRData | null,
): SignalContext {
  const { tf1h } = indicators
  const price = tf1h.price
  const atr = tf1h.atr

  const roughStop = stopLoss
  const distResR = distanceToLevelR(price, tf1h.resistance, roughStop)
  const distSupR = distanceToLevelR(price, tf1h.support, roughStop)

  return {
    // Market context
    market_regime: extendedRegime,
    btc_regime: btcRegime,
    trend_4h: indicators.tf4h.trend,
    trend_1h: tf1h.trend,
    // Entry context
    distance_to_ema20: round2(((price - tf1h.ema20) / price) * 100),
    distance_to_vwap: round2(((price - tf1h.vwap) / price) * 100),
    distance_to_support: round2(((price - tf1h.support) / price) * 100),
    distance_to_resistance: round2(((tf1h.resistance - price) / price) * 100),
    distance_to_resistance_r: round2(distResR),
    distance_to_support_r: round2(distSupR),
    atr_1h_pct: round2((atr / price) * 100),
    impulse_extension_at_entry_atr_1h: round2(calculateImpulseExtension(price, tf1h.ema20, atr)),
    entry_model: entryModel,
    // Indicators
    rsi_1h: tf1h.rsi,
    adx_1h: tf1h.adx,
    macd_hist_1h: round2(tf1h.macdHistogram),
    volume_ratio: tf1h.volRatio,
    oi_change_1h: oi?.oiChangePct1h ?? 0,
    oi_change_4h: oi?.oiChangePct4h ?? 0,
    funding_rate: funding?.fundingRate ?? 0,
    long_short_ratio: lsr?.buyRatio ?? 0.5,
    // Risk / geometry
    initial_stop: stopLoss,
    current_stop: stopLoss, // same at creation time
    risk_pct: round2(Math.abs((stopLoss - price) / price) * 100),
    tp1_rr: takeProfits[0]?.rr ?? 0,
    tp2_rr: takeProfits[1]?.rr ?? 0,
    tp3_rr: takeProfits[2]?.rr ?? 0,
    // Data completeness
    data_completeness: calculateDataCompleteness(funding, oi, lsr),
  }
}

// === BUILD SIGNAL EXPLANATION ===
// Structured explanation for logging and UI

export function buildSignalExplanation(
  hardFilter: HardFilterResult,
  setupBreakdown: SetupScoreBreakdown,
  entryTrigger: EntryTriggerResult,
  category: SetupCategory,
  executionType: ExecutionType,
  entryModel: EntryModelType,
  riskProfile: RiskProfile,
  limitPlan: LimitEntryPlan | null,
  marketPlan: MarketEntryPlan | null,
): SignalExplanation {
  // Determine invalidation reason
  let invalidation_reason: string | null = null
  if (!hardFilter.passed) {
    invalidation_reason = `Hard filter: ${hardFilter.failures.join('; ')}`
  } else if (category === 'IGNORE') {
    invalidation_reason = `Setup score ${setupBreakdown.total} < 56 (IGNORE)`
  } else if (executionType === 'IGNORE') {
    invalidation_reason = 'Execution type: IGNORE'
  }

  return {
    hard_filter_result: hardFilter,
    setup_score: setupBreakdown.total,
    setup_score_breakdown: setupBreakdown,
    penalties_applied: setupBreakdown.penalties_applied,
    category,
    entry_trigger_score: entryTrigger,
    entry_trigger_conditions: entryTrigger.details,
    execution_type: executionType,
    recommended_entry_model: entryModel,
    recommended_risk_profile: riskProfile,
    invalidation_reason,
    limit_entry_plan: limitPlan,
    market_entry_plan: marketPlan,
  }
}
