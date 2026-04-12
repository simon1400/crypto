// === NEW SCORING PIPELINE ===
// 3-layer signal evaluation:
//   Layer 1: Hard Filters — pass/fail gate
//   Layer 2: Setup Score — quality assessment (0-100)
//   Layer 3: Entry Trigger — timing validation (pass/fail)
//
// Then: execution type classification + entry plan generation

export { calculateHardFilters, detectExtendedRegime, detectBtcRegime, calculateDataCompleteness, calculateImpulseExtension } from './hardFilters'
export { calculateSetupScore, assignSignalCategory } from './setupScore'
export { calculateEntryTrigger } from './entryTrigger'
export { selectExecutionType, generateLimitPlan, generateMarketPlan, maybeDowngradeExecution } from './executionType'
export { computeRiskProfile, selectEntryModel, calculateStandardizedExits, calculateStopLoss, calculateLeverage, getTimeStopRules } from './riskProfile'
export { buildSignalContext, buildSignalExplanation } from './signalExplanation'
export type {
  ExtendedMarketRegime,
  BtcRegime,
  SetupCategory,
  ExecutionType,
  EntryModelType,
  HardFilterResult,
  SetupScoreBreakdown,
  EntryTriggerResult,
  LimitEntryPlan,
  LimitZoneSource,
  MarketEntryPlan,
  RiskProfile,
  SignalContext,
  SignalExplanation,
  EnrichedSignal,
  ScoringInput,
  TradeLogFields,
  ExitReason,
} from './types'
export { EXECUTION_TYPE_LABELS, CATEGORY_LABELS } from './types'

import { EnrichedSignal, ScoringInput } from './types'
import { RawSignal } from '../strategies/index'
import { RegimeContext } from '../marketRegime'
import { CoinRegimeContext } from '../coinRegime'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { NewsSentiment } from '../../services/news'
import { LiquidationStats } from '../../services/liquidations'
import { LSRData } from '../../services/longShortRatio'
import { calculateHardFilters, detectExtendedRegime, detectBtcRegime, calculateDataCompleteness } from './hardFilters'
import { calculateSetupScore, assignSignalCategory } from './setupScore'
import { calculateEntryTrigger } from './entryTrigger'
import { selectExecutionType, generateLimitPlan, generateMarketPlan } from './executionType'
import { computeRiskProfile, selectEntryModel, calculateStandardizedExits, calculateStopLoss, calculateLeverage } from './riskProfile'
import { buildSignalContext, buildSignalExplanation } from './signalExplanation'
import { round2 } from '../utils/round'

// === FULL PIPELINE ===
// Takes a raw strategy signal + market context and produces a fully enriched signal

export function runScoringPipeline(
  raw: RawSignal,
  regime: RegimeContext,
  coinRegime?: CoinRegimeContext,
  funding?: FundingData | null,
  oi?: OIData | null,
  news?: NewsSentiment | null,
  liquidations?: LiquidationStats | null,
  lsr?: LSRData | null,
  candles5m?: import('../../services/market').OHLCV[],
  candles15m?: import('../../services/market').OHLCV[],
): EnrichedSignal | null {
  const extendedRegime = detectExtendedRegime(regime)
  const btcRegime = detectBtcRegime(regime)

  const input: ScoringInput = {
    raw,
    regime,
    extendedRegime,
    btcRegime,
    coinRegime,
    funding,
    oi,
    news,
    liquidations,
    lsr,
  }

  // === Layer 1: Hard Filters ===
  const hardFilter = calculateHardFilters(input)
  // We don't immediately reject — continue scoring for logging, but mark category as IGNORE

  // === Layer 2: Setup Score ===
  const setupBreakdown = calculateSetupScore(input)
  const setupScore = setupBreakdown.total
  const category = hardFilter.passed
    ? assignSignalCategory(setupScore)
    : 'IGNORE' as const

  // === Layer 3: Entry Trigger (uses raw candle OHLC when available) ===
  const entryTrigger = calculateEntryTrigger(raw.type, raw.indicators, candles5m, candles15m)

  // === Entry Model Selection ===
  const entryModel = selectEntryModel(category, entryTrigger, raw.strategy)

  // === Risk Profile ===
  const riskProfile = computeRiskProfile(category, raw.strategy, entryModel)

  // === Stop Loss & Entry ===
  const price = raw.indicators.tf1h.price
  const { stopLoss, slPercent } = calculateStopLoss(raw.type, price, raw.strategy, raw.indicators)

  // Check SL oversized: if > 4.0%, downgrade
  let finalCategory = category
  if (slPercent > 4.0 && finalCategory !== 'IGNORE') {
    finalCategory = slPercent > 5.0 ? 'IGNORE' : 'WATCHLIST'
  }

  // === Take Profits (standardized) ===
  const takeProfits = calculateStandardizedExits(raw.type, price, stopLoss, raw.indicators)

  // === Leverage ===
  const atrPct = round2((raw.indicators.tf1h.atr / price) * 100)
  const leverage = calculateLeverage(atrPct, setupScore, entryModel)

  // === Execution Type ===
  const executionType = selectExecutionType(raw.type, finalCategory, entryTrigger, raw.indicators)

  // === Entry Plans ===
  const isLimit = executionType === 'LIMIT_LONG' || executionType === 'LIMIT_SHORT'
  const isMarket = executionType === 'ENTER_NOW_LONG' || executionType === 'ENTER_NOW_SHORT'
  const limitPlan = isLimit ? generateLimitPlan(raw.type, raw.indicators, stopLoss, takeProfits) : null
  const marketPlan = isMarket ? generateMarketPlan(raw.type, raw.indicators, stopLoss, takeProfits) : null

  // === Entry price ===
  const entry = limitPlan ? limitPlan.preferred_limit_price : price

  // === Signal Context ===
  const signalContext = buildSignalContext(
    raw.type, raw.indicators, extendedRegime, btcRegime,
    entryModel, stopLoss, takeProfits, funding, oi, lsr,
  )

  // === Explanation ===
  const explanation = buildSignalExplanation(
    hardFilter, setupBreakdown, entryTrigger,
    finalCategory, executionType, entryModel, riskProfile,
    limitPlan, marketPlan,
  )

  // === Position size ===
  const position_pct = riskProfile.risk_pct

  // === Data completeness ===
  const dataCompleteness = calculateDataCompleteness(funding, oi, lsr)

  return {
    coin: raw.coin,
    type: raw.type,
    strategy: raw.strategy,
    indicators: raw.indicators,
    reasons: raw.reasons,
    // 3-layer scoring
    hard_filter: hardFilter,
    setup_score: setupScore,
    setup_breakdown: setupBreakdown,
    entry_trigger: entryTrigger,
    category: finalCategory,
    execution_type: executionType,
    // Entry/exit
    entry,
    initial_stop: stopLoss,
    current_stop: stopLoss,
    take_profits: takeProfits,
    leverage,
    position_pct,
    risk_pct: slPercent,
    risk_profile: riskProfile,
    // Plans
    limit_plan: limitPlan,
    market_plan: marketPlan,
    // Context
    signal_context: signalContext,
    explanation,
    // Data quality
    data_completeness: dataCompleteness,
  }
}
