import { MultiTFIndicators } from '../services/indicators'
import { ScoredSignal } from './scoring'

// Phase C: Trade Construction
// Setup zone → entry models → R:R per model
// Show max 2 models to user: primary (recommended) + alternative
// R:R minimum is strategy-aware

// Strategy-aware R:R minimums
const RR_MINIMUMS: Record<string, number> = {
  breakout: 2.0,       // breakout needs room to run
  trend_follow: 1.5,   // trend has momentum backing
  mean_revert: 1.3,    // mean revert has short SL, high probability
}

function getMinRR(strategy: string): number {
  return RR_MINIMUMS[strategy] || 1.5
}

export interface EntryModel {
  type: 'aggressive' | 'confirmation' | 'pullback'
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  riskReward: number  // TP1 R:R
  viable: boolean     // false if R:R < strategy minimum
}

export interface SignalWithRisk {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  scoreBreakdown: ScoredSignal['scoreBreakdown']
  reasons: string[]
  indicators: MultiTFIndicators
  // Best entry model (primary)
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
  // Entry models: max 2 shown (primary + alternative)
  entryModels: EntryModel[]  // only viable/relevant models, max 2
  bestEntryType: 'aggressive' | 'confirmation' | 'pullback'
}

export function calculateRisk(signal: ScoredSignal): SignalWithRisk {
  const { indicators: ind, type, coin, strategy, score, scoreBreakdown, reasons } = signal
  const { tf1h, tf4h } = ind
  const price = tf1h.price
  const atr = tf1h.atr
  const minRR = getMinRR(strategy)

  // Build all 3 models
  const aggressive = buildEntryModel('aggressive', type, strategy, price, atr, tf1h, tf4h, score, minRR)
  const confirmation = buildEntryModel('confirmation', type, strategy, price, atr, tf1h, tf4h, score, minRR)
  const pullback = buildEntryModel('pullback', type, strategy, price, atr, tf1h, tf4h, score, minRR)

  const allModels = [aggressive, confirmation, pullback]

  // Pick primary: best viable model (highest R:R)
  const viable = allModels.filter(m => m.viable)
  viable.sort((a, b) => b.riskReward - a.riskReward)

  const primary = viable[0] || aggressive // fallback to aggressive if none viable
  const bestEntryType = primary.type

  // Pick alternative: second best viable model (different type from primary)
  const alternative = viable.find(m => m.type !== primary.type) || null

  // Export max 2 models: primary + alternative (if exists and viable)
  const entryModels: EntryModel[] = [primary]
  if (alternative && alternative.viable) {
    entryModels.push(alternative)
  }

  const tp1Percent = primary.takeProfits[0] ? round(Math.abs((primary.takeProfits[0].price - primary.entry) / primary.entry) * 100) : 0
  const tp2Percent = primary.takeProfits[1] ? round(Math.abs((primary.takeProfits[1].price - primary.entry) / primary.entry) * 100) : 0
  const tp3Percent = primary.takeProfits[2] ? round(Math.abs((primary.takeProfits[2].price - primary.entry) / primary.entry) * 100) : 0

  return {
    coin,
    type,
    strategy,
    score,
    scoreBreakdown,
    reasons,
    indicators: ind,
    entry: primary.entry,
    stopLoss: primary.stopLoss,
    takeProfits: primary.takeProfits,
    leverage: primary.leverage,
    positionPct: primary.positionPct,
    slPercent: primary.slPercent,
    tp1Percent,
    tp2Percent,
    tp3Percent,
    riskReward: primary.riskReward,
    entryModels,
    bestEntryType,
  }
}

function buildEntryModel(
  entryType: 'aggressive' | 'confirmation' | 'pullback',
  type: 'LONG' | 'SHORT',
  strategy: string,
  price: number,
  atr: number,
  tf1h: MultiTFIndicators['tf1h'],
  tf4h: MultiTFIndicators['tf4h'],
  score: number,
  minRR: number,
): EntryModel {
  const isBreakout = strategy === 'breakout'

  let entry: number

  if (type === 'LONG') {
    switch (entryType) {
      case 'aggressive':
        if (isBreakout) {
          entry = round(tf1h.resistance * 1.002)
        } else {
          entry = round(price - atr * 0.1)
        }
        break
      case 'confirmation':
        if (isBreakout) {
          entry = round(tf1h.resistance * 1.005)
        } else {
          entry = round(Math.max(tf1h.ema9, price - atr * 0.3))
        }
        break
      case 'pullback':
        {
          const pullbackTargets = [
            tf1h.ema20,
            tf1h.vwap,
            tf1h.support * 1.005,
          ].filter(p => p < price && p > price * 0.95)
          entry = pullbackTargets.length > 0
            ? round(Math.max(...pullbackTargets))
            : round(price - atr * 0.5)
        }
        break
    }
  } else {
    switch (entryType) {
      case 'aggressive':
        if (isBreakout) {
          entry = round(tf1h.support * 0.998)
        } else {
          entry = round(price + atr * 0.1)
        }
        break
      case 'confirmation':
        if (isBreakout) {
          entry = round(tf1h.support * 0.995)
        } else {
          entry = round(Math.min(tf1h.ema9, price + atr * 0.3))
        }
        break
      case 'pullback':
        {
          const bounceTargets = [
            tf1h.ema20,
            tf1h.vwap,
            tf1h.resistance * 0.995,
          ].filter(p => p > price && p < price * 1.05)
          entry = bounceTargets.length > 0
            ? round(Math.min(...bounceTargets))
            : round(price + atr * 0.5)
        }
        break
    }
  }

  // === Stop Loss ===
  const minSLDistance = entry * 0.01
  const slDistance = Math.max(atr * 1.5, minSLDistance)

  let stopLoss: number
  if (type === 'LONG') {
    const atrStop = entry - slDistance
    const supportStop = tf1h.support - Math.max(atr * 0.3, minSLDistance * 0.3)
    stopLoss = round(Math.min(atrStop, supportStop))
    if (stopLoss >= entry) stopLoss = round(entry - slDistance)
  } else {
    const atrStop = entry + slDistance
    const resistanceStop = tf1h.resistance + Math.max(atr * 0.3, minSLDistance * 0.3)
    stopLoss = round(Math.max(atrStop, resistanceStop))
    if (stopLoss <= entry) stopLoss = round(entry + slDistance)
  }

  const slPercent = round(Math.abs((stopLoss - entry) / entry) * 100)

  // === Take Profits ===
  const riskAmount = Math.abs(entry - stopLoss)
  const takeProfits: { price: number; rr: number }[] = []

  if (type === 'LONG') {
    const tp1Candidates = [
      entry + riskAmount * 2,
      tf1h.resistance,
      tf1h.pivotR1,
    ].filter(p => p >= entry + riskAmount * 2)
    const tp1 = tp1Candidates.length > 0 ? round(Math.min(...tp1Candidates)) : round(entry + riskAmount * 2)

    const tp2Candidates = [
      entry + riskAmount * 3.5,
      tf1h.pivotR2,
      tf4h.resistance,
    ].filter(p => p > tp1)
    const tp2 = tp2Candidates.length > 0 ? round(Math.min(...tp2Candidates)) : round(entry + riskAmount * 3.5)

    const tp3 = round(entry + riskAmount * 5)

    takeProfits.push(
      { price: tp1, rr: round((tp1 - entry) / riskAmount) },
      { price: tp2, rr: round((tp2 - entry) / riskAmount) },
      { price: tp3, rr: round((tp3 - entry) / riskAmount) },
    )
  } else {
    const tp1Candidates = [
      entry - riskAmount * 2,
      tf1h.support,
      tf1h.pivotS1,
    ].filter(p => p <= entry - riskAmount * 2 && p > 0)
    const tp1 = tp1Candidates.length > 0 ? round(Math.max(...tp1Candidates)) : round(entry - riskAmount * 2)

    const tp2Candidates = [
      entry - riskAmount * 3.5,
      tf1h.pivotS2,
      tf4h.support,
    ].filter(p => p < tp1 && p > 0)
    const tp2 = tp2Candidates.length > 0 ? round(Math.max(...tp2Candidates)) : round(entry - riskAmount * 3.5)

    const tp3 = round(Math.max(entry - riskAmount * 5, 0.0001))

    takeProfits.push(
      { price: tp1, rr: round((entry - tp1) / riskAmount) },
      { price: tp2, rr: round((entry - tp2) / riskAmount) },
      { price: tp3, rr: round((entry - tp3) / riskAmount) },
    )
  }

  // === Leverage ===
  const atrPercent = (atr / price) * 100
  let leverage: number
  if (atrPercent > 5) leverage = 2
  else if (atrPercent > 3) leverage = 3
  else if (atrPercent > 2) leverage = 5
  else if (atrPercent > 1) leverage = 8
  else leverage = 10

  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 75) leverage = Math.max(1, Math.floor(leverage * 0.75))

  // Aggressive gets reduced leverage
  if (entryType === 'aggressive') leverage = Math.max(1, Math.floor(leverage * 0.75))

  // === Position size ===
  let positionPct: number
  if (score >= 80) positionPct = 3
  else if (score >= 70) positionPct = 2.5
  else if (score >= 60) positionPct = 2
  else positionPct = 1.5

  if (entryType === 'aggressive') positionPct = Math.max(1, positionPct * 0.75)

  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0

  // Strategy-aware viability check
  const viable = riskReward >= minRR

  return {
    type: entryType,
    entry,
    stopLoss,
    takeProfits,
    leverage,
    positionPct: round(positionPct),
    slPercent,
    riskReward,
    viable,
  }
}

function round(v: number): number {
  if (v > 100) return Math.round(v * 100) / 100
  if (v > 1) return Math.round(v * 10000) / 10000
  return Math.round(v * 1000000) / 1000000
}
