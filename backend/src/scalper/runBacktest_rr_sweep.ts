/**
 * Sweep maxRR values to find optimal threshold (or confirm RR filter is harmful).
 * Tests {none, 12, 10, 8, 6} on portfolio.
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

const SCENARIOS: { label: string; minRR: number; maxRR: number }[] = [
  { label: 'baseline (no filter)', minRR: 0, maxRR: 0 },
  { label: 'maxRR=15 only', minRR: 0, maxRR: 15 },
  { label: 'maxRR=10 only', minRR: 0, maxRR: 10 },
  { label: 'maxRR=8 only', minRR: 0, maxRR: 8 },
  { label: 'minRR=1.5 + maxRR=10', minRR: 1.5, maxRR: 10 },
  { label: 'minRR=1.5 + maxRR=8', minRR: 1.5, maxRR: 8 },
  { label: 'minRR=2 + maxRR=8', minRR: 2, maxRR: 8 },
]

function buildCfg(tpMinAtr: number, minRR: number, maxRR: number): LevelsV2Config {
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
    tpMinAtr, minRR, maxRR,
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

function runOne(data: LoadedData, c: RunCase, minRR: number, maxRR: number): { n: number; totalR: number } {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0, minRR, maxRR)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigByIdx.set(i, { side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason })
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
  // Load all data once
  const dataBySymbol = new Map<string, LoadedData>()
  for (const c of CASES) {
    const d = await loadAll(c.symbol)
    if (d) dataBySymbol.set(c.symbol, d)
  }

  console.log('\n=== Portfolio totals across scenarios ===\n')
  console.log('Scenario                 | Trades  totalR    R/tr')
  console.log('-'.repeat(60))
  for (const sc of SCENARIOS) {
    let totN = 0, totR = 0
    for (const c of CASES) {
      const data = dataBySymbol.get(c.symbol)
      if (!data) continue
      const r = runOne(data, c, sc.minRR, sc.maxRR)
      totN += r.n; totR += r.totalR
    }
    const ev = totN > 0 ? totR / totN : 0
    console.log(`${sc.label.padEnd(24)} | ${totN.toString().padStart(6)}  ${(totR >= 0 ? '+' : '') + totR.toFixed(0).padStart(5)}    ${(ev >= 0 ? '+' : '') + ev.toFixed(2)}`)
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
