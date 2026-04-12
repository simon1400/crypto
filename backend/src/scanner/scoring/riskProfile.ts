import { MultiTFIndicators } from '../../services/indicators'
import {
  SetupCategory,
  EntryModelType,
  RiskProfile,
  EntryTriggerResult,
} from './types'
import { round, round2 } from '../utils/round'

// === POSITION RISK PROFILES ===
// Default risk per trade: 0.75% of account
// A_PLUS_READY: up to 1.0%
// aggressive: 0.35% to 0.5%
// mean_revert: 0.5%

export function computeRiskProfile(
  category: SetupCategory,
  strategy: string,
  entryModel: EntryModelType,
): RiskProfile {
  let risk_pct: number
  let max_sl_pct: number

  // Base risk by category
  switch (category) {
    case 'A_PLUS_READY':
      risk_pct = 1.0
      break
    case 'READY':
      risk_pct = 0.75
      break
    case 'WATCHLIST':
      risk_pct = 0.5
      break
    default:
      risk_pct = 0
  }

  // Adjust for entry model
  if (entryModel === 'aggressive') {
    risk_pct = Math.min(risk_pct, 0.5)
    // Aggressive gets even less for non-A+ setups
    if (category !== 'A_PLUS_READY') risk_pct = 0.35
  }

  // Adjust for strategy
  if (strategy === 'mean_revert') {
    risk_pct = Math.min(risk_pct, 0.5)
  }

  // SL limits
  max_sl_pct = 4.0 // hard max for all signals

  return {
    risk_pct: round2(risk_pct),
    max_sl_pct,
    entry_model: entryModel,
    position_size_multiplier: entryModel === 'aggressive' ? 0.5 : 1.0,
  }
}

// === ENTRY MODEL SELECTION ===
// Confirmation is default. Aggressive only for A_PLUS_READY setups.
// Aggressive only for pullback entries, not breakout chasing.

export function selectEntryModel(
  category: SetupCategory,
  entryTrigger: EntryTriggerResult,
  strategy: string,
): EntryModelType {
  // Aggressive allowed only for A_PLUS_READY
  if (category === 'A_PLUS_READY' && entryTrigger.conditions.pullback_zone) {
    return 'aggressive'
  }

  // Everything else: confirmation
  return 'confirmation'
}

// === STANDARDIZED EXITS ===
// TP1 = 1.2R, close 35%
// TP2 = 2.2R, close 35%
// TP3 = 3.5R+, close 30%

export function calculateStandardizedExits(
  type: 'LONG' | 'SHORT',
  entry: number,
  stopLoss: number,
  indicators: MultiTFIndicators,
): { price: number; rr: number; close_pct: number }[] {
  const isLong = type === 'LONG'
  const riskAmount = Math.abs(entry - stopLoss)

  if (riskAmount <= 0) return []

  const { tf1h, tf4h } = indicators

  // TP1 = 1.2R
  let tp1: number
  if (isLong) {
    const baseTP1 = entry + riskAmount * 1.2
    // Use nearest structural level if closer
    const candidates = [baseTP1, tf1h.resistance, tf1h.pivotR1].filter(p => p >= baseTP1)
    tp1 = candidates.length > 0 ? Math.min(...candidates) : baseTP1
  } else {
    const baseTP1 = entry - riskAmount * 1.2
    const candidates = [baseTP1, tf1h.support, tf1h.pivotS1].filter(p => p <= baseTP1 && p > 0)
    tp1 = candidates.length > 0 ? Math.max(...candidates) : baseTP1
  }

  // TP2 = 2.2R
  let tp2: number
  if (isLong) {
    const baseTP2 = entry + riskAmount * 2.2
    const candidates = [baseTP2, tf1h.pivotR2, tf4h.resistance].filter(p => p > tp1)
    tp2 = candidates.length > 0 ? Math.min(...candidates) : baseTP2
  } else {
    const baseTP2 = entry - riskAmount * 2.2
    const candidates = [baseTP2, tf1h.pivotS2, tf4h.support].filter(p => p < tp1 && p > 0)
    tp2 = candidates.length > 0 ? Math.max(...candidates) : baseTP2
  }

  // TP3 = 3.5R (trailing or stretch)
  const tp3 = isLong
    ? round(entry + riskAmount * 3.5)
    : round(Math.max(entry - riskAmount * 3.5, 0.0001))

  return [
    { price: round(tp1), rr: round2((Math.abs(tp1 - entry)) / riskAmount), close_pct: 35 },
    { price: round(tp2), rr: round2((Math.abs(tp2 - entry)) / riskAmount), close_pct: 35 },
    { price: round(tp3), rr: round2((Math.abs(tp3 - entry)) / riskAmount), close_pct: 30 },
  ]
}

// === STOP LOSS CALCULATION ===
// SL range: 1.2% to 3.5% normal, max 4.0%
// Strategies use ATR-based stops

const SL_ATR_MULTIPLIERS: Record<string, number> = {
  trend_follow: 1.8,
  breakout: 1.2,
  mean_revert: 1.5,
}

export function calculateStopLoss(
  type: 'LONG' | 'SHORT',
  entry: number,
  strategy: string,
  indicators: MultiTFIndicators,
): { stopLoss: number; slPercent: number } {
  const { tf1h } = indicators
  const atr = tf1h.atr
  const slMult = SL_ATR_MULTIPLIERS[strategy] || 1.5
  const minSLDistance = entry * 0.012 // minimum 1.2%

  const slDistance = Math.max(atr * slMult, minSLDistance)

  let stopLoss: number
  if (type === 'LONG') {
    const atrStop = entry - slDistance
    const supportStop = tf1h.support - Math.max(atr * 0.3, entry * 0.003)
    stopLoss = round(Math.min(atrStop, supportStop))
    if (stopLoss >= entry) stopLoss = round(entry - slDistance)
  } else {
    const atrStop = entry + slDistance
    const resistanceStop = tf1h.resistance + Math.max(atr * 0.3, entry * 0.003)
    stopLoss = round(Math.max(atrStop, resistanceStop))
    if (stopLoss <= entry) stopLoss = round(entry + slDistance)
  }

  const slPercent = round2(Math.abs((stopLoss - entry) / entry) * 100)

  return { stopLoss, slPercent }
}

// === LEVERAGE CALCULATION ===
export function calculateLeverage(
  atrPct: number,
  score: number,
  entryModel: EntryModelType,
): number {
  let leverage: number
  if (atrPct > 5) leverage = 2
  else if (atrPct > 3) leverage = 3
  else if (atrPct > 2) leverage = 5
  else if (atrPct > 1) leverage = 8
  else leverage = 10

  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 72) leverage = Math.max(1, Math.floor(leverage * 0.75))

  if (entryModel === 'aggressive') leverage = Math.max(1, Math.floor(leverage * 0.6))

  return leverage
}

// === POSITION SIZE ===
export function calculatePositionSize(
  riskProfile: RiskProfile,
  slPercent: number,
  leverage: number,
  balance: number,
): number {
  // position_risk = risk_pct * balance
  // position_size = position_risk / (slPercent/100) / leverage
  // But for simplicity: positionPct = riskProfile.risk_pct (% of balance as margin)
  if (slPercent <= 0 || leverage <= 0) return 0
  const riskUsd = balance * (riskProfile.risk_pct / 100)
  const positionSizeUsd = (riskUsd / (slPercent / 100)) * leverage
  return round2(positionSizeUsd)
}

// === TIME-STOP RULES ===
export interface TimeStopRule {
  style: 'intraday' | 'short_swing'
  max_hours_without_progress: number
  min_progress_r: number
  action: 'partial_exit' | 'close'
}

export function getTimeStopRules(strategy: string): TimeStopRule[] {
  return [
    {
      style: 'intraday',
      max_hours_without_progress: 7,  // 6-8 hours
      min_progress_r: 0.4,
      action: 'partial_exit',
    },
    {
      style: 'short_swing',
      max_hours_without_progress: 21,  // 18-24 hours
      min_progress_r: 0.8,
      action: 'close',
    },
  ]
}
