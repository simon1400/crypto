import { SignalWithRisk } from '../scoring/types'
import { GPTAnnotation } from '../gptFilter'
import { RegimeContext } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'
import {
  SetupCategory,
  ExecutionType,
  SetupScoreBreakdown,
  EntryTriggerResult,
  HardFilterResult,
  SignalContext,
  SignalExplanation,
  EnrichedSignal,
  LimitEntryPlan,
  MarketEntryPlan,
  RiskProfile,
} from '../scoring/types'

/**
 * Типы и интерфейсы для scanner/coinScanner/ модуля.
 * Вынесены отдельно чтобы не раздувать main файл и упростить импорты в classifier.
 */

// === Legacy Signal categories (kept for backward compat with old saved signals) ===
export type SignalCategory =
  | 'READY'              // Signal quality good + entry is valid now
  | 'READY_AGGRESSIVE'   // Signal strong but only aggressive entry viable
  | 'WAIT_CONFIRMATION'  // Signal quality good but needs a specific trigger
  | 'PULLBACK_WATCH'     // Signal good but entry chasing — wait for pullback
  | 'LATE_ENTRY'         // Setup already partially realized, R:R degraded
  | 'CONFLICTED'         // 2+ strong cross-layer contradictions
  | 'WATCHLIST'          // Setup partially present, edge weak, observational
  | 'REJECTED'           // No viable models or structure broken

// Score band — semantic meaning of raw score
export type ScoreBand = 'STRONG' | 'ACTIONABLE' | 'CONDITIONAL' | 'OBSERVATIONAL' | 'LOW_QUALITY'

// Entry quality — is the current price good for entry?
export type EntryQuality = 'GOOD' | 'FAIR' | 'POOR' | 'CHASING'

// Trigger state — structured conditions for WAIT_CONFIRMATION
export interface TriggerState {
  triggerType: 'breakout_close_above' | 'breakout_close_below' | 'retest_hold' | 'volume_confirm' | 'macd_cross' | 'rsi_reversal'
  triggerLevel: number
  triggerTf: '15m' | '1h' | '4h'
  invalidIf: string // human-readable invalidation condition
}

export interface ScanResult {
  signal: SignalWithRisk
  gptAnnotation: GPTAnnotation
  regime: RegimeContext
  category: SignalCategory
  scoreBand: ScoreBand
  entryQuality: EntryQuality
  triggerState: TriggerState | null // non-null for WAIT_CONFIRMATION
  coinRegime?: CoinRegimeContext
  // === New 3-layer scoring fields ===
  enriched?: EnrichedSignal
  setup_category?: SetupCategory
  execution_type?: ExecutionType
  setup_score_breakdown?: SetupScoreBreakdown
  entry_trigger_result?: EntryTriggerResult
  hard_filter_result?: HardFilterResult
  signal_context?: SignalContext
  signal_explanation?: SignalExplanation
  limit_entry_plan?: LimitEntryPlan | null
  market_entry_plan?: MarketEntryPlan | null
  risk_profile?: RiskProfile
}

// Funnel analytics — отчёт по этапам фильтрации сканера
export interface ScanFunnel {
  coinsScanned: number
  fetchErrors: number
  strategyCandidates: number
  rejectedByVolume: number
  rejectedByHardFilter: number
  passedScoring: number
  rejectedByRR: number
  passedRisk: number
  byStrategy: Record<string, number>
  byCategory: Record<string, number>
  bySetupCategory: Record<string, number>
  byExecutionType: Record<string, number>
  final: number
}
