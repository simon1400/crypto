import { MultiTFIndicators } from '../../services/indicators'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { NewsSentiment } from '../../services/news'
import { LiquidationStats } from '../../services/liquidations'
import { LSRData } from '../../services/longShortRatio'
import { RegimeContext, MarketRegime } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'
import { RawSignal } from '../strategies/index'
import { OHLCV } from '../../services/market'

// === Extended Market Regime ===
// Add STRONG variants for hard filter discrimination
export type ExtendedMarketRegime =
  | 'STRONG_TRENDING_UP'
  | 'TRENDING_UP'
  | 'RANGING'
  | 'TRENDING_DOWN'
  | 'STRONG_TRENDING_DOWN'
  | 'VOLATILE'

// BTC regime for hard filters
export type BtcRegime = 'RISK_ON_UP_ONLY' | 'NEUTRAL' | 'RISK_OFF'

// === Setup Categories (stored explicitly) ===
export type SetupCategory = 'A_PLUS_READY' | 'READY' | 'WATCHLIST' | 'IGNORE'

// === Execution Types ===
export type ExecutionType =
  | 'ENTER_NOW_LONG'
  | 'ENTER_NOW_SHORT'
  | 'LIMIT_LONG'
  | 'LIMIT_SHORT'
  | 'WAIT_CONFIRMATION'
  | 'IGNORE'

// === Entry Model ===
export type EntryModelType = 'aggressive' | 'confirmation'

// === Hard Filter Result ===
export interface HardFilterResult {
  passed: boolean
  failures: string[]  // human-readable reasons for rejection
  // Individual checks for logging
  market_regime_ok: boolean
  btc_regime_ok: boolean
  trend_4h_ok: boolean
  trend_1h_ok: boolean
  risk_pct_ok: boolean
  distance_to_opposing_level_ok: boolean
  impulse_extension_ok: boolean
  liquidity_ok: boolean
  data_completeness_ok: boolean
}

// === Setup Score Breakdown ===
export interface SetupScoreBreakdown {
  trend: number           // 0..25
  location: number        // 0..25
  momentum: number        // 0..20
  derivatives: number     // 0..15
  geometry: number        // 0..15
  penalties: number       // negative values
  total: number           // 0..100 clamped
  // Individual penalty reasons
  penalties_applied: string[]
}

// === Entry Trigger Result ===
export interface EntryTriggerResult {
  passed: boolean
  score: number         // how many of 4 conditions met (need >= 3)
  conditions: {
    pullback_zone: boolean
    candle_reclaim: boolean
    reversal_volume: boolean
    distance_from_trigger: boolean
  }
  details: string[]     // human-readable condition descriptions
}

// === Limit Entry Plan ===
export type LimitZoneSource =
  | 'EMA20_RETEST'
  | 'VWAP_RETEST'
  | 'BREAKOUT_RETEST'
  | 'LOCAL_SUPPORT'
  | 'LOCAL_RESISTANCE'
  | 'IMPULSE_50_PULLBACK'
  // New deep level sources (Phase 6)
  | 'EMA50_1H' | 'EMA20_4H' | 'EMA50_4H'
  | 'BB_LOWER_4H' | 'BB_UPPER_4H'
  | 'PIVOT_S1_4H' | 'PIVOT_S2_4H' | 'PIVOT_R1_4H' | 'PIVOT_R2_4H'
  | 'FIB_618' | 'FIB_500' | 'FIB_382'
  | 'SUPPORT_4H' | 'RESISTANCE_4H'
  | 'VWAP_4H' | 'BB_LOWER_1H' | 'BB_UPPER_1H'
  | 'PIVOT_S1_1H' | 'PIVOT_R1_1H'
  | 'CLUSTER'  // merged cluster of multiple levels

export interface LimitEntryPlan {
  entry_zone_low: number
  entry_zone_high: number
  preferred_limit_price: number
  zone_source: LimitZoneSource
  invalidation_price: number
  tp1_price: number
  tp2_price: number
  tp3_price: number
  ttl_minutes: number
  cancel_if_not_triggered: boolean
  cancel_if_structure_invalidated: boolean
  explanation: string
  candidates: EntryCandidateSet
}

// === 4D Candidate Scoring (Phase 6) ===

export interface CandidateScore {
  structural_strength: number  // 0-10
  geometry_bonus: number       // 0-10
  fill_realism: number         // 0-10
  setup_integrity: number      // 0-10
  weighted_total: number       // weighted sum before penalties
  penalties_applied: string[]  // penalty descriptions
  final_score: number          // after penalty multipliers
}

export interface EntryCandidate {
  price: number
  zone_low: number
  zone_high: number
  source: LimitZoneSource
  sources_in_cluster: string[]  // all level sources if cluster
  confluence_count: number      // number of levels in cluster
  distance_atr: number          // distance from current price in ATR units
  candidate_score: CandidateScore
  fill_category: 'likely' | 'possible' | 'unlikely'
  integrity_estimate: 'strong' | 'moderate' | 'weak'
  rr_improvement: number  // R:R improvement vs market entry
}

export interface EntryCandidateSet {
  preferred: EntryCandidate
  secondary: EntryCandidate | null
  deep: EntryCandidate | null
}

export interface CandidateFilterResult {
  passed: boolean
  reason: string | null  // reason for rejection
}

// === Market Entry Plan ===
export interface MarketEntryPlan {
  market_entry_price: number
  max_chase_price: number
  invalidation_price: number
  tp1_price: number
  tp2_price: number
  tp3_price: number
  explanation: string
}

// === Risk Profile ===
export interface RiskProfile {
  risk_pct: number          // % of account to risk
  max_sl_pct: number        // max allowed SL distance %
  entry_model: EntryModelType
  position_size_multiplier: number
}

// === Signal Context (persisted with each signal) ===
export interface SignalContext {
  // Market context
  market_regime: ExtendedMarketRegime
  btc_regime: BtcRegime
  trend_4h: string
  trend_1h: string
  // Entry context
  distance_to_ema20: number
  distance_to_vwap: number
  distance_to_support: number
  distance_to_resistance: number
  distance_to_resistance_r: number
  distance_to_support_r: number
  atr_1h_pct: number
  impulse_extension_at_entry_atr_1h: number
  entry_model: EntryModelType
  // Indicators
  rsi_1h: number
  adx_1h: number
  macd_hist_1h: number
  volume_ratio: number
  oi_change_1h: number
  oi_change_4h: number
  funding_rate: number
  long_short_ratio: number
  // Risk / geometry
  initial_stop: number
  current_stop: number
  risk_pct: number
  tp1_rr: number
  tp2_rr: number
  tp3_rr: number
  // Data completeness
  data_completeness: number
}

// === Signal Explanation (for logging and UI) ===
export interface SignalExplanation {
  hard_filter_result: HardFilterResult
  setup_score: number
  setup_score_breakdown: SetupScoreBreakdown
  penalties_applied: string[]
  category: SetupCategory
  entry_trigger_score: EntryTriggerResult
  entry_trigger_conditions: string[]
  execution_type: ExecutionType
  recommended_entry_model: EntryModelType
  recommended_risk_profile: RiskProfile
  invalidation_reason: string | null
  limit_entry_plan: LimitEntryPlan | null
  market_entry_plan: MarketEntryPlan | null
}

// === Trade Logging Fields ===
export interface TradeLogFields {
  entry_price: number
  initial_stop: number
  current_stop: number
  stop_moved_to_be: boolean
  stop_move_reason: string | null
  trailing_activated: boolean
  trailing_activation_time: string | null
  tp1_hit_timestamp: string | null
  tp2_hit_timestamp: string | null
  tp3_hit_timestamp: string | null
  exit_reason: ExitReason | null
}

export type ExitReason =
  | 'INITIAL_STOP'
  | 'BE_STOP'
  | 'TRAILING_STOP'
  | 'MANUAL_EXIT'
  | 'TIME_STOP'
  | 'TP1_PARTIAL'
  | 'TP2_PARTIAL'
  | 'TP3_FINAL'

// === Enriched Signal (output of full pipeline) ===
export interface EnrichedSignal {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  indicators: MultiTFIndicators
  reasons: string[]
  // 3-layer scoring
  hard_filter: HardFilterResult
  setup_score: number
  setup_breakdown: SetupScoreBreakdown
  entry_trigger: EntryTriggerResult
  category: SetupCategory
  execution_type: ExecutionType
  // Entry/exit
  entry: number
  initial_stop: number
  current_stop: number
  take_profits: { price: number; rr: number; close_pct: number }[]
  leverage: number
  position_pct: number
  risk_pct: number
  risk_profile: RiskProfile
  // Plans
  limit_plan: LimitEntryPlan | null
  market_plan: MarketEntryPlan | null
  // Context
  signal_context: SignalContext
  explanation: SignalExplanation
  // Data quality
  data_completeness: number
}

// === Input bundle for scoring functions ===
export interface ScoringInput {
  raw: RawSignal
  regime: RegimeContext
  extendedRegime: ExtendedMarketRegime
  btcRegime: BtcRegime
  coinRegime?: CoinRegimeContext
  funding?: FundingData | null
  oi?: OIData | null
  news?: NewsSentiment | null
  liquidations?: LiquidationStats | null
  lsr?: LSRData | null
  // Optional recent candles for entry trigger validation
  candles5m?: OHLCV[]
  candles15m?: OHLCV[]
}

// === User-facing status labels ===
export const EXECUTION_TYPE_LABELS: Record<ExecutionType, string> = {
  ENTER_NOW_LONG: 'Можно входить сейчас в LONG',
  ENTER_NOW_SHORT: 'Можно входить сейчас в SHORT',
  LIMIT_LONG: 'Лимитный вход в LONG',
  LIMIT_SHORT: 'Лимитный вход в SHORT',
  WAIT_CONFIRMATION: 'Ждать подтверждение',
  IGNORE: 'Игнорировать',
}

export const CATEGORY_LABELS: Record<SetupCategory, string> = {
  A_PLUS_READY: 'A+ Готов',
  READY: 'Готов',
  WATCHLIST: 'Наблюдение',
  IGNORE: 'Игнорировать',
}

// === Legacy types (kept for gptFilter/classifier bridge compatibility) ===

export interface ScoreBreakdown {
  trend: number
  momentum: number
  volatility: number
  meanRevStretch: number
  levelInteraction: number
  volume: number
  marketContext: number
  mtfMultiplier: number
  patternBonus: number
}

export interface EntryModel {
  type: 'aggressive' | 'confirmation' | 'pullback'
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  riskReward: number
  viable: boolean
}

export interface SignalWithRisk {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  scoreBreakdown: ScoreBreakdown
  reasons: string[]
  indicators: MultiTFIndicators
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  tp1Percent: number
  tp2Percent: number
  tp3Percent: number
  riskReward: number
  entryModels: EntryModel[]
  bestEntryType: 'aggressive' | 'confirmation' | 'pullback'
}
