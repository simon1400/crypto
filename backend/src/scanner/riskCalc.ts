import { MultiTFIndicators } from '../services/indicators'
import { ScoredSignal } from './scoring'

// Calculate entry, stop loss, take profits, leverage, and position size

export interface SignalWithRisk {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  scoreBreakdown: ScoredSignal['scoreBreakdown']
  reasons: string[]
  indicators: MultiTFIndicators
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number  // % of deposit
  slPercent: number
  tp1Percent: number
  tp2Percent: number
  tp3Percent: number
  riskReward: number
}

export function calculateRisk(signal: ScoredSignal): SignalWithRisk {
  const { indicators: ind, type, coin, strategy, score, scoreBreakdown, reasons } = signal
  const { tf1h, tf4h } = ind
  const price = tf1h.price
  const atr = tf1h.atr

  // === Entry: depends on strategy ===
  let entry: number
  const isBreakout = strategy === 'breakout'

  if (type === 'LONG') {
    if (isBreakout) {
      // Breakout: entry at resistance level (breakout + retest)
      entry = round(tf1h.resistance * 1.002) // slightly above resistance
    } else {
      // Pullback: entry below current price at EMA/VWAP/support
      const pullbackTargets = [
        tf1h.ema9,
        tf1h.vwap,
        tf1h.support * 1.005,
      ].filter(p => p < price && p > price * 0.97)

      entry = pullbackTargets.length > 0
        ? round(Math.max(...pullbackTargets))
        : round(price - atr * 0.3)
    }
  } else {
    if (isBreakout) {
      // Breakout SHORT: entry at support level (breakdown + retest)
      entry = round(tf1h.support * 0.998) // slightly below support
    } else {
      // Pullback: entry above current price
      const bounceTargets = [
        tf1h.ema9,
        tf1h.vwap,
        tf1h.resistance * 0.995,
      ].filter(p => p > price && p < price * 1.03)

      entry = bounceTargets.length > 0
        ? round(Math.min(...bounceTargets))
        : round(price + atr * 0.3)
    }
  }

  // === Stop Loss: ATR-based, beyond support/resistance ===
  // Minimum SL distance: 1% of entry price (prevents SL == entry for small ATR)
  const minSLDistance = entry * 0.01
  const slDistance = Math.max(atr * 1.5, minSLDistance)

  let stopLoss: number
  if (type === 'LONG') {
    const atrStop = entry - slDistance
    const supportStop = tf1h.support - Math.max(atr * 0.3, minSLDistance * 0.3)
    stopLoss = round(Math.min(atrStop, supportStop))
    // Ensure SL is below entry
    if (stopLoss >= entry) stopLoss = round(entry - slDistance)
  } else {
    const atrStop = entry + slDistance
    const resistanceStop = tf1h.resistance + Math.max(atr * 0.3, minSLDistance * 0.3)
    stopLoss = round(Math.max(atrStop, resistanceStop))
    if (stopLoss <= entry) stopLoss = round(entry + slDistance)
  }

  const slPercent = round(Math.abs((stopLoss - entry) / entry) * 100)

  // === Take Profits: using Fibonacci, pivot, and R:R ratios ===
  const riskAmount = Math.abs(entry - stopLoss)
  const takeProfits: { price: number; rr: number }[] = []

  if (type === 'LONG') {
    // TP1: minimum 2R, or nearest resistance/pivot if higher
    const tp1Candidates = [
      entry + riskAmount * 2,
      tf1h.resistance,
      tf1h.pivotR1,
    ].filter(p => p >= entry + riskAmount * 2) // must be at least 2R
    const tp1 = tp1Candidates.length > 0 ? round(Math.min(...tp1Candidates)) : round(entry + riskAmount * 2)

    // TP2: 3.5R or next level
    const tp2Candidates = [
      entry + riskAmount * 3.5,
      tf1h.pivotR2,
      tf4h.resistance,
    ].filter(p => p > tp1)
    const tp2 = tp2Candidates.length > 0 ? round(Math.min(...tp2Candidates)) : round(entry + riskAmount * 3.5)

    // TP3: 5R extended
    const tp3 = round(entry + riskAmount * 5)

    takeProfits.push(
      { price: tp1, rr: round((tp1 - entry) / riskAmount) },
      { price: tp2, rr: round((tp2 - entry) / riskAmount) },
      { price: tp3, rr: round((tp3 - entry) / riskAmount) },
    )
  } else {
    // SHORT TPs — minimum 2R
    const tp1Candidates = [
      entry - riskAmount * 2,
      tf1h.support,
      tf1h.pivotS1,
    ].filter(p => p <= entry - riskAmount * 2 && p > 0) // must be at least 2R
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

  // === Leverage: inversely proportional to volatility ===
  // Higher ATR% = lower leverage
  const atrPercent = (atr / price) * 100
  let leverage: number
  if (atrPercent > 5) leverage = 2
  else if (atrPercent > 3) leverage = 3
  else if (atrPercent > 2) leverage = 5
  else if (atrPercent > 1) leverage = 8
  else leverage = 10

  // Reduce leverage for lower-score signals
  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 75) leverage = Math.max(1, Math.floor(leverage * 0.75))

  // === Position size: % of deposit based on score ===
  let positionPct: number
  if (score >= 80) positionPct = 3
  else if (score >= 70) positionPct = 2.5
  else if (score >= 60) positionPct = 2
  else positionPct = 1.5

  // Risk/Reward ratio (using TP1)
  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0

  const tp1Percent = takeProfits[0] ? round(Math.abs((takeProfits[0].price - entry) / entry) * 100) : 0
  const tp2Percent = takeProfits[1] ? round(Math.abs((takeProfits[1].price - entry) / entry) * 100) : 0
  const tp3Percent = takeProfits[2] ? round(Math.abs((takeProfits[2].price - entry) / entry) * 100) : 0

  return {
    coin,
    type,
    strategy,
    score,
    scoreBreakdown,
    reasons,
    indicators: ind,
    entry,
    stopLoss,
    takeProfits,
    leverage,
    positionPct,
    slPercent,
    tp1Percent,
    tp2Percent,
    tp3Percent,
    riskReward,
  }
}

function round(v: number): number {
  if (v > 100) return Math.round(v * 100) / 100
  if (v > 1) return Math.round(v * 10000) / 10000
  return Math.round(v * 1000000) / 1000000  // for low-price coins
}
