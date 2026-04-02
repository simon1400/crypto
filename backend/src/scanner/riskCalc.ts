import { MultiTFIndicators } from '../services/indicators'
import { ScoredSignal } from './scoring'

// Phase C: Trade Construction
// Instead of calculating one "ideal" entry that gets killed by R:R,
// we find a SETUP ZONE and provide 3 entry models:
//   - aggressive: market entry or close to current price
//   - confirmation: wait for key level break/hold
//   - pullback: wait for retest of level
// Each has its own SL, TPs, R:R, and leverage

export interface EntryModel {
  type: 'aggressive' | 'confirmation' | 'pullback'
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  riskReward: number  // TP1 R:R
  viable: boolean     // false if R:R < 1.5
}

export interface SignalWithRisk {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  scoreBreakdown: ScoredSignal['scoreBreakdown']
  reasons: string[]
  indicators: MultiTFIndicators
  // Legacy single-entry fields (best entry model)
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
  // New: all entry models
  entryModels: EntryModel[]
  bestEntryType: 'aggressive' | 'confirmation' | 'pullback'
}

export function calculateRisk(signal: ScoredSignal): SignalWithRisk {
  const { indicators: ind, type, coin, strategy, score, scoreBreakdown, reasons } = signal
  const { tf1h, tf4h } = ind
  const price = tf1h.price
  const atr = tf1h.atr

  // === Build 3 entry models ===
  const models: EntryModel[] = []

  // 1. Aggressive entry: near current price
  const aggressiveEntry = buildEntryModel('aggressive', type, strategy, price, atr, tf1h, tf4h, score)
  models.push(aggressiveEntry)

  // 2. Confirmation entry: wait for level break/hold
  const confirmationEntry = buildEntryModel('confirmation', type, strategy, price, atr, tf1h, tf4h, score)
  models.push(confirmationEntry)

  // 3. Pullback entry: wait for retest
  const pullbackEntry = buildEntryModel('pullback', type, strategy, price, atr, tf1h, tf4h, score)
  models.push(pullbackEntry)

  // Pick best viable model (highest R:R among viable)
  const viable = models.filter(m => m.viable)
  viable.sort((a, b) => b.riskReward - a.riskReward)

  // If no model is viable, still keep the signal but mark best as aggressive
  const best = viable[0] || aggressiveEntry
  const bestEntryType = best.type

  const tp1Percent = best.takeProfits[0] ? round(Math.abs((best.takeProfits[0].price - best.entry) / best.entry) * 100) : 0
  const tp2Percent = best.takeProfits[1] ? round(Math.abs((best.takeProfits[1].price - best.entry) / best.entry) * 100) : 0
  const tp3Percent = best.takeProfits[2] ? round(Math.abs((best.takeProfits[2].price - best.entry) / best.entry) * 100) : 0

  return {
    coin,
    type,
    strategy,
    score,
    scoreBreakdown,
    reasons,
    indicators: ind,
    // Legacy fields from best entry model
    entry: best.entry,
    stopLoss: best.stopLoss,
    takeProfits: best.takeProfits,
    leverage: best.leverage,
    positionPct: best.positionPct,
    slPercent: best.slPercent,
    tp1Percent,
    tp2Percent,
    tp3Percent,
    riskReward: best.riskReward,
    // New fields
    entryModels: models,
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
): EntryModel {
  const isBreakout = strategy === 'breakout'

  let entry: number

  if (type === 'LONG') {
    switch (entryType) {
      case 'aggressive':
        // Enter near current price (or slight breakout offset)
        if (isBreakout) {
          entry = round(tf1h.resistance * 1.002)
        } else {
          entry = round(price - atr * 0.1) // slightly below for a quick fill
        }
        break
      case 'confirmation':
        // Wait for level to hold/break
        if (isBreakout) {
          entry = round(tf1h.resistance * 1.005) // confirmed break above resistance
        } else {
          entry = round(Math.max(tf1h.ema9, price - atr * 0.3)) // EMA9 hold
        }
        break
      case 'pullback':
        // Wait for retest of support/EMA zone
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

  // === Stop Loss: ATR-based, beyond support/resistance ===
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

  // Pullback gets full leverage, aggressive gets reduced
  if (entryType === 'aggressive') leverage = Math.max(1, Math.floor(leverage * 0.75))

  // === Position size ===
  let positionPct: number
  if (score >= 80) positionPct = 3
  else if (score >= 70) positionPct = 2.5
  else if (score >= 60) positionPct = 2
  else positionPct = 1.5

  // Reduce size for aggressive entry
  if (entryType === 'aggressive') positionPct = Math.max(1, positionPct * 0.75)

  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0
  const viable = riskReward >= 1.5

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