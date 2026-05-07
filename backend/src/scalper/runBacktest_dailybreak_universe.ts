/**
 * Daily Breakout — universe expansion backtest.
 *
 * Прогоняет ВСЕ закэшированные монеты Bybit (5m JSON в data/backtest/) через
 * Daily Breakout с optimal config. Цель — найти кандидатов на расширение
 * DEFAULT_BREAKOUT_SETUPS (сейчас 11 монет).
 *
 * Optimal config:
 *   - rangeBars=36 (3h UTC)
 *   - volMultiplier=2.0
 *   - splits 50/30/20
 *   - full trailing (TP1→BE, TP2→TP1, TP3→TP2)
 *   - feesRoundTrip=0.0008, slippagePerSide=0.0005 (0.05%)
 *
 * Walk-forward: FULL (365d) / TRAIN (60% = 219d) / TEST (40% = 146d)
 *
 * Acceptance criteria for production:
 *   FULL N >= 30 AND TRAIN R/tr > 0 AND TEST R/tr > +0.20 AND TEST N >= 10
 *
 * Borderline (для обсуждения): TEST R/tr +0.10..+0.20 при остальных пройденных.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_universe.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

// Optimal config (locked in 2026-05-07)
const RANGE_BARS = 36       // 3h UTC
const VOL_MULT = 2.0
const TP1_MULT = 1.0
const TP2_MULT = 2.0
const TP3_MULT = 3.0
const SLIPPAGE = 0.0005     // 0.05% per side, Bybit maker realistic
const FEES_RT = 0.0008      // 0.08% round-trip

// Acceptance thresholds
const MIN_FULL_N = 30
const MIN_TEST_N = 10
const MIN_TEST_RPT = 0.20
const BORDERLINE_TEST_RPT = 0.10

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

function discoverCachedSymbols(): string[] {
  if (!fs.existsSync(CACHE_DIR)) {
    console.error(`[Universe] Cache dir not found: ${CACHE_DIR}`)
    return []
  }
  const files = fs.readdirSync(CACHE_DIR)
  const symbols: string[] = []
  for (const f of files) {
    const m = f.match(/^bybit_(.+)_5m\.json$/)
    if (m) symbols.push(m[1])
  }
  return symbols.sort()
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

async function loadM5(symbol: string): Promise<OHLCV[]> {
  // monthsBack=MONTHS_BACK so loader uses cached range; if cache exists it won't refetch.
  return await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
}

interface BreakoutCfg {
  rangeBars: number
  volMultiplier: number
  tp1Mult: number
  tp2Mult: number
  tp3Mult: number
}

const OPTIMAL_CFG: BreakoutCfg = {
  rangeBars: RANGE_BARS,
  volMultiplier: VOL_MULT,
  tp1Mult: TP1_MULT,
  tp2Mult: TP2_MULT,
  tp3Mult: TP3_MULT,
}

function generateBreakoutSignals(
  m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number,
): LadderSignal[] {
  const sigs: LadderSignal[] = []

  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
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

function runOne(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): LadderTrade[] {
  const sigs = generateBreakoutSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick',
    splits: [0.5, 0.3, 0.2],
    trailing: true,         // full trailing default in DEFAULT_LADDER, set explicit
    feesRoundTrip: FEES_RT,
    slippagePerSide: SLIPPAGE,
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

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtTotR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(0) }

interface SymbolResult {
  symbol: string
  full: Stat
  train: Stat
  test: Stat
  error?: string
}

function verdictFor(r: SymbolResult): 'ACCEPT' | 'BORDERLINE' | 'REJECT' | 'ERROR' {
  if (r.error) return 'ERROR'
  if (r.full.n < MIN_FULL_N) return 'REJECT'
  if (r.train.rPerTr <= 0) return 'REJECT'
  if (r.test.n < MIN_TEST_N) return 'REJECT'
  if (r.test.rPerTr >= MIN_TEST_RPT) return 'ACCEPT'
  if (r.test.rPerTr >= BORDERLINE_TEST_RPT) return 'BORDERLINE'
  return 'REJECT'
}

const CURRENT_PRODUCTION = new Set([
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
])

async function main() {
  console.log('Daily Breakout — universe expansion backtest')
  console.log(`Config: ${RANGE_BARS} bars (3h UTC), vol×${VOL_MULT}, TP ladder ${TP1_MULT}/${TP2_MULT}/${TP3_MULT}, trailing=full`)
  console.log(`Fees: ${FEES_RT * 100}% round-trip, slippage: ${SLIPPAGE * 100}% per side`)
  console.log(`Walk-forward: FULL ${DAYS_BACK}d / TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%`)
  console.log()

  const allSymbols = discoverCachedSymbols()
  console.log(`[Universe] Discovered ${allSymbols.length} cached symbols`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const results: SymbolResult[] = []

  for (const sym of allSymbols) {
    try {
      const all = await loadM5(sym)
      const m5 = sliceLastDays(all, DAYS_BACK)
      if (m5.length < 1000) {
        results.push({
          symbol: sym,
          full: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
          train: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
          test: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
          error: `only ${m5.length} candles in 365d window`,
        })
        continue
      }
      const full = summarize(runOne(m5, OPTIMAL_CFG, fullStart, now))
      const train = summarize(runOne(m5, OPTIMAL_CFG, fullStart, trainEnd))
      const test = summarize(runOne(m5, OPTIMAL_CFG, trainEnd, now))
      results.push({ symbol: sym, full, train, test })
    } catch (e: any) {
      results.push({
        symbol: sym,
        full: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
        train: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
        test: { n: 0, totalR: 0, rPerTr: 0, wr: 0 },
        error: e?.message ?? String(e),
      })
    }
  }

  // ============================================
  // 1. Per-symbol breakdown — sorted by TEST R/tr desc
  // ============================================
  console.log('=== 1. Per-symbol results (sorted by TEST R/tr desc) ===')
  console.log('Symbol           | FULL                            | TRAIN                           | TEST                            | Verdict')
  console.log('-'.repeat(160))
  const sorted = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1
    if (!a.error && b.error) return -1
    return b.test.rPerTr - a.test.rPerTr
  })
  for (const r of sorted) {
    if (r.error) {
      console.log(`${r.symbol.padEnd(16)} | ERROR: ${r.error}`)
      continue
    }
    const v = verdictFor(r)
    const inProd = CURRENT_PRODUCTION.has(r.symbol) ? ' [PROD]' : ''
    const fullCol = `N=${r.full.n.toString().padStart(3)} R/tr=${fmtR(r.full.rPerTr)} totR=${fmtTotR(r.full.totalR).padStart(5)} WR=${r.full.wr.toFixed(0)}%`
    const trainCol = `N=${r.train.n.toString().padStart(3)} R/tr=${fmtR(r.train.rPerTr)} totR=${fmtTotR(r.train.totalR).padStart(5)} WR=${r.train.wr.toFixed(0)}%`
    const testCol = `N=${r.test.n.toString().padStart(3)} R/tr=${fmtR(r.test.rPerTr)} totR=${fmtTotR(r.test.totalR).padStart(5)} WR=${r.test.wr.toFixed(0)}%`
    console.log(`${r.symbol.padEnd(16)} | ${fullCol.padEnd(31)} | ${trainCol.padEnd(31)} | ${testCol.padEnd(31)} | ${v}${inProd}`)
  }

  // ============================================
  // 2. Acceptance summary
  // ============================================
  const accepted = sorted.filter(r => verdictFor(r) === 'ACCEPT')
  const borderline = sorted.filter(r => verdictFor(r) === 'BORDERLINE')
  const rejected = sorted.filter(r => verdictFor(r) === 'REJECT')
  const errored = sorted.filter(r => verdictFor(r) === 'ERROR')

  console.log()
  console.log('=== 2. Verdict summary ===')
  console.log(`ACCEPT     (${accepted.length}): TEST R/tr >= +${MIN_TEST_RPT.toFixed(2)}, TRAIN R/tr > 0, FULL N >= ${MIN_FULL_N}, TEST N >= ${MIN_TEST_N}`)
  console.log(`BORDERLINE (${borderline.length}): TEST R/tr +${BORDERLINE_TEST_RPT.toFixed(2)}..+${MIN_TEST_RPT.toFixed(2)}, остальные критерии пройдены`)
  console.log(`REJECT     (${rejected.length}): не прошёл критерии`)
  console.log(`ERROR      (${errored.length}): не удалось прогнать`)

  console.log()
  console.log('=== 3. ACCEPT candidates ===')
  if (accepted.length === 0) {
    console.log('  (none)')
  } else {
    console.log('  Symbol           | FULL R/tr | TRAIN R/tr | TEST R/tr | TEST N | In prod?')
    for (const r of accepted) {
      const inProd = CURRENT_PRODUCTION.has(r.symbol) ? 'YES' : 'NO'
      console.log(`  ${r.symbol.padEnd(16)} | ${fmtR(r.full.rPerTr).padStart(9)} | ${fmtR(r.train.rPerTr).padStart(10)} | ${fmtR(r.test.rPerTr).padStart(9)} | ${r.test.n.toString().padStart(6)} | ${inProd}`)
    }
  }

  console.log()
  console.log('=== 4. BORDERLINE candidates ===')
  if (borderline.length === 0) {
    console.log('  (none)')
  } else {
    console.log('  Symbol           | FULL R/tr | TRAIN R/tr | TEST R/tr | TEST N | In prod?')
    for (const r of borderline) {
      const inProd = CURRENT_PRODUCTION.has(r.symbol) ? 'YES' : 'NO'
      console.log(`  ${r.symbol.padEnd(16)} | ${fmtR(r.full.rPerTr).padStart(9)} | ${fmtR(r.train.rPerTr).padStart(10)} | ${fmtR(r.test.rPerTr).padStart(9)} | ${r.test.n.toString().padStart(6)} | ${inProd}`)
    }
  }

  // ============================================
  // 5. Current production sanity check (re-test each prod symbol)
  // ============================================
  console.log()
  console.log('=== 5. Current production verdict (sanity) ===')
  const prodInResults = sorted.filter(r => CURRENT_PRODUCTION.has(r.symbol))
  for (const r of prodInResults) {
    const v = verdictFor(r)
    console.log(`  ${r.symbol.padEnd(16)} TEST R/tr=${fmtR(r.test.rPerTr)} N=${r.test.n} → ${v}`)
  }
  const prodMissing = [...CURRENT_PRODUCTION].filter(s => !sorted.some(r => r.symbol === s))
  if (prodMissing.length) {
    console.log(`  [WARN] not found in cache: ${prodMissing.join(', ')}`)
  }

  // ============================================
  // 6. Combined-portfolio totals (only ACCEPT pool, including current prod) — informational
  // ============================================
  console.log()
  console.log('=== 6. Hypothetical portfolio (current prod + new ACCEPT) — combined totals ===')
  const portfolioSymbols = new Set<string>([...CURRENT_PRODUCTION])
  for (const r of accepted) portfolioSymbols.add(r.symbol)
  const portfolioFull: LadderTrade[] = []
  const portfolioTrain: LadderTrade[] = []
  const portfolioTest: LadderTrade[] = []
  for (const sym of portfolioSymbols) {
    try {
      const all = await loadM5(sym)
      const m5 = sliceLastDays(all, DAYS_BACK)
      if (m5.length < 1000) continue
      portfolioFull.push(...runOne(m5, OPTIMAL_CFG, fullStart, now))
      portfolioTrain.push(...runOne(m5, OPTIMAL_CFG, fullStart, trainEnd))
      portfolioTest.push(...runOne(m5, OPTIMAL_CFG, trainEnd, now))
    } catch { /* skip */ }
  }
  const pf = summarize(portfolioFull), pt = summarize(portfolioTrain), pe = summarize(portfolioTest)
  console.log(`  Symbols (${portfolioSymbols.size}): ${[...portfolioSymbols].sort().join(', ')}`)
  console.log(`  FULL  N=${pf.n} R/tr=${fmtR(pf.rPerTr)} totR=${fmtTotR(pf.totalR)} WR=${pf.wr.toFixed(0)}%`)
  console.log(`  TRAIN N=${pt.n} R/tr=${fmtR(pt.rPerTr)} totR=${fmtTotR(pt.totalR)} WR=${pt.wr.toFixed(0)}%`)
  console.log(`  TEST  N=${pe.n} R/tr=${fmtR(pe.rPerTr)} totR=${fmtTotR(pe.totalR)} WR=${pe.wr.toFixed(0)}%`)

  console.log()
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
