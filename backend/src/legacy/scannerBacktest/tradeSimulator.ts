/**
 * Trade Simulator — given an EnrichedSignal at moment T and future candles,
 * simulates the position lifecycle (TP1/TP2/TP3 hits, SL trail to BE/TPn,
 * time-stop exits) and returns realized R-multiple.
 *
 * Mirrors scannerTracker.ts logic with these compromises:
 *   - Uses 5m candles for tick-by-tick simulation (granular enough)
 *   - When both SL and TP cross within same candle, assumes SL fills first
 *     (conservative — same as boevoy when MFE/MAE both move)
 *   - Time-stops: 7h without +0.4R = partial exit 50%; 21h without +0.8R = close
 */

import { OHLCV } from '../../services/market'
import { EnrichedSignal } from '../../scanner/scoring/index'

export type ExitReason =
  | 'INITIAL_STOP'
  | 'BE_STOP'
  | 'TRAILING_STOP_AFTER_TP1'
  | 'TRAILING_STOP_AFTER_TP2'
  | 'TIME_STOP_PARTIAL'
  | 'TIME_STOP_CLOSE'
  | 'TP3_FINAL'
  | 'END_OF_DATA'

export interface TradeResult {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  setupScore: number
  setupCategory: string
  executionType: string
  entryModel: string
  entryTime: number
  entry: number
  initialStop: number
  takeProfits: { price: number; rr: number; close_pct: number }[]

  // Outcome
  tp1Hit: boolean
  tp2Hit: boolean
  tp3Hit: boolean
  tp1Time: number | null
  tp2Time: number | null
  tp3Time: number | null
  exitReason: ExitReason
  exitTime: number
  // Realized R-multiple (weighted by partial close pcts):
  //   on TP1 we close 35% → +1.2R × 0.35 = 0.42R contribution
  //   if then SL trails to entry and gets hit, the remaining 65% exits at 0R → 0R contribution
  //   total = 0.42R
  realizedR: number
  // Holding time in hours
  holdingHours: number
}

const TIME_STOP_PARTIAL_HOURS = 7
const TIME_STOP_PARTIAL_MIN_R = 0.4
const TIME_STOP_CLOSE_HOURS = 21
const TIME_STOP_CLOSE_MIN_R = 0.8

const HOUR_MS = 3600_000

// Order matters: when comparing whether a candle hit SL or TP first,
// in pessimistic mode (which we use), we always check SL first.
function candleHits(
  candle: OHLCV,
  type: 'LONG' | 'SHORT',
  level: number,
  side: 'TP' | 'SL',
): boolean {
  // For LONG: TP is above entry, SL below. Hit if candle range crosses level.
  // For SHORT: TP is below entry, SL above.
  if (type === 'LONG') {
    if (side === 'TP') return candle.high >= level
    return candle.low <= level
  } else {
    if (side === 'TP') return candle.low <= level
    return candle.high >= level
  }
}

/**
 * Simulate one trade given the enriched signal and 5m candles
 * starting strictly AFTER the signal moment.
 */
export function simulateTrade(
  signal: EnrichedSignal,
  futureCandles5m: OHLCV[],
  entryTime: number,
): TradeResult {
  const { coin, type, strategy, entry, initial_stop: initialStop, take_profits: tps } = signal
  const isLong = type === 'LONG'
  const riskAbs = Math.abs(entry - initialStop)

  // Track the lifecycle
  let tp1Hit = false
  let tp2Hit = false
  let tp3Hit = false
  let tp1Time: number | null = null
  let tp2Time: number | null = null
  let tp3Time: number | null = null
  let currentStop = initialStop
  let realizedR = 0
  let remainingPct = 100 // % of position still open
  let exitReason: ExitReason = 'END_OF_DATA'
  let exitTime = entryTime
  let mfe = 0 // max favourable excursion in R units (for time-stop checks)

  for (let i = 0; i < futureCandles5m.length; i++) {
    const c = futureCandles5m[i]
    if (c.time < entryTime) continue // safety
    exitTime = c.time
    const elapsedHours = (c.time - entryTime) / HOUR_MS

    // Update MFE
    const candleBest = isLong ? c.high : c.low
    const moveFav = isLong ? candleBest - entry : entry - candleBest
    const moveR = riskAbs > 0 ? moveFav / riskAbs : 0
    if (moveR > mfe) mfe = moveR

    // Check SL hit FIRST (pessimistic)
    if (candleHits(c, type, currentStop, 'SL')) {
      // Realize the remaining position at currentStop
      const slR = (currentStop - entry) / (isLong ? riskAbs : -riskAbs)
      realizedR += (remainingPct / 100) * slR
      remainingPct = 0
      // Determine which exit reason
      if (tp2Hit) exitReason = 'TRAILING_STOP_AFTER_TP2'
      else if (tp1Hit) exitReason = 'TRAILING_STOP_AFTER_TP1'
      else exitReason = 'INITIAL_STOP'
      break
    }

    // Check TPs in order
    if (!tp1Hit && tps[0] && candleHits(c, type, tps[0].price, 'TP')) {
      tp1Hit = true
      tp1Time = c.time
      const closePct = tps[0].close_pct
      realizedR += (closePct / 100) * tps[0].rr
      remainingPct -= closePct
      // After TP1: SL moves to break-even (entry)
      currentStop = entry
    }

    if (tp1Hit && !tp2Hit && tps[1] && candleHits(c, type, tps[1].price, 'TP')) {
      tp2Hit = true
      tp2Time = c.time
      const closePct = tps[1].close_pct
      realizedR += (closePct / 100) * tps[1].rr
      remainingPct -= closePct
      // After TP2: SL trails to TP1 price
      currentStop = tps[0].price
    }

    if (tp2Hit && !tp3Hit && tps[2] && candleHits(c, type, tps[2].price, 'TP')) {
      tp3Hit = true
      tp3Time = c.time
      const closePct = tps[2].close_pct
      realizedR += (closePct / 100) * tps[2].rr
      remainingPct -= closePct
      exitReason = 'TP3_FINAL'
      break
    }

    // Time-stop checks (only if no closure yet)
    if (remainingPct > 0) {
      if (elapsedHours >= TIME_STOP_CLOSE_HOURS && mfe < TIME_STOP_CLOSE_MIN_R) {
        // Force-close at this candle's close
        const slR = (c.close - entry) / (isLong ? riskAbs : -riskAbs)
        realizedR += (remainingPct / 100) * slR
        remainingPct = 0
        exitReason = 'TIME_STOP_CLOSE'
        break
      }
      if (elapsedHours >= TIME_STOP_PARTIAL_HOURS && mfe < TIME_STOP_PARTIAL_MIN_R && remainingPct > 50) {
        // Partial 50% exit at close, rest continues
        const slR = (c.close - entry) / (isLong ? riskAbs : -riskAbs)
        realizedR += 0.5 * slR
        remainingPct -= 50
        // mark partial event but continue loop
        if (exitReason === 'END_OF_DATA') exitReason = 'TIME_STOP_PARTIAL'
      }
    }
  }

  return {
    coin,
    type,
    strategy,
    setupScore: signal.setup_score,
    setupCategory: signal.category,
    executionType: signal.execution_type,
    entryModel: signal.risk_profile.entry_model,
    entryTime,
    entry,
    initialStop,
    takeProfits: tps,
    tp1Hit,
    tp2Hit,
    tp3Hit,
    tp1Time,
    tp2Time,
    tp3Time,
    exitReason,
    exitTime,
    realizedR: Math.round(realizedR * 1000) / 1000,
    holdingHours: Math.round(((exitTime - entryTime) / HOUR_MS) * 10) / 10,
  }
}
