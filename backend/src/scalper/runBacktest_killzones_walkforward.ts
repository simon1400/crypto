/**
 * Walk-forward validation for per-setup × session edge.
 * For each (symbol, side, session) combo, check if R/tr > 0 in BOTH TRAIN (older 6mo)
 * and TEST (newer 6mo). Only those are stable.
 *
 * Min sample: 5 trades per period.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_killzones_walkforward.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const TOTAL_DAYS = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

interface RunCase { symbol: string; side: 'BUY' | 'SELL' | 'BOTH'; tpMinAtr?: number }

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT', side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'SEIUSDT', side: 'SELL' },
  { symbol: 'WIFUSDT', side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'SOLUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ARBUSDT', side: 'SELL' },
  { symbol: 'AVAXUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT', side: 'SELL' },
  { symbol: 'HYPEUSDT', side: 'BUY', tpMinAtr: 0.5 },
  { symbol: 'ENAUSDT', side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'AAVEUSDT', side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'STRKUSDT', side: 'SELL' },
  { symbol: 'BLURUSDT', side: 'SELL' },
  { symbol: 'CRVUSDT', side: 'SELL', tpMinAtr: 0.5 },
]

type Session = 'ASIAN' | 'LONDON' | 'NY' | 'NY_PM' | 'OFF'
const SESSIONS: Session[] = ['ASIAN', 'LONDON', 'NY', 'NY_PM', 'OFF']

function sessionOf(unixMs: number): Session {
  const hour = new Date(unixMs).getUTCHours()
  if (hour >= 23 || hour < 4) return 'ASIAN'
  if (hour >= 6 && hour < 9) return 'LONDON'
  if (hour >= 12 && hour < 15) return 'NY'
  if (hour >= 15 && hour < 17) return 'NY_PM'
  return 'OFF'
}

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
    minRR: 0, maxRR: 8,
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5 = await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1 = await loadHistorical(symbol, '1h', MONTHS_BACK, 'bybit', 'linear')
    const d1 = await loadHistorical(symbol, '1d', MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch { return null }
}

function runOne(data: LoadedData, c: RunCase): LadderTrade[] {
  const ltf = sliceLastDays(data.m5, TOTAL_DAYS)
  const mtf = sliceLastDays(data.m15, TOTAL_DAYS)
  const htf = sliceLastDays(data.h1, TOTAL_DAYS)
  const dly = sliceLastDays(data.d1, TOTAL_DAYS)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - TOTAL_DAYS * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigByIdx.set(i, {
      side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
    })
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0008,
  }
  return runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface Bucket { trades: number; totalR: number }
function newBucket(): Bucket { return { trades: 0, totalR: 0 } }

interface SessionVerdict {
  symbol: string
  session: Session
  trainN: number; trainEv: number
  testN: number; testEv: number
  stable: boolean
}

async function main() {
  const now = Date.now()
  const splitTime = now - 180 * 24 * 60 * 60_000
  const totalStart = now - TOTAL_DAYS * 24 * 60 * 60_000
  console.log(`Walk-forward per-setup × session\n`)
  console.log(`TRAIN: ${new Date(totalStart).toISOString().slice(0, 10)} → ${new Date(splitTime).toISOString().slice(0, 10)}`)
  console.log(`TEST:  ${new Date(splitTime).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)}\n`)

  const verdicts: SessionVerdict[] = []
  // Stable map: setupKey -> set of stable sessions
  const stableSetupSessions = new Map<string, Set<Session>>()

  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.log(`${c.symbol} SKIP`); continue }
    const trades = runOne(data, c)

    const trainBuckets: Record<Session, Bucket> = {
      ASIAN: newBucket(), LONDON: newBucket(), NY: newBucket(), NY_PM: newBucket(), OFF: newBucket(),
    }
    const testBuckets: Record<Session, Bucket> = {
      ASIAN: newBucket(), LONDON: newBucket(), NY: newBucket(), NY_PM: newBucket(), OFF: newBucket(),
    }
    for (const t of trades) {
      const sess = sessionOf(t.entryTime)
      const target = t.entryTime < splitTime ? trainBuckets : testBuckets
      target[sess].trades++
      target[sess].totalR += t.pnlR
    }

    const setupKey = `${c.symbol}:${c.side}`
    const stableSet = new Set<Session>()
    for (const sess of SESSIONS) {
      const tr = trainBuckets[sess]
      const te = testBuckets[sess]
      const trEv = tr.trades > 0 ? tr.totalR / tr.trades : 0
      const teEv = te.trades > 0 ? te.totalR / te.trades : 0
      // Stable: both periods positive AND >= 5 trades each
      const stable = tr.trades >= 5 && te.trades >= 5 && trEv > 0 && teEv > 0
      verdicts.push({
        symbol: c.symbol, session: sess,
        trainN: tr.trades, trainEv: trEv,
        testN: te.trades, testEv: teEv,
        stable,
      })
      if (stable) stableSet.add(sess)
    }
    stableSetupSessions.set(setupKey, stableSet)
  }

  // Print only STABLE combos
  console.log('=== STABLE EDGES (positive R/tr in BOTH train and test, >= 5 trades each) ===\n')
  console.log('Symbol         Session  | TRAIN              | TEST               | Verdict')
  console.log('-'.repeat(95))
  let stableCount = 0
  for (const v of verdicts) {
    if (!v.stable) continue
    stableCount++
    const trStr = `N=${v.trainN.toString().padStart(3)} R/tr=${(v.trainEv >= 0 ? '+' : '') + v.trainEv.toFixed(2)}`
    const teStr = `N=${v.testN.toString().padStart(3)} R/tr=${(v.testEv >= 0 ? '+' : '') + v.testEv.toFixed(2)}`
    console.log(`${v.symbol.padEnd(13)} ${v.session.padEnd(8)} | ${trStr.padEnd(18)} | ${teStr.padEnd(18)} | ★ STABLE`)
  }
  if (stableCount === 0) console.log('(none)')

  // Print UNSTABLE for reference (not all — top losers in test)
  console.log('\n=== UNSTABLE (one period positive, other negative or low-N) ===\n')
  console.log('Symbol         Session  | TRAIN              | TEST               | Verdict')
  console.log('-'.repeat(95))
  for (const v of verdicts) {
    if (v.stable) continue
    if (v.trainN < 5 && v.testN < 5) continue // skip totally empty
    const trStr = v.trainN === 0 ? '   (no trades)   ' : `N=${v.trainN.toString().padStart(3)} R/tr=${(v.trainEv >= 0 ? '+' : '') + v.trainEv.toFixed(2)}`
    const teStr = v.testN === 0 ? '   (no trades)   ' : `N=${v.testN.toString().padStart(3)} R/tr=${(v.testEv >= 0 ? '+' : '') + v.testEv.toFixed(2)}`
    let verdict = '⚠ UNSTABLE'
    if (v.trainEv < 0 && v.testEv < 0) verdict = '✗ DROP (both negative)'
    else if (v.trainN < 5 || v.testN < 5) verdict = '? LOW SAMPLE'
    console.log(`${v.symbol.padEnd(13)} ${v.session.padEnd(8)} | ${trStr.padEnd(18)} | ${teStr.padEnd(18)} | ${verdict}`)
  }

  // Hypothetical hybrid portfolio: only take trades where (setup, session) is stable
  console.log('\n=== HYPOTHETICAL HYBRID PORTFOLIO (only stable per-setup × session) ===\n')
  let hybN = 0, hybR = 0, baseN = 0, baseR = 0
  // Test-period results (out-of-sample)
  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) continue
    const trades = runOne(data, c).filter(t => t.entryTime >= splitTime)
    const setupKey = `${c.symbol}:${c.side}`
    const stableSet = stableSetupSessions.get(setupKey) ?? new Set()
    for (const t of trades) {
      const sess = sessionOf(t.entryTime)
      baseN++; baseR += t.pnlR
      if (stableSet.has(sess)) {
        hybN++; hybR += t.pnlR
      }
    }
  }
  console.log(`TEST period (out-of-sample 6 months):`)
  console.log(`  Baseline (all sessions, no filter): N=${baseN} totR=${baseR.toFixed(0)} R/tr=${baseN > 0 ? (baseR / baseN).toFixed(2) : 0}`)
  console.log(`  Hybrid (only stable session combos): N=${hybN} totR=${hybR.toFixed(0)} R/tr=${hybN > 0 ? (hybR / hybN).toFixed(2) : 0}`)
  if (hybN > 0 && baseN > 0) {
    const baseEv = baseR / baseN
    const hybEv = hybR / hybN
    console.log(`  Edge improvement: R/tr ${baseEv.toFixed(2)} → ${hybEv.toFixed(2)} (Δ ${(hybEv - baseEv >= 0 ? '+' : '') + (hybEv - baseEv).toFixed(2)})`)
    console.log(`  Trade reduction: ${baseN} → ${hybN} (-${((1 - hybN / baseN) * 100).toFixed(0)}%)`)
    console.log(`  Total R: ${baseR.toFixed(0)} → ${hybR.toFixed(0)} (Δ ${(hybR - baseR >= 0 ? '+' : '') + (hybR - baseR).toFixed(0)}R)`)
  }

  // Print final recommendation as JSON-like config
  console.log('\n=== RECOMMENDED PER-SETUP SESSION CONFIG ===\n')
  for (const c of CASES) {
    const setupKey = `${c.symbol}:${c.side}`
    const stableSet = stableSetupSessions.get(setupKey) ?? new Set()
    const sessions = SESSIONS.filter(s => stableSet.has(s))
    if (sessions.length === 0) {
      console.log(`  ${c.symbol.padEnd(13)} ${c.side.padEnd(5)}: (no stable session — skip or use all)`)
    } else {
      console.log(`  ${c.symbol.padEnd(13)} ${c.side.padEnd(5)}: ${sessions.join(', ')}`)
    }
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
