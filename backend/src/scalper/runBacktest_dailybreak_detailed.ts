/**
 * Daily Breakout — detailed breakdown.
 *
 * Запускает single-symbol ladder backtest на каждой монете отдельно,
 * чтобы увидеть per-symbol edge. Также тестит range hours и volume threshold.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_detailed.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT',
  'ARBUSDT', 'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT',
  'WIFUSDT', 'SEIUSDT', 'STRKUSDT', 'BLURUSDT', 'CRVUSDT',
]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

async function loadM5(symbol: string): Promise<OHLCV[]> {
  return await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
}

interface BreakoutCfg {
  rangeBars: number     // first N 5m bars define range (default 48 = 4h)
  volMultiplier: number // current vol must exceed avg × multiplier
  tp1Mult: number       // TP1 = entry + range × this
  tp2Mult: number
  tp3Mult: number
}

const DEFAULT_BCFG: BreakoutCfg = {
  rangeBars: 48, volMultiplier: 1.5, tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
}

function generateBreakoutSignals(symbol: string, m5: OHLCV[], cfg: BreakoutCfg, periodFrom?: number, periodTo?: number): LadderSignal[] {
  const cutoff = periodFrom ?? (Date.now() - DAYS_BACK * 24 * 60 * 60_000)
  const cutoffEnd = periodTo ?? Date.now()
  const sigs: LadderSignal[] = []

  // Group 5m candles by day (UTC)
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < cutoff || c.time > cutoffEnd) continue
    const d = new Date(c.time).toISOString().slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }

  for (const [, candles] of byDay) {
    if (candles.length < cfg.rangeBars + 5) continue
    const rangeBars = candles.slice(0, cfg.rangeBars)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue

    let triggered = false
    for (let i = cfg.rangeBars; i < candles.length && !triggered; i++) {
      const c = candles[i]
      const start = Math.max(0, i - 24)
      const avgVol = candles.slice(start, i).reduce((s, x) => s + x.volume, 0) / Math.max(1, i - start)
      if (c.volume < avgVol * cfg.volMultiplier) continue

      let side: 'BUY' | 'SELL' | null = null
      let entryPrice = 0
      if (c.high > rangeHigh && c.close > rangeHigh) { side = 'BUY'; entryPrice = rangeHigh }
      else if (c.low < rangeLow && c.close < rangeLow) { side = 'SELL'; entryPrice = rangeLow }
      if (!side) continue

      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * cfg.tp1Mult, entryPrice + rangeSize * cfg.tp2Mult, entryPrice + rangeSize * cfg.tp3Mult]
        : [entryPrice - rangeSize * cfg.tp1Mult, entryPrice - rangeSize * cfg.tp2Mult, entryPrice - rangeSize * cfg.tp3Mult]

      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

function runOne(symbol: string, m5: OHLCV[], cfg: BreakoutCfg, slippage: number, periodFrom?: number, periodTo?: number): LadderTrade[] {
  const sigs = generateBreakoutSignals(symbol, m5, cfg, periodFrom, periodTo)
  // Map signal entryTime to candle index
  const periodCandles = m5.filter(c =>
    (periodFrom ? c.time >= periodFrom : true) &&
    (periodTo ? c.time <= periodTo : true)
  )
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true,  // full trailing: TP1→BE, TP2→TP1, TP3→TP2
    feesRoundTrip: 0.0008, slippagePerSide: slippage,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface Stat { n: number; totalR: number; rPerTr: number; wr: number }
function summarize(trades: LadderTrade[]): Stat {
  if (trades.length === 0) return { n: 0, totalR: 0, rPerTr: 0, wr: 0 }
  let totalR = 0, wins = 0
  for (const t of trades) { totalR += t.pnlR; if (t.pnlR > 0) wins++ }
  return { n: trades.length, totalR, rPerTr: totalR / trades.length, wr: (wins / trades.length) * 100 }
}
function fmt(s: Stat): string {
  if (s.n === 0) return '   no trades  '
  return `N=${s.n.toString().padStart(3)} R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)} totR=${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(0).padStart(4)} WR=${s.wr.toFixed(0)}%`
}

async function main() {
  console.log('Daily Breakout — detailed breakdown')
  console.log()

  // Load all m5
  const data = new Map<string, OHLCV[]>()
  for (const sym of SYMBOLS) {
    const m5 = sliceLastDays(await loadM5(sym), DAYS_BACK)
    data.set(sym, m5)
  }

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * 0.4) * 24 * 60 * 60_000
  const now = Date.now()

  // ============================================
  // 1. Per-symbol breakdown (default cfg, 0 slippage)
  // ============================================
  console.log('=== 1. Per-symbol breakdown (default 4h range, vol×1.5, no slippage) ===')
  console.log('Symbol            FULL                                TRAIN                               TEST')
  console.log('-'.repeat(130))
  for (const sym of SYMBOLS) {
    const m5 = data.get(sym)!
    const full = runOne(sym, m5, DEFAULT_BCFG, 0, fullStart, now)
    const train = runOne(sym, m5, DEFAULT_BCFG, 0, fullStart, trainEnd)
    const test = runOne(sym, m5, DEFAULT_BCFG, 0, trainEnd, now)
    console.log(`${sym.padEnd(15)} ${fmt(summarize(full)).padEnd(36)} ${fmt(summarize(train)).padEnd(36)} ${fmt(summarize(test))}`)
  }

  // ============================================
  // 2. Range hours sweep (per portfolio)
  // ============================================
  console.log('\n=== 2. Range hours sweep (TRAIN/TEST portfolio R/tr) ===')
  console.log('Range  | TRAIN R/tr  N      | TEST R/tr  N')
  console.log('-'.repeat(60))
  const RANGE_OPTIONS = [
    { label: '2h  ', bars: 24 },
    { label: '3h  ', bars: 36 },
    { label: '4h  ', bars: 48 },
    { label: '6h  ', bars: 72 },
    { label: '8h  ', bars: 96 },
    { label: '12h ', bars: 144 },
  ]
  for (const opt of RANGE_OPTIONS) {
    const cfg = { ...DEFAULT_BCFG, rangeBars: opt.bars }
    let trainAll: LadderTrade[] = [], testAll: LadderTrade[] = []
    for (const sym of SYMBOLS) {
      const m5 = data.get(sym)!
      trainAll.push(...runOne(sym, m5, cfg, 0, fullStart, trainEnd))
      testAll.push(...runOne(sym, m5, cfg, 0, trainEnd, now))
    }
    const tr = summarize(trainAll), te = summarize(testAll)
    console.log(`${opt.label} | R/tr=${(tr.rPerTr >= 0 ? '+' : '') + tr.rPerTr.toFixed(2)}  N=${tr.n.toString().padStart(4)} | R/tr=${(te.rPerTr >= 0 ? '+' : '') + te.rPerTr.toFixed(2)}  N=${te.n.toString().padStart(4)}`)
  }

  // ============================================
  // 3. Volume threshold sweep
  // ============================================
  console.log('\n=== 3. Volume threshold sweep (default 4h range) ===')
  console.log('Vol mult | TRAIN R/tr  N       | TEST R/tr  N')
  console.log('-'.repeat(60))
  const VOL_OPTIONS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
  for (const v of VOL_OPTIONS) {
    const cfg = { ...DEFAULT_BCFG, volMultiplier: v }
    let trainAll: LadderTrade[] = [], testAll: LadderTrade[] = []
    for (const sym of SYMBOLS) {
      const m5 = data.get(sym)!
      trainAll.push(...runOne(sym, m5, cfg, 0, fullStart, trainEnd))
      testAll.push(...runOne(sym, m5, cfg, 0, trainEnd, now))
    }
    const tr = summarize(trainAll), te = summarize(testAll)
    console.log(`×${v.toFixed(2)}  | R/tr=${(tr.rPerTr >= 0 ? '+' : '') + tr.rPerTr.toFixed(2)}  N=${tr.n.toString().padStart(4)} | R/tr=${(te.rPerTr >= 0 ? '+' : '') + te.rPerTr.toFixed(2)}  N=${te.n.toString().padStart(4)}`)
  }

  // ============================================
  // 4. Slippage stress (default cfg)
  // ============================================
  console.log('\n=== 4. Slippage stress test (default cfg) ===')
  console.log('Slippage | TRAIN R/tr  totR | TEST R/tr  totR')
  console.log('-'.repeat(60))
  const SLIP_OPTIONS = [0, 0.0005, 0.001, 0.0015, 0.002]  // 0%, 0.05%, 0.1%, 0.15%, 0.2% per side
  for (const slip of SLIP_OPTIONS) {
    let trainAll: LadderTrade[] = [], testAll: LadderTrade[] = []
    for (const sym of SYMBOLS) {
      const m5 = data.get(sym)!
      trainAll.push(...runOne(sym, m5, DEFAULT_BCFG, slip, fullStart, trainEnd))
      testAll.push(...runOne(sym, m5, DEFAULT_BCFG, slip, trainEnd, now))
    }
    const tr = summarize(trainAll), te = summarize(testAll)
    console.log(`${(slip * 100).toFixed(2)}%   | R/tr=${(tr.rPerTr >= 0 ? '+' : '') + tr.rPerTr.toFixed(2)}  totR=${(tr.totalR >= 0 ? '+' : '') + tr.totalR.toFixed(0).padStart(4)} | R/tr=${(te.rPerTr >= 0 ? '+' : '') + te.rPerTr.toFixed(2)}  totR=${(te.totalR >= 0 ? '+' : '') + te.totalR.toFixed(0).padStart(4)}`)
  }

  // ============================================
  // 6. OPTIMAL CONFIG: 3h range, vol×2.0, 11 monetах (без BTC/WIF/STRK/CRV)
  // ============================================
  console.log('\n=== 6. OPTIMAL: 3h range, vol×2.0, 11 monetах (без BTC/WIF/STRK/CRV) ===')
  const OPTIMAL_CFG: BreakoutCfg = { rangeBars: 36, volMultiplier: 2.0, tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0 }
  const OPTIMAL_SYMBOLS = SYMBOLS.filter(s => !['BTCUSDT', 'WIFUSDT', 'STRKUSDT', 'CRVUSDT'].includes(s))
  console.log(`Symbols: ${OPTIMAL_SYMBOLS.join(', ')}`)
  console.log('Symbol            FULL                                TRAIN                               TEST')
  console.log('-'.repeat(130))
  let optFullAll: LadderTrade[] = [], optTrainAll: LadderTrade[] = [], optTestAll: LadderTrade[] = []
  for (const sym of OPTIMAL_SYMBOLS) {
    const m5 = data.get(sym)!
    const full = runOne(sym, m5, OPTIMAL_CFG, 0.0005, fullStart, now)  // 0.05% slippage realistic
    const train = runOne(sym, m5, OPTIMAL_CFG, 0.0005, fullStart, trainEnd)
    const test = runOne(sym, m5, OPTIMAL_CFG, 0.0005, trainEnd, now)
    optFullAll.push(...full); optTrainAll.push(...train); optTestAll.push(...test)
    console.log(`${sym.padEnd(15)} ${fmt(summarize(full)).padEnd(36)} ${fmt(summarize(train)).padEnd(36)} ${fmt(summarize(test))}`)
  }
  console.log('-'.repeat(130))
  console.log(`PORTFOLIO       ${fmt(summarize(optFullAll)).padEnd(36)} ${fmt(summarize(optTrainAll)).padEnd(36)} ${fmt(summarize(optTestAll))}`)
  console.log(`(includes 0.05% slippage per side, realistic Bybit maker fee scenario)`)

  // ============================================
  // 5. Per-month profitability (default cfg, FULL period)
  // ============================================
  console.log('\n=== 5. Per-month R/tr (default cfg, all monetах combined) ===')
  console.log('Month   | N      R/tr     totR')
  console.log('-'.repeat(50))
  let allFull: LadderTrade[] = []
  for (const sym of SYMBOLS) {
    allFull.push(...runOne(sym, data.get(sym)!, DEFAULT_BCFG, 0, fullStart, now))
  }
  const byMonth = new Map<string, LadderTrade[]>()
  for (const t of allFull) {
    const m = new Date(t.entryTime).toISOString().slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(t)
  }
  const months = [...byMonth.keys()].sort()
  for (const m of months) {
    const s = summarize(byMonth.get(m)!)
    const sign = s.totalR >= 0 ? '+' : ''
    console.log(`${m} | N=${s.n.toString().padStart(3)}  R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)}  totR=${sign}${s.totalR.toFixed(0)}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
