/**
 * BTC.D + Altcoin Rotation — FILTER SWEEP.
 *
 * Базовая стратегия (из runBacktest_btc_dominance_rotation.ts) показала:
 *   - 4 хороших ротации дали +85R (длинные altseason'ы)
 *   - 15 false signals (0-2 day whipsaws) дали −80R
 *   - Net: −51R на 31 rotation
 *
 * Гипотеза: добавив фильтры, можно отсечь false signals и сохранить large rotations.
 *
 * Filter dimensions:
 *   1. SMA period: 20, 30, 50 (длиннее = меньше false crosses)
 *   2. Confirmation days: 1, 3, 5, 7 (сколько дней BTC.D подряд под SMA до entry)
 *   3. Distance threshold: 0, 0.5, 1.0, 2.0 (% что BTC.D должен быть ниже SMA)
 *   4. Min hold before exit: 0, 3, 5 (минимум дней позиции даже если BTC.D recovered — анти-whipsaw на exit)
 *
 * Reduced sweep (чтобы не взорвать): 3×4×4×3 = 144 сценария. Тяжеловато, выберу
 * subset: 3 SMA × 4 confirm × 3 dist × 2 hold = 72.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_btc_dom_rotation_sweep.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { computeSizing } from '../services/marginGuard'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const TAKER_FEE = 0.00050
const TAKER_SLIP = 0.0003

const RISK_PCT_PER_ALT = 2
const SL_PCT = 5.0
const MAX_HOLD_DAYS = 30

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const BTC_DOM_CSV = path.join(__dirname, '../../data/btc_dominance.csv')

const ALTS_BASKET = [
  'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'ADAUSDT',
  'DOTUSDT', 'POLUSDT', 'LINKUSDT', 'DOGEUSDT', 'XRPUSDT',
]

const VARIANT = { startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 }

// Sweep ranges
const SMA_PERIODS = [20, 30, 50]
const CONFIRM_DAYS_LIST = [1, 3, 5, 7]
const DISTANCE_PCTS = [0, 0.5, 1.0, 2.0]   // BTC.D must be at least this much BELOW SMA
const MIN_HOLD_DAYS_LIST = [0, 5]            // min days before allowing close

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mToDaily(m5: OHLCV[]): OHLCV[] {
  const bucketMs = 24 * 3600_000
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const b = Math.floor(c.time / bucketMs) * bucketMs
    const list = buckets.get(b) ?? []
    list.push(c); buckets.set(b, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t, open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function parseBtcDominanceCsv(filePath: string): OHLCV[] {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  const cols = lines[0].toLowerCase().split(',').map(s => s.trim())
  const idxTime = cols.findIndex(c => c === 'time' || c === 'date' || c === 'timestamp')
  const idxClose = cols.findIndex(c => c === 'close')
  const candles: OHLCV[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const t = parts[idxTime].trim()
    let ms: number
    if (/^\d+$/.test(t)) ms = parseInt(t, 10)
    else ms = new Date(t).getTime()
    if (!isFinite(ms)) continue
    ms = Math.floor(ms / 86400_000) * 86400_000
    const close = parseFloat(parts[idxClose])
    if (!isFinite(close)) continue
    candles.push({ time: ms, open: close, high: close, low: close, close, volume: 0 })
  }
  candles.sort((a, b) => a.time - b.time)
  return candles
}

function sma(values: number[], period: number): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    out.push(sum / period)
  }
  return out
}

interface RotationEvent {
  time: number
  type: 'ALT_LONG_START' | 'ALT_LONG_END'
}

/**
 * Detect rotations with filters:
 *   - smaPeriod: SMA on BTC.D close
 *   - confirmDays: BTC.D должен быть < SMA минимум N дней подряд до START
 *   - distancePct: BTC.D должен быть на distancePct% ниже SMA (≥) для START
 *   - minHoldDays: после START — минимум N дней до END даже если BTC.D recovered
 */
function detectRotationsFiltered(
  btcDom: OHLCV[],
  smaPeriod: number,
  confirmDays: number,
  distancePct: number,
  minHoldDays: number,
): RotationEvent[] {
  const closes = btcDom.map(c => c.close)
  const smaArr = sma(closes, smaPeriod)
  const events: RotationEvent[] = []
  let isAltseason = false
  let belowStreak = 0
  let aboveStreak = 0
  let startTime = 0

  for (let i = smaPeriod; i < btcDom.length; i++) {
    const c = btcDom[i]
    const smaVal = smaArr[i]
    if (!isFinite(smaVal)) continue
    const distance = (smaVal - c.close) / smaVal * 100  // % below SMA (positive when below)
    const belowSma = distance >= distancePct
    const aboveSma = c.close > smaVal

    if (belowSma) {
      belowStreak++
      aboveStreak = 0
    } else {
      belowStreak = 0
    }
    if (aboveSma) aboveStreak++
    else aboveStreak = 0

    if (!isAltseason && belowStreak >= confirmDays) {
      events.push({ time: c.time + 86400_000, type: 'ALT_LONG_START' })
      isAltseason = true
      startTime = c.time
    } else if (isAltseason && aboveSma) {
      const daysHeld = (c.time - startTime) / 86400_000
      if (daysHeld >= minHoldDays) {
        events.push({ time: c.time + 86400_000, type: 'ALT_LONG_END' })
        isAltseason = false
      }
    }
  }
  return events
}

interface AltTrade {
  symbol: string
  entryTime: number; entryPrice: number; sl: number
  exitTime: number; exitPrice: number
  exitReason: 'ROTATION_END' | 'SL' | 'MAX_HOLD'
  r: number
}

function simulateBasket(
  events: RotationEvent[],
  altCandlesDaily: Map<string, OHLCV[]>,
): AltTrade[] {
  const trades: AltTrade[] = []
  let openTrades: AltTrade[] = []
  for (const event of events) {
    if (event.type === 'ALT_LONG_START') {
      for (const sym of ALTS_BASKET) {
        const candles = altCandlesDaily.get(sym)
        if (!candles) continue
        const idx = candles.findIndex(c => c.time >= event.time)
        if (idx < 0) continue
        const entryDay = candles[idx]
        const entry = entryDay.open
        const sl = entry * (1 - SL_PCT / 100)
        openTrades.push({
          symbol: sym, entryTime: entryDay.time, entryPrice: entry, sl,
          exitTime: 0, exitPrice: 0, exitReason: 'ROTATION_END', r: 0,
        })
      }
    } else if (event.type === 'ALT_LONG_END') {
      for (const trade of openTrades) {
        const candles = altCandlesDaily.get(trade.symbol)
        if (!candles) continue
        const exitIdx = candles.findIndex(c => c.time >= event.time)
        if (exitIdx < 0) continue
        const entryIdx = candles.findIndex(c => c.time >= trade.entryTime)
        let exitPrice = 0, exitTime = 0
        let reason: AltTrade['exitReason'] = 'ROTATION_END'
        for (let j = entryIdx; j < exitIdx; j++) {
          const c = candles[j]
          if (c.low <= trade.sl) {
            exitPrice = trade.sl; exitTime = c.time; reason = 'SL'; break
          }
          if ((c.time - trade.entryTime) / 86400_000 >= MAX_HOLD_DAYS) {
            exitPrice = c.close; exitTime = c.time; reason = 'MAX_HOLD'; break
          }
        }
        if (exitTime === 0) {
          exitPrice = candles[exitIdx].open
          exitTime = candles[exitIdx].time
          reason = 'ROTATION_END'
        }
        trade.exitPrice = exitPrice; trade.exitTime = exitTime; trade.exitReason = reason
        trade.r = ((exitPrice - trade.entryPrice) / trade.entryPrice) / (SL_PCT / 100)
        trades.push(trade)
      }
      openTrades = []
    }
  }
  for (const trade of openTrades) {
    const candles = altCandlesDaily.get(trade.symbol)
    if (!candles) continue
    const last = candles[candles.length - 1]
    trade.exitPrice = last.close; trade.exitTime = last.time; trade.exitReason = 'MAX_HOLD'
    trade.r = ((last.close - trade.entryPrice) / trade.entryPrice) / (SL_PCT / 100)
    trades.push(trade)
  }
  return trades
}

function simulatePortfolio(trades: AltTrade[]) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = VARIANT.startingDeposit
  let peak = VARIANT.startingDeposit
  let trough = VARIANT.startingDeposit
  let maxDD = 0
  let totalFees = 0
  let wins = 0, totalR = 0
  const byEntryTime = new Map<number, AltTrade[]>()
  for (const t of sorted) {
    if (!byEntryTime.has(t.entryTime)) byEntryTime.set(t.entryTime, [])
    byEntryTime.get(t.entryTime)!.push(t)
  }
  for (const [, group] of [...byEntryTime.entries()].sort((a, b) => a[0] - b[0])) {
    const depositBefore = currentDeposit
    const sizings: { trade: AltTrade; units: number; effEntry: number }[] = []
    for (const trade of group) {
      const effEntry = trade.entryPrice * (1 + TAKER_SLIP)
      const sizing = computeSizing({
        symbol: trade.symbol, deposit: depositBefore,
        riskPct: RISK_PCT_PER_ALT, targetMarginPct: VARIANT.targetMarginPct,
        entry: effEntry, sl: trade.sl,
      })
      if (!sizing) continue
      sizings.push({ trade, units: sizing.positionUnits, effEntry })
      const entryFee = sizing.positionUnits * effEntry * TAKER_FEE
      currentDeposit -= entryFee
      totalFees += entryFee
    }
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit
    for (const s of sizings) {
      const exitPrice = s.trade.exitPrice * (1 - TAKER_SLIP)
      const grossPnl = (exitPrice - s.effEntry) * s.units
      const exitFee = s.units * exitPrice * TAKER_FEE
      currentDeposit += grossPnl - exitFee
      totalFees += exitFee
      totalR += s.trade.r
      if (s.trade.r > 0) wins++
      if (currentDeposit > peak) peak = currentDeposit
      if (currentDeposit < trough) trough = currentDeposit
      const dd = ((peak - currentDeposit) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return {
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    trades: trades.length, wins,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalR, rPerTr: trades.length > 0 ? totalR / trades.length : 0,
    totalFeesUsd: totalFees,
  }
}

async function main() {
  console.log('BTC.D Rotation FILTER SWEEP')
  console.log(`Filters: SMA × confirmDays × distancePct × minHoldDays`)
  console.log(`Sweep: ${SMA_PERIODS.length} × ${CONFIRM_DAYS_LIST.length} × ${DISTANCE_PCTS.length} × ${MIN_HOLD_DAYS_LIST.length} = ${SMA_PERIODS.length * CONFIRM_DAYS_LIST.length * DISTANCE_PCTS.length * MIN_HOLD_DAYS_LIST.length} scenarios`)
  console.log()

  const btcDom = sliceLastDays(parseBtcDominanceCsv(BTC_DOM_CSV), DAYS_BACK)
  console.log(`BTC.D: ${btcDom.length} daily points\n`)

  console.log('Loading alt daily candles...')
  const altCandlesDaily = new Map<string, OHLCV[]>()
  for (const sym of ALTS_BASKET) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) continue
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) continue
    altCandlesDaily.set(sym, aggregate5mToDaily(m5))
  }
  console.log(`Loaded ${altCandlesDaily.size} alts\n`)

  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000

  interface ScenarioResult {
    smaP: number; confirm: number; distance: number; minHold: number
    rotations: number; trades: number
    fullFinal: number; trainFinal: number; testFinal: number
    fullR: number; trainR: number; testR: number
    fullWR: number; fullDD: number
  }
  const results: ScenarioResult[] = []

  for (const smaP of SMA_PERIODS) {
    for (const confirm of CONFIRM_DAYS_LIST) {
      for (const distance of DISTANCE_PCTS) {
        for (const minHold of MIN_HOLD_DAYS_LIST) {
          const events = detectRotationsFiltered(btcDom, smaP, confirm, distance, minHold)
          const startEvents = events.filter(e => e.type === 'ALT_LONG_START').length
          const trades = simulateBasket(events, altCandlesDaily)
          if (trades.length === 0) continue
          const full = simulatePortfolio(trades)
          const trainTrades = trades.filter(t => t.entryTime < trainEnd)
          const testTrades = trades.filter(t => t.entryTime >= trainEnd)
          const train = simulatePortfolio(trainTrades)
          const test = simulatePortfolio(testTrades)
          results.push({
            smaP, confirm, distance, minHold,
            rotations: startEvents, trades: trades.length,
            fullFinal: full.finalDeposit,
            trainFinal: train.finalDeposit,
            testFinal: test.finalDeposit,
            fullR: full.totalR, trainR: train.totalR, testR: test.totalR,
            fullWR: full.winRate, fullDD: full.maxDD,
          })
        }
      }
    }
  }

  // Sort by FULL final descending
  results.sort((a, b) => b.fullFinal - a.fullFinal)
  console.log('--- Top 15 by FULL final $ ---')
  console.log('SMA Conf Dist Hold | rotN trN |  FULL$    TRAIN$   TEST$  | totalR    WR%  DD%')
  console.log('-'.repeat(95))
  for (const r of results.slice(0, 15)) {
    const fr = ((r.fullFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
    const tr = ((r.trainFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
    const te = ((r.testFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
    console.log(
      `${r.smaP.toString().padStart(3)} ${r.confirm.toString().padStart(4)} ${r.distance.toString().padStart(4)} ${r.minHold.toString().padStart(4)} | ${r.rotations.toString().padStart(4)} ${r.trades.toString().padStart(3)} | ` +
      `$${r.fullFinal.toFixed(0).padStart(4)}(${fr.padStart(4)}%) $${r.trainFinal.toFixed(0).padStart(4)}(${tr.padStart(4)}%) $${r.testFinal.toFixed(0).padStart(4)}(${te.padStart(4)}%) | ` +
      `${(r.fullR >= 0 ? '+' : '') + r.fullR.toFixed(1).padStart(6)}  ${r.fullWR.toFixed(0)}%  ${r.fullDD.toFixed(0)}%`,
    )
  }

  // Robust (both TRAIN+TEST positive)
  console.log('\n--- Robust (TRAIN+TEST both positive) ---')
  const robust = results.filter(r =>
    r.trainFinal > VARIANT.startingDeposit && r.testFinal > VARIANT.startingDeposit,
  )
  if (robust.length === 0) {
    console.log('(none)')
  } else {
    robust.sort((a, b) => b.fullFinal - a.fullFinal)
    for (const r of robust.slice(0, 10)) {
      const fr = ((r.fullFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
      const tr = ((r.trainFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
      const te = ((r.testFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
      console.log(
        `✓ SMA=${r.smaP} Conf=${r.confirm} Dist=${r.distance}% Hold=${r.minHold} | rot=${r.rotations} tr=${r.trades} | ` +
        `FULL +${fr}% TRAIN +${tr}% TEST +${te}% | R=${r.fullR.toFixed(1)} WR=${r.fullWR.toFixed(0)}% DD=${r.fullDD.toFixed(0)}%`,
      )
    }
  }

  // By TEST best
  console.log('\n--- Top 10 by TEST out-of-sample ---')
  const byTest = [...results].sort((a, b) => b.testFinal - a.testFinal)
  for (const r of byTest.slice(0, 10)) {
    const te = ((r.testFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
    const tr = ((r.trainFinal / VARIANT.startingDeposit - 1) * 100).toFixed(0)
    console.log(
      `TEST $${r.testFinal.toFixed(0)} (${te}%) | TRAIN ${tr}% | SMA=${r.smaP} Conf=${r.confirm} Dist=${r.distance}% Hold=${r.minHold} | rot=${r.rotations} tr=${r.trades} | testR=${r.testR.toFixed(1)}`,
    )
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `btc_dom_rotation_sweep_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sweep: { SMA_PERIODS, CONFIRM_DAYS_LIST, DISTANCE_PCTS, MIN_HOLD_DAYS_LIST },
    results,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
