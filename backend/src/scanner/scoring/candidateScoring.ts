import { LevelCluster } from '../entryAnalyzer/levelClusterer'
import { MultiTFIndicators } from '../../services/indicators'
import { CandidateScore, EntryCandidate, CandidateFilterResult, LimitZoneSource } from './types'
import { round2, round } from '../utils/round'

// === Scoring weights (per D-01) ===
const W_STRENGTH = 3
const W_GEOMETRY = 3
const W_FILL = 2
const W_INTEGRITY = 2

// === Hard filter thresholds (per D-03) ===
const MIN_FILL_REALISM = 2
const MIN_SETUP_INTEGRITY = 2
const MIN_DISTANCE_ATR = 0.3
const MAX_DISTANCE_ATR = 2.0

// === Penalty thresholds (per D-02) ===
const FAR_DISTANCE_ATR = 1.5
const FAR_DISTANCE_PENALTY = 0.85
const NO_CONFLUENCE_PENALTY = 0.9

/**
 * Hard filter: reject candidates that are too close or too far from current price.
 * Rejects if distance < 0.3 ATR (market order is better) or > 2.0 ATR (too far).
 */
export function hardFilterCandidate(
  cluster: LevelCluster,
  atr: number,
  price: number,
): CandidateFilterResult {
  const distance = Math.abs(cluster.price - price)
  const dist = round2(distance / atr)

  if (dist < MIN_DISTANCE_ATR) {
    return { passed: false, reason: `Дистанция ${dist} ATR < 0.3 — слишком близко` }
  }
  if (dist > MAX_DISTANCE_ATR) {
    return { passed: false, reason: `Дистанция ${dist} ATR > 2.0 — слишком далеко` }
  }

  return { passed: true, reason: null }
}

/**
 * Structural Strength (0-10).
 * Normalizes cluster totalWeight to 0-10 scale.
 * Single level: weights 3-9 → normalize to 0-10.
 * Cluster (2+ levels): totalWeight 6-30+ → cap at 10 (totalWeight/2).
 */
export function scoreStructuralStrength(cluster: LevelCluster): number {
  if (cluster.levels.length === 1) {
    return Math.min(10, round2(cluster.totalWeight * 10 / 9))
  }
  return Math.min(10, round2(cluster.totalWeight / 2))
}

/**
 * Geometry Bonus (0-10).
 * Measures R:R improvement of entering at cluster.price vs entering at current price.
 */
export function scoreGeometryBonus(
  cluster: LevelCluster,
  type: 'LONG' | 'SHORT',
  price: number,
  atr: number,
  stopLoss: number,
  takeProfits: { price: number; rr: number; close_pct: number }[],
): { score: number; limitRR: number; marketRR: number } {
  const tp1Price = takeProfits[0]?.price ?? 0
  const isLong = type === 'LONG'

  // Market R:R — entering at current price
  const marketSL = Math.abs(price - stopLoss)
  const marketTP1 = tp1Price > 0 ? Math.abs(tp1Price - price) : 0
  const marketRR = marketSL > 0 ? round2(marketTP1 / marketSL) : 0

  // Limit R:R — entering at cluster.price
  const limitSL = isLong
    ? Math.abs(cluster.price - stopLoss)
    : Math.abs(cluster.price - stopLoss)
  const limitTP1 = tp1Price > 0 ? Math.abs(tp1Price - cluster.price) : 0
  const limitRR = limitSL > 0 ? round2(limitTP1 / limitSL) : 0

  const improvement = round2(limitRR - marketRR)

  let score: number
  if (improvement >= 1.5) score = 10
  else if (improvement >= 1.0) score = 8
  else if (improvement >= 0.5) score = 6
  else if (improvement >= 0.2) score = 4
  else if (improvement >= 0) score = 2
  else score = 0

  return { score, limitRR, marketRR }
}

/**
 * Fill Realism (0-10).
 * Based on ATR distance — closer = more likely to fill.
 */
export function scoreFillRealism(
  cluster: LevelCluster,
  atr: number,
  price: number,
): number {
  const atrRatio = Math.abs(cluster.price - price) / atr

  if (atrRatio <= 0.5) return 9
  if (atrRatio <= 0.8) return 7
  if (atrRatio <= 1.0) return 6
  if (atrRatio <= 1.3) return 4
  if (atrRatio <= 1.5) return 3
  if (atrRatio <= 2.0) return 2
  return 0
}

/**
 * Setup Integrity (0-10).
 * Estimates whether the setup will still be valid when price reaches the level.
 */
export function scoreSetupIntegrity(
  cluster: LevelCluster,
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
): number {
  const isLong = type === 'LONG'
  let score = 8

  const atrDist = Math.abs(cluster.price - indicators.tf1h.price) / indicators.tf1h.atr

  // Distance penalty
  if (atrDist > 1.5) score -= 3
  else if (atrDist > 1.0) score -= 2
  else if (atrDist > 0.5) score -= 1

  // HH/HL structure check
  if (isLong) {
    if (indicators.tf1h.marketStructure !== 'HH_HL') score -= 2
  } else {
    if (indicators.tf1h.marketStructure !== 'LH_LL') score -= 2
  }

  // RSI overextension
  if (isLong && indicators.tf1h.rsi > 65) score -= 1
  if (!isLong && indicators.tf1h.rsi < 35) score -= 1

  return Math.max(0, Math.min(10, score))
}

/**
 * Map level source string to LimitZoneSource enum value.
 */
function mapSourceToZoneSource(source: string): LimitZoneSource {
  const s = source.toLowerCase()
  if (s.includes('ema20') && s.includes('1h')) return 'EMA20_RETEST'
  if (s.includes('ema20') && s.includes('4h')) return 'EMA20_4H'
  if (s.includes('ema50') && s.includes('1h')) return 'EMA50_1H'
  if (s.includes('ema50') && s.includes('4h')) return 'EMA50_4H'
  if (s.includes('vwap') && s.includes('4h')) return 'VWAP_4H'
  if (s.includes('vwap')) return 'VWAP_RETEST'
  if (s.includes('bb lower') && s.includes('4h')) return 'BB_LOWER_4H'
  if (s.includes('bb upper') && s.includes('4h')) return 'BB_UPPER_4H'
  if (s.includes('bb lower') && s.includes('1h')) return 'BB_LOWER_1H'
  if (s.includes('bb upper') && s.includes('1h')) return 'BB_UPPER_1H'
  if (s.includes('pivot s1') && s.includes('4h')) return 'PIVOT_S1_4H'
  if (s.includes('pivot s2') && s.includes('4h')) return 'PIVOT_S2_4H'
  if (s.includes('pivot r1') && s.includes('4h')) return 'PIVOT_R1_4H'
  if (s.includes('pivot r2') && s.includes('4h')) return 'PIVOT_R2_4H'
  if (s.includes('pivot s1') && s.includes('1h')) return 'PIVOT_S1_1H'
  if (s.includes('pivot r1') && s.includes('1h')) return 'PIVOT_R1_1H'
  if (s.includes('fib') && s.includes('0.618')) return 'FIB_618'
  if (s.includes('fib') && s.includes('0.5')) return 'FIB_500'
  if (s.includes('fib') && s.includes('0.382')) return 'FIB_382'
  if ((s.includes('поддержка') || s.includes('support')) && s.includes('4h')) return 'SUPPORT_4H'
  if ((s.includes('сопротивление') || s.includes('resistance')) && s.includes('4h')) return 'RESISTANCE_4H'
  if (s.includes('поддержка') || s.includes('support')) return 'LOCAL_SUPPORT'
  if (s.includes('сопротивление') || s.includes('resistance')) return 'LOCAL_RESISTANCE'
  if (s.includes('breakout')) return 'BREAKOUT_RETEST'
  if (s.includes('impulse') || s.includes('50%')) return 'IMPULSE_50_PULLBACK'
  return 'CLUSTER'
}

/**
 * Main orchestrator: score a candidate cluster against the 4D framework.
 * Returns both the EntryCandidate and the filter result.
 */
export function scoreCandidate(
  cluster: LevelCluster,
  type: 'LONG' | 'SHORT',
  indicators: MultiTFIndicators,
  stopLoss: number,
  takeProfits: { price: number; rr: number; close_pct: number }[],
): { candidate: EntryCandidate; filtered: CandidateFilterResult } {
  const price = indicators.tf1h.price
  const atr = indicators.tf1h.atr

  // Step 1: Hard distance filter
  const filtered = hardFilterCandidate(cluster, atr, price)
  if (!filtered.passed) {
    return { candidate: null as any, filtered }
  }

  // Step 2: Calculate all 4 dimension scores
  const strength = scoreStructuralStrength(cluster)
  const { score: geometry, limitRR, marketRR } = scoreGeometryBonus(cluster, type, price, atr, stopLoss, takeProfits)
  const fill = scoreFillRealism(cluster, atr, price)
  const integrity = scoreSetupIntegrity(cluster, type, indicators)

  // Step 3: Weighted sum (normalize to 0-10)
  const weightTotal = W_STRENGTH + W_GEOMETRY + W_FILL + W_INTEGRITY
  const weighted_total = round2(
    (strength * W_STRENGTH + geometry * W_GEOMETRY + fill * W_FILL + integrity * W_INTEGRITY) / weightTotal * 10
  )

  // Step 4: Hard filter on dimension scores (per D-03)
  if (fill < MIN_FILL_REALISM || integrity < MIN_SETUP_INTEGRITY) {
    return {
      candidate: null as any,
      filtered: {
        passed: false,
        reason: `fill_realism ${fill} < 2 или setup_integrity ${integrity} < 2`,
      },
    }
  }

  // Step 5: Apply penalty multipliers (per D-02)
  const penalties: string[] = []
  let multiplier = 1.0
  const atrDist = Math.abs(cluster.price - price) / atr

  if (atrDist > FAR_DISTANCE_ATR) {
    multiplier *= FAR_DISTANCE_PENALTY
    penalties.push(`x0.85: дистанция ${round2(atrDist)} ATR > 1.5`)
  }
  if (cluster.levels.length <= 1) {
    multiplier *= NO_CONFLUENCE_PENALTY
    penalties.push('x0.9: одиночный уровень без confluence')
  }

  const final_score = round2(weighted_total * multiplier)

  // Step 6: Determine fill_category
  const atrRatio = atrDist
  const fill_category: 'likely' | 'possible' | 'unlikely' =
    atrRatio <= 0.5 ? 'likely' : atrRatio <= 1.0 ? 'possible' : 'unlikely'

  // Step 7: Determine integrity_estimate
  const integrity_estimate: 'strong' | 'moderate' | 'weak' =
    integrity >= 7 ? 'strong' : integrity >= 4 ? 'moderate' : 'weak'

  // Step 8: R:R improvement
  const rr_improvement = round2(limitRR - marketRR)

  // Step 9: Map source to LimitZoneSource
  const isCluster = cluster.levels.length >= 2
  const source: LimitZoneSource = isCluster
    ? 'CLUSTER'
    : mapSourceToZoneSource(cluster.levels[0]?.source ?? '')

  // Step 10: Build zone (±0.15 ATR)
  const isLong = type === 'LONG'
  const zone_low = isLong
    ? round(cluster.price - atr * 0.15)
    : round(cluster.price - atr * 0.15)
  const zone_high = isLong
    ? round(cluster.price + atr * 0.15)
    : round(cluster.price + atr * 0.15)

  const candidate_score: CandidateScore = {
    structural_strength: strength,
    geometry_bonus: geometry,
    fill_realism: fill,
    setup_integrity: integrity,
    weighted_total,
    penalties_applied: penalties,
    final_score,
  }

  const candidate: EntryCandidate = {
    price: cluster.price,
    zone_low,
    zone_high,
    source,
    sources_in_cluster: cluster.sources,
    confluence_count: cluster.levels.length,
    distance_atr: round2(atrDist),
    candidate_score,
    fill_category,
    integrity_estimate,
    rr_improvement,
  }

  return { candidate, filtered: { passed: true, reason: null } }
}
