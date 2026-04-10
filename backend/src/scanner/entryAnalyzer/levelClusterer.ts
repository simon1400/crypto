import { MultiTFIndicators } from '../../services/indicators'
import { round } from '../utils/round'

/**
 * Level clustering pipeline для определения оптимальных лимитных уровней входа.
 *
 * Flow:
 *   collectLevels(ind, type)  — все support/resistance/EMA/fib/pivot из 4h+1h+15m
 *   → clusterLevels(levels)   — группирует близкие уровни (по %-threshold)
 *   → buildCluster()          — считает weighted average + total weight
 *   → calcFillProbability()   — оценка вероятности достижения по ATR
 */

export interface PriceLevel {
  price: number
  source: string    // e.g. 'EMA20_1h', 'Fib_61.8', 'support_4h'
  weight: number    // 1-10, how reliable the level is
  timeframe: string // '15m' | '1h' | '4h'
}

export interface LevelCluster {
  price: number          // weighted average price of cluster
  levels: PriceLevel[]   // all levels in this cluster
  totalWeight: number    // sum of weights
  sources: string[]      // human-readable list
  distancePercent: number // distance from current price in %
  fillProbability: number // 0-1, chance price reaches this level
}

/**
 * Собрать все уровни (support/resistance/EMA/VWAP/fib/pivot) по трём TF.
 * Для LONG — только уровни ниже текущей цены; для SHORT — только выше.
 */
export function collectLevels(ind: MultiTFIndicators, type: 'LONG' | 'SHORT'): PriceLevel[] {
  const levels: PriceLevel[] = []
  const price = ind.tf1h.price

  function addLevel(p: number, source: string, weight: number, tf: string) {
    if (!p || !isFinite(p) || p <= 0) return
    if (type === 'LONG' && p >= price) return
    if (type === 'SHORT' && p <= price) return
    levels.push({ price: p, source, weight, timeframe: tf })
  }

  // === 4h levels (strongest) ===
  const tf4h = ind.tf4h
  addLevel(tf4h.support, 'Поддержка 4h', 9, '4h')
  addLevel(tf4h.ema20, 'EMA20 4h', 8, '4h')
  addLevel(tf4h.ema50, 'EMA50 4h', 7, '4h')
  addLevel(tf4h.vwap, 'VWAP 4h', 7, '4h')
  addLevel(tf4h.bbLower, 'BB Lower 4h', 6, '4h')
  addLevel(tf4h.bbMiddle, 'BB Mid 4h', 5, '4h')
  addLevel(tf4h.pivotS1, 'Pivot S1 4h', 7, '4h')
  addLevel(tf4h.pivotS2, 'Pivot S2 4h', 6, '4h')
  addLevel(tf4h.resistance, 'Сопротивление 4h', 9, '4h')
  addLevel(tf4h.bbUpper, 'BB Upper 4h', 6, '4h')
  addLevel(tf4h.pivotR1, 'Pivot R1 4h', 7, '4h')
  addLevel(tf4h.pivotR2, 'Pivot R2 4h', 6, '4h')

  // Fib levels 4h
  for (const fib of tf4h.fibLevels) {
    const fibWeight = fib.level === '0.618' ? 9 : fib.level === '0.5' ? 7 : fib.level === '0.382' ? 8 : fib.level === '0.786' ? 6 : 4
    addLevel(fib.price, `Fib ${fib.level} 4h`, fibWeight, '4h')
  }

  // === 1h levels (medium) ===
  const tf1h = ind.tf1h
  addLevel(tf1h.support, 'Поддержка 1h', 7, '1h')
  addLevel(tf1h.ema20, 'EMA20 1h', 6, '1h')
  addLevel(tf1h.ema50, 'EMA50 1h', 5, '1h')
  addLevel(tf1h.vwap, 'VWAP 1h', 6, '1h')
  addLevel(tf1h.bbLower, 'BB Lower 1h', 5, '1h')
  addLevel(tf1h.pivotS1, 'Pivot S1 1h', 5, '1h')
  addLevel(tf1h.resistance, 'Сопротивление 1h', 7, '1h')
  addLevel(tf1h.bbUpper, 'BB Upper 1h', 5, '1h')
  addLevel(tf1h.pivotR1, 'Pivot R1 1h', 5, '1h')

  // Fib levels 1h
  for (const fib of tf1h.fibLevels) {
    const fibWeight = fib.level === '0.618' ? 7 : fib.level === '0.5' ? 5 : fib.level === '0.382' ? 6 : 3
    addLevel(fib.price, `Fib ${fib.level} 1h`, fibWeight, '1h')
  }

  // === 15m levels (weakest, for fine-tuning) ===
  const tf15m = ind.tf15m
  addLevel(tf15m.support, 'Поддержка 15m', 4, '15m')
  addLevel(tf15m.ema20, 'EMA20 15m', 3, '15m')
  addLevel(tf15m.vwap, 'VWAP 15m', 4, '15m')
  addLevel(tf15m.resistance, 'Сопротивление 15m', 4, '15m')

  return levels
}

/** Cluster nearby levels (within threshold %). Returns clusters sorted by total weight descending. */
export function clusterLevels(levels: PriceLevel[], price: number, thresholdPct = 0.5): LevelCluster[] {
  if (levels.length === 0) return []

  const sorted = [...levels].sort((a, b) => a.price - b.price)
  const clusters: LevelCluster[] = []
  let currentCluster: PriceLevel[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentCluster[currentCluster.length - 1]
    const diff = (Math.abs(sorted[i].price - prev.price) / prev.price) * 100

    if (diff <= thresholdPct) {
      currentCluster.push(sorted[i])
    } else {
      clusters.push(buildCluster(currentCluster, price))
      currentCluster = [sorted[i]]
    }
  }
  clusters.push(buildCluster(currentCluster, price))

  clusters.sort((a, b) => b.totalWeight - a.totalWeight)
  return clusters
}

export function buildCluster(levels: PriceLevel[], currentPrice: number): LevelCluster {
  const totalWeight = levels.reduce((s, l) => s + l.weight, 0)
  const weightedPrice = levels.reduce((s, l) => s + l.price * l.weight, 0) / totalWeight
  const distancePercent = round((Math.abs(weightedPrice - currentPrice) / currentPrice) * 100)

  return {
    price: round(weightedPrice),
    levels,
    totalWeight,
    sources: levels.map((l) => l.source),
    distancePercent,
    fillProbability: 0, // calculated later
  }
}

/** Calculate fill probability based on ATR distance from current price. */
export function calcFillProbability(cluster: LevelCluster, atr: number, price: number): number {
  const distance = Math.abs(cluster.price - price)
  const atrRatio = distance / atr

  if (atrRatio <= 0.5) return 0.9
  if (atrRatio <= 1.0) return 0.75
  if (atrRatio <= 1.5) return 0.55
  if (atrRatio <= 2.0) return 0.35
  if (atrRatio <= 3.0) return 0.2
  return 0.1
}
