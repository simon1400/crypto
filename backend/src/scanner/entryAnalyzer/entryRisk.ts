import { MultiTFIndicators } from '../../services/indicators'
import { round } from '../utils/round'

/**
 * Расчёт SL/TP/leverage/positionPct для entry analyzer (две точки входа).
 *
 * Выровнен с основным скоринг пайплайном:
 * - TP: 1.2R(35%) / 2.2R(35%) / 3.5R(30%) — стандартные exits
 * - Risk: 0.75% дефолт, макс SL 4%
 * - Leverage: ATR-based + score scaling
 */
export interface EntryRiskResult {
  stopLoss: number
  avgEntry: number
  slPercent: number
  takeProfits: { price: number; rr: number; percent: number }[]
  leverage: number
  positionPct: number
  riskReward: number
}

export function calculateEntryRisk(
  type: 'LONG' | 'SHORT',
  entry1Price: number,
  entry2Price: number,
  ind: MultiTFIndicators,
  score: number,
): EntryRiskResult {
  const atr = ind.tf1h.atr
  const minSL = 0.012 // 1.2% minimum (aligned with scanner)

  // SL below entry2 (LONG) or above entry2 (SHORT)
  let stopLoss: number
  if (type === 'LONG') {
    const slDistance = Math.max(atr * 1.5, entry2Price * minSL)
    stopLoss = round(entry2Price - slDistance)
    const hardFloor = ind.tf4h.support - atr * 0.3
    if (hardFloor > 0 && hardFloor < stopLoss) stopLoss = round(hardFloor)
  } else {
    const slDistance = Math.max(atr * 1.5, entry2Price * minSL)
    stopLoss = round(entry2Price + slDistance)
    const hardCeiling = ind.tf4h.resistance + atr * 0.3
    if (hardCeiling > stopLoss) stopLoss = round(hardCeiling)
  }

  // Weighted average entry (60/40 split)
  const avgEntry = round(entry1Price * 0.6 + entry2Price * 0.4)

  const riskAmount = Math.abs(avgEntry - stopLoss)
  const slPercent = round((riskAmount / avgEntry) * 100)

  // Standardized TP: 1.2R / 2.2R / 3.5R (aligned with scanner)
  const takeProfits: { price: number; rr: number; percent: number }[] = []
  const { tf1h, tf4h } = ind

  if (type === 'LONG') {
    const tp1Base = avgEntry + riskAmount * 1.2
    const tp1Candidates = [tp1Base, tf1h.resistance, tf1h.pivotR1].filter(p => p >= tp1Base)
    const tp1 = tp1Candidates.length > 0 ? round(Math.min(...tp1Candidates)) : round(tp1Base)

    const tp2Base = avgEntry + riskAmount * 2.2
    const tp2Candidates = [tp2Base, tf1h.pivotR2, tf4h.resistance].filter(p => p > tp1)
    const tp2 = tp2Candidates.length > 0 ? round(Math.min(...tp2Candidates)) : round(tp2Base)

    const tp3 = round(avgEntry + riskAmount * 3.5)

    takeProfits.push(
      { price: tp1, rr: round((tp1 - avgEntry) / riskAmount), percent: 35 },
      { price: tp2, rr: round((tp2 - avgEntry) / riskAmount), percent: 35 },
      { price: tp3, rr: round((tp3 - avgEntry) / riskAmount), percent: 30 },
    )
  } else {
    const tp1Base = avgEntry - riskAmount * 1.2
    const tp1Candidates = [tp1Base, tf1h.support, tf1h.pivotS1].filter(p => p <= tp1Base && p > 0)
    const tp1 = tp1Candidates.length > 0 ? round(Math.max(...tp1Candidates)) : round(tp1Base)

    const tp2Base = avgEntry - riskAmount * 2.2
    const tp2Candidates = [tp2Base, tf1h.pivotS2, tf4h.support].filter(p => p < tp1 && p > 0)
    const tp2 = tp2Candidates.length > 0 ? round(Math.max(...tp2Candidates)) : round(tp2Base)

    const tp3 = round(Math.max(avgEntry - riskAmount * 3.5, 0.0001))

    takeProfits.push(
      { price: tp1, rr: round((avgEntry - tp1) / riskAmount), percent: 35 },
      { price: tp2, rr: round((avgEntry - tp2) / riskAmount), percent: 35 },
      { price: tp3, rr: round((avgEntry - tp3) / riskAmount), percent: 30 },
    )
  }

  // Leverage (ATR-based, scaled by score) — aligned with scanner
  const atrPercent = (atr / avgEntry) * 100
  let leverage: number
  if (atrPercent > 5) leverage = 2
  else if (atrPercent > 3) leverage = 3
  else if (atrPercent > 2) leverage = 5
  else if (atrPercent > 1) leverage = 8
  else leverage = 10

  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 72) leverage = Math.max(1, Math.floor(leverage * 0.75))

  // Position size — aligned with scanner risk profiles
  let positionPct: number
  if (score >= 72) positionPct = 1.0    // A_PLUS_READY
  else if (score >= 64) positionPct = 0.75  // READY
  else positionPct = 0.5                    // WATCHLIST or below

  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0

  return { stopLoss, avgEntry, slPercent, takeProfits, leverage, positionPct, riskReward }
}
