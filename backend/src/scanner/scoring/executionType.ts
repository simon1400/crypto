import { MultiTFIndicators } from '../../services/indicators'
import {
  SetupCategory,
  ExecutionType,
  EntryTriggerResult,
  LimitEntryPlan,
  LimitZoneSource,
  MarketEntryPlan,
  EntryCandidate,
  EntryCandidateSet,
} from './types'
import { round, fmtPrice } from '../utils/round'
import { calculateImpulseExtension } from './hardFilters'
import { collectLevels, clusterLevels, calcFillProbability } from '../entryAnalyzer/levelClusterer'
import { scoreCandidate } from './candidateScoring'

// === EXECUTION TYPE CLASSIFICATION ===
// Distinguishes setup quality from entry timing / execution quality.
// A setup can be valid while immediate market entry is invalid.

export function selectExecutionType(
  type: 'LONG' | 'SHORT',
  category: SetupCategory,
  entryTrigger: EntryTriggerResult,
  indicators: MultiTFIndicators,
): ExecutionType {
  const isLong = type === 'LONG'
  const { tf15m, tf1h } = indicators
  const price = tf1h.price
  const atr15m = tf15m.atr
  const atr1h = tf1h.atr

  // IGNORE: setup not worth tracking
  if (category === 'IGNORE') return 'IGNORE'

  // WATCHLIST: setup present but weak
  if (category === 'WATCHLIST' && !entryTrigger.passed) return 'WAIT_CONFIRMATION'

  // Check if immediate entry is valid
  const impulseExt = calculateImpulseExtension(price, tf1h.ema20, atr1h)

  // Distance from trigger in ATR(15m)
  const triggerLevel = isLong
    ? Math.max(tf1h.ema20, tf1h.vwap)
    : Math.min(tf1h.ema20, tf1h.vwap)
  const distFromTrigger = atr15m > 0 ? Math.abs(price - triggerLevel) / atr15m : 999

  const canEnterNow =
    (category === 'READY' || category === 'A_PLUS_READY') &&
    entryTrigger.passed &&
    distFromTrigger <= 0.35 &&
    impulseExt <= 0.6

  if (canEnterNow) {
    return isLong ? 'ENTER_NOW_LONG' : 'ENTER_NOW_SHORT'
  }

  // Setup valid but immediate entry too extended or degrades R:R → LIMIT
  const setupValid = category === 'READY' || category === 'A_PLUS_READY'
  if (setupValid && (distFromTrigger > 0.35 || impulseExt > 0.6)) {
    return isLong ? 'LIMIT_LONG' : 'LIMIT_SHORT'
  }

  // Setup valid + trigger not confirmed yet
  if (setupValid && !entryTrigger.passed) {
    return 'WAIT_CONFIRMATION'
  }

  // WATCHLIST with trigger → still limit
  if (category === 'WATCHLIST' && entryTrigger.passed) {
    return isLong ? 'LIMIT_LONG' : 'LIMIT_SHORT'
  }

  return 'WAIT_CONFIRMATION'
}

// === LIMIT ENTRY PLAN ===
// For LIMIT_LONG and LIMIT_SHORT signals, generates a structured entry plan
// using levelClusterer for candidate collection and 4D scoring for ranking

export function generateLimitPlan(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  stopLoss: number,
  takeProfits: { price: number; rr: number }[],
): LimitEntryPlan | null {
  const { tf1h } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr = tf1h.atr

  // Step 1: Collect all levels via levelClusterer (per D-04)
  const levels = collectLevels(indicators, type)
  if (levels.length === 0) return null

  // Step 2: Cluster nearby levels (per D-04, D-05)
  const clusters = clusterLevels(levels, price)

  // Step 3: Score each cluster through 4D scoring (per D-05)
  const scored: EntryCandidate[] = []
  for (const cluster of clusters) {
    // Fill probability (used for logging, scoring uses its own fill_realism)
    calcFillProbability(cluster, atr, price)

    const { candidate, filtered } = scoreCandidate(cluster, type, indicators, stopLoss, takeProfits as { price: number; rr: number; close_pct: number }[])
    if (filtered.passed && candidate) {
      scored.push(candidate)
    }
  }

  // Step 4: Rank by final_score descending
  scored.sort((a, b) => b.candidate_score.final_score - a.candidate_score.final_score)

  // Fallback: no candidates passed hard filters (per D-07)
  if (scored.length === 0) return null

  // Best candidate = preferred
  const best = scored[0]

  // Build top 3 candidates set
  const secondary = scored.length > 1 ? scored[1] : null
  // deep = furthest candidate (last in sorted array), different from secondary
  const deepRaw = scored.length > 2 ? scored[scored.length - 1] : null
  const finalDeep = deepRaw && secondary && deepRaw.price === secondary.price ? null : deepRaw

  const candidates: EntryCandidateSet = {
    preferred: best,
    secondary,
    deep: finalDeep,
  }

  // Build zone with +/- 0.15 ATR spread (same as before)
  const spread = atr * 0.15
  const entry_zone_low = isLong
    ? round(best.price - spread)
    : round(best.price)
  const entry_zone_high = isLong
    ? round(best.price)
    : round(best.price + spread)
  const preferred_limit_price = round(best.price)

  // Invalidation: below support for LONG, above resistance for SHORT
  const invalidation_price = isLong
    ? round(tf1h.support - atr * 0.3)
    : round(tf1h.resistance + atr * 0.3)

  // Explanation with scoring info
  const scoreInfo = `score=${best.candidate_score.final_score}, str=${best.candidate_score.structural_strength}, geo=${best.candidate_score.geometry_bonus}, fill=${best.candidate_score.fill_realism}, int=${best.candidate_score.setup_integrity}`
  const confluenceInfo = best.confluence_count > 1
    ? ` (confluence: ${best.sources_in_cluster.join(' + ')})`
    : ''
  const explanation = isLong
    ? `Лимитный LONG от ${best.source}${confluenceInfo}: зона $${fmtPrice(entry_zone_low)}-$${fmtPrice(entry_zone_high)}. ${scoreInfo}. Dist: ${best.distance_atr} ATR. Инвалидация при пробое $${fmtPrice(invalidation_price)}.`
    : `Лимитный SHORT от ${best.source}${confluenceInfo}: зона $${fmtPrice(entry_zone_low)}-$${fmtPrice(entry_zone_high)}. ${scoreInfo}. Dist: ${best.distance_atr} ATR. Инвалидация при пробое $${fmtPrice(invalidation_price)}.`

  return {
    entry_zone_low,
    entry_zone_high,
    preferred_limit_price,
    zone_source: best.source,
    invalidation_price,
    tp1_price: takeProfits[0]?.price || 0,
    tp2_price: takeProfits[1]?.price || 0,
    tp3_price: takeProfits[2]?.price || 0,
    ttl_minutes: 240,
    cancel_if_not_triggered: true,
    cancel_if_structure_invalidated: true,
    explanation,
    candidates,
  }
}

// === MARKET ENTRY PLAN ===
// For ENTER_NOW signals, generates an immediate entry plan with chase limits

export function generateMarketPlan(
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  stopLoss: number,
  takeProfits: { price: number; rr: number }[],
): MarketEntryPlan {
  const { tf1h, tf15m } = indicators
  const isLong = type === 'LONG'
  const price = tf1h.price
  const atr15m = tf15m.atr

  // Max chase: 0.35 ATR(15m) beyond current price
  const max_chase_price = isLong
    ? round(price + atr15m * 0.35)
    : round(price - atr15m * 0.35)

  const invalidation_price = stopLoss

  const explanation = isLong
    ? `Рыночный LONG по ~$${fmtPrice(price)}. Макс. цена входа: $${fmtPrice(max_chase_price)}. Стоп: $${fmtPrice(stopLoss)}.`
    : `Рыночный SHORT по ~$${fmtPrice(price)}. Макс. цена входа: $${fmtPrice(max_chase_price)}. Стоп: $${fmtPrice(stopLoss)}.`

  return {
    market_entry_price: round(price),
    max_chase_price,
    invalidation_price,
    tp1_price: takeProfits[0]?.price || 0,
    tp2_price: takeProfits[1]?.price || 0,
    tp3_price: takeProfits[2]?.price || 0,
    explanation,
  }
}

// === AUTO-DOWNGRADE ===
// If current price exceeds max_chase_price, downgrade ENTER_NOW to LIMIT
export function maybeDowngradeExecution(
  execType: ExecutionType,
  marketPlan: MarketEntryPlan | null,
  currentPrice: number,
): ExecutionType {
  if (!marketPlan) return execType
  if (execType === 'ENTER_NOW_LONG' && currentPrice > marketPlan.max_chase_price) {
    return 'LIMIT_LONG'
  }
  if (execType === 'ENTER_NOW_SHORT' && currentPrice < marketPlan.max_chase_price) {
    return 'LIMIT_SHORT'
  }
  return execType
}
