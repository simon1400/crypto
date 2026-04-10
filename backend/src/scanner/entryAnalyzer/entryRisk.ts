import { MultiTFIndicators } from '../../services/indicators'
import { round } from '../utils/round'

/**
 * Расчёт SL/TP/leverage/positionPct для entry analyzer (две точки входа).
 *
 * Логика:
 * - SL рассчитывается ОТ entry2 (более глубокий уровень) с учётом hard floor/ceiling 4h
 * - avgEntry — взвешенное среднее (60% entry1 + 40% entry2)
 * - TP1/TP2/TP3 — структурные уровни + R-кратные таргеты
 * - Leverage адаптивный по ATR + score
 */
export interface EntryRiskResult {
  stopLoss: number
  avgEntry: number
  slPercent: number
  takeProfits: { price: number; rr: number }[]
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
  const minSL = 0.01 // 1% minimum

  // SL below entry2 (LONG) or above entry2 (SHORT)
  let stopLoss: number
  if (type === 'LONG') {
    const slDistance = Math.max(atr * 1.2, entry2Price * minSL)
    stopLoss = round(entry2Price - slDistance)
    const hardFloor = ind.tf4h.support - atr * 0.3
    if (hardFloor > 0 && hardFloor < stopLoss) stopLoss = round(hardFloor)
  } else {
    const slDistance = Math.max(atr * 1.2, entry2Price * minSL)
    stopLoss = round(entry2Price + slDistance)
    const hardCeiling = ind.tf4h.resistance + atr * 0.3
    if (hardCeiling > stopLoss) stopLoss = round(hardCeiling)
  }

  // Weighted average entry (60/40 split)
  const avgEntry = round(entry1Price * 0.6 + entry2Price * 0.4)

  const riskAmount = Math.abs(avgEntry - stopLoss)
  const slPercent = round((riskAmount / avgEntry) * 100)

  // TP from average entry using structural levels
  const takeProfits: { price: number; rr: number }[] = []
  const { tf1h, tf4h } = ind

  if (type === 'LONG') {
    const tp1Raw = avgEntry + riskAmount * 2
    const tp1Candidates = [tp1Raw, tf1h.resistance, tf1h.pivotR1].filter((p) => p > avgEntry + riskAmount * 1.5)
    const tp1 = tp1Candidates.length > 0 ? round(Math.min(...tp1Candidates)) : round(tp1Raw)

    const tp2Raw = avgEntry + riskAmount * 4
    const tp2Candidates = [tp2Raw, tf4h.resistance, tf1h.pivotR2].filter((p) => p > tp1)
    const tp2 = tp2Candidates.length > 0 ? round(Math.min(...tp2Candidates)) : round(tp2Raw)

    const tp3 = round(avgEntry + riskAmount * 6)

    takeProfits.push(
      { price: tp1, rr: round((tp1 - avgEntry) / riskAmount) },
      { price: tp2, rr: round((tp2 - avgEntry) / riskAmount) },
      { price: tp3, rr: round((tp3 - avgEntry) / riskAmount) },
    )
  } else {
    const tp1Raw = avgEntry - riskAmount * 2
    const tp1Candidates = [tp1Raw, tf1h.support, tf1h.pivotS1].filter((p) => p < avgEntry - riskAmount * 1.5 && p > 0)
    const tp1 = tp1Candidates.length > 0 ? round(Math.max(...tp1Candidates)) : round(tp1Raw)

    const tp2Raw = avgEntry - riskAmount * 4
    const tp2Candidates = [tp2Raw, tf4h.support, tf1h.pivotS2].filter((p) => p < tp1 && p > 0)
    const tp2 = tp2Candidates.length > 0 ? round(Math.max(...tp2Candidates)) : round(tp2Raw)

    const tp3 = round(Math.max(avgEntry - riskAmount * 6, 0.0001))

    takeProfits.push(
      { price: tp1, rr: round((avgEntry - tp1) / riskAmount) },
      { price: tp2, rr: round((avgEntry - tp2) / riskAmount) },
      { price: tp3, rr: round((avgEntry - tp3) / riskAmount) },
    )
  }

  // Leverage (ATR-based, scaled by score)
  const atrPercent = (atr / avgEntry) * 100
  let leverage: number
  if (atrPercent > 5) leverage = 2
  else if (atrPercent > 3) leverage = 3
  else if (atrPercent > 2) leverage = 5
  else if (atrPercent > 1) leverage = 8
  else leverage = 10

  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 75) leverage = Math.max(1, Math.floor(leverage * 0.75))

  // Position size
  let positionPct: number
  if (score >= 80) positionPct = 3
  else if (score >= 70) positionPct = 2.5
  else if (score >= 60) positionPct = 2
  else positionPct = 1.5

  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0

  return { stopLoss, avgEntry, slPercent, takeProfits, leverage, positionPct, riskReward }
}
