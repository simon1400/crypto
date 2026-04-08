import { ScoredScalpSignal, ScalpScoreBreakdown } from './scoring'
import { ScalpIndicators } from './strategies'

// Scalp risk calc — tight SL/TP for intra-hour trades
// SL: 0.2-0.5% from entry (based on ATR of 5m)
// TP: BB middle or VWAP — whichever is closer (realistic target)
// Leverage: higher than swing (5-20x) because tight SL
// Hold time: minutes, not days

export interface ScalpEntry {
  entry: number
  stopLoss: number
  takeProfit: number   // single TP (scalp = one target, get out)
  slPercent: number
  tpPercent: number
  riskReward: number
  leverage: number
  positionPct: number  // % of account
}

export interface ScalpSignalWithRisk {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  scoreBreakdown: ScalpScoreBreakdown
  reasons: string[]
  indicators: ScalpIndicators
  entry: number
  stopLoss: number
  takeProfit: number
  slPercent: number
  tpPercent: number
  riskReward: number
  leverage: number
  positionPct: number
  viable: boolean  // R:R >= 1.5
}

export function calculateScalpRisk(signal: ScoredScalpSignal): ScalpSignalWithRisk {
  const { tf1m, tf5m, tf15m } = signal.indicators
  const price = tf5m.price
  const atr5m = tf5m.atr
  const isLong = signal.type === 'LONG'

  // Entry: current price (scalp = enter now)
  const entry = round(price)

  // SL: based on 5m ATR — tight but room to breathe
  // 1.0-1.5x ATR on 5m, minimum 0.4% from entry
  // Too tight = instant SL hit from noise
  const slDistance = Math.max(atr5m * 1.2, price * 0.004)
  let stopLoss: number

  if (isLong) {
    // ATR-based SL (don't use support — it can be too close)
    stopLoss = round(entry - slDistance)
  } else {
    stopLoss = round(entry + slDistance)
  }

  // TP: BB middle or VWAP — realistic scalp target
  let takeProfit: number

  if (isLong) {
    // Target: closest of BB middle, VWAP, EMA9 — all above entry
    const targets = [tf5m.bbMiddle, tf5m.vwap, tf5m.ema9].filter(t => t > entry * 1.001)
    if (targets.length > 0) {
      takeProfit = round(Math.min(...targets))
    } else {
      // Fallback: 1.5x risk from entry
      takeProfit = round(entry + Math.abs(entry - stopLoss) * 1.5)
    }
  } else {
    const targets = [tf5m.bbMiddle, tf5m.vwap, tf5m.ema9].filter(t => t < entry * 0.999)
    if (targets.length > 0) {
      takeProfit = round(Math.max(...targets))
    } else {
      takeProfit = round(entry - Math.abs(entry - stopLoss) * 1.5)
    }
  }

  const slPercent = round(Math.abs((stopLoss - entry) / entry) * 100)
  const tpPercent = round(Math.abs((takeProfit - entry) / entry) * 100)
  const riskAmount = Math.abs(entry - stopLoss)
  const rewardAmount = Math.abs(takeProfit - entry)
  const riskReward = riskAmount > 0 ? round(rewardAmount / riskAmount) : 0

  // Leverage: based on SL% — tighter SL can support more leverage
  // But capped to avoid instant liquidation from noise
  let leverage: number
  if (slPercent < 0.4) leverage = 15
  else if (slPercent < 0.6) leverage = 10
  else if (slPercent < 1.0) leverage = 7
  else if (slPercent < 1.5) leverage = 5
  else leverage = 3

  // Score adjustment
  if (signal.score < 50) leverage = Math.max(3, Math.floor(leverage * 0.6))
  else if (signal.score < 65) leverage = Math.max(3, Math.floor(leverage * 0.8))

  // Position size: 1-2% (scalp = lower risk per trade, more trades)
  let positionPct: number
  if (signal.score >= 75) positionPct = 2
  else if (signal.score >= 60) positionPct = 1.5
  else positionPct = 1

  const viable = riskReward >= 1.5

  return {
    coin: signal.coin,
    type: signal.type,
    strategy: signal.strategy,
    score: signal.score,
    scoreBreakdown: signal.scoreBreakdown,
    reasons: signal.reasons,
    indicators: signal.indicators,
    entry,
    stopLoss,
    takeProfit,
    slPercent,
    tpPercent,
    riskReward,
    leverage,
    positionPct: round(positionPct),
    viable,
  }
}

function round(v: number): number {
  if (v > 100) return Math.round(v * 100) / 100
  if (v > 1) return Math.round(v * 10000) / 10000
  return Math.round(v * 1000000) / 1000000
}
