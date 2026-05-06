/**
 * Quick A/B: how many signals does the new minRR/maxRR filter remove?
 * Compares baseline (no RR filter) vs new (minRR=1.5, maxRR=8) on production setups.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_rr_impact.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

type Side = 'BUY' | 'SELL' | 'BOTH'

interface RunCase { symbol: string; side: Side; tpMinAtr?: number }

// Production setups (DEFAULT_SETUPS from levelsLiveScanner)
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

function buildCfg(tpMinAtr: number, withRR: boolean): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
    minRR: withRR ? 1.5 : 0,
    maxRR: withRR ? 8 : 0,
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface Result {
  symbol: string; side: Side
  baselineN: number; baselineR: number
  filteredN: number; filteredR: number
  removedN: number; removedPct: number
  rDelta: number
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5 = await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1 = await loadHistorical(symbol, '1h', MONTHS_BACK, 'bybit', 'linear')
    const d1 = await loadHistorical(symbol, '1d', MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch (e: any) {
    return null
  }
}

function runOne(data: LoadedData, c: RunCase, withRR: boolean): { n: number; totalR: number } {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0, withRR)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

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
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)
  const totalR = r.trades.reduce((a, t) => a + t.pnlR, 0)
  return { n: r.trades.length, totalR }
}

async function main() {
  console.log(`R:R filter impact: baseline (no filter) vs new (minRR=1.5, maxRR=8)`)
  console.log(`365d, 15 production setups\n`)

  const allResults: Result[] = []
  let bN = 0, bR = 0, fN = 0, fR = 0
  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.log(`${c.symbol}: SKIP`); continue }
    const baseline = runOne(data, c, false)
    const filtered = runOne(data, c, true)
    const removedN = baseline.n - filtered.n
    const removedPct = baseline.n > 0 ? (removedN / baseline.n) * 100 : 0
    const rDelta = filtered.totalR - baseline.totalR
    allResults.push({
      symbol: c.symbol, side: c.side,
      baselineN: baseline.n, baselineR: baseline.totalR,
      filteredN: filtered.n, filteredR: filtered.totalR,
      removedN, removedPct, rDelta,
    })
    bN += baseline.n; bR += baseline.totalR
    fN += filtered.n; fR += filtered.totalR
    const arrow = rDelta > 0 ? '↑' : rDelta < 0 ? '↓' : '='
    console.log(`${c.symbol.padEnd(15)} ${c.side.padEnd(5)} | base: N=${baseline.n.toString().padStart(3)} R=${baseline.totalR.toFixed(0).padStart(5)} | filt: N=${filtered.n.toString().padStart(3)} R=${filtered.totalR.toFixed(0).padStart(5)} | -${removedN.toString().padStart(3)} (${removedPct.toFixed(0).padStart(2)}%) ${arrow}${Math.abs(rDelta).toFixed(0)}R`)
  }

  console.log('\n=== PORTFOLIO TOTAL ===')
  console.log(`Baseline:  N=${bN}  totR=${bR.toFixed(0)}`)
  console.log(`With R:R:  N=${fN}  totR=${fR.toFixed(0)}`)
  const removedTotal = bN - fN
  const removedPctTotal = bN > 0 ? (removedTotal / bN) * 100 : 0
  const rDelta = fR - bR
  console.log(`\nDIFF:      -${removedTotal} signals (${removedPctTotal.toFixed(1)}%)  ${rDelta >= 0 ? '+' : ''}${rDelta.toFixed(0)}R`)
  if (bN > 0) {
    const baseEv = bR / bN
    const filtEv = fN > 0 ? fR / fN : 0
    console.log(`R/trade baseline: ${baseEv.toFixed(2)}, filtered: ${filtEv.toFixed(2)}, Δ ${(filtEv - baseEv >= 0 ? '+' : '') + (filtEv - baseEv).toFixed(2)}`)
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
