/**
 * tpMinAtr sweep for the 4 NEW stable PASS setups (post-walkforward).
 * Tests tpMinAtr ∈ {0, 0.5, 1.0, 1.5, 2.0} to find best per-setup TP filter.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_tpMinAtr_sweep_new.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
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
interface RunCase { symbol: string; side: Side }

const CASES: RunCase[] = [
  { symbol: 'AAVEUSDT', side: 'SELL' },
  { symbol: 'STRKUSDT', side: 'SELL' },
  { symbol: 'BLURUSDT', side: 'SELL' },
  { symbol: 'CRVUSDT',  side: 'SELL' },
]

const TP_MIN_ATR_VALUES = [0, 0.5, 1.0, 1.5, 2.0]

function buildCfg(tpMinAtr: number): LevelsV2Config {
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
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface Result {
  symbol: string; side: Side; tpMinAtr: number
  trades: number; totalR: number; rPerTrade: number; winRate: number; pf: number
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5  = await loadHistorical(symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1  = await loadHistorical(symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
    const d1  = await loadHistorical(symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch (e: any) {
    console.warn(`[${symbol}] load failed: ${e.message}`)
    return null
  }
}

function runOne(data: LoadedData, c: RunCase, tpMinAtr: number): Result {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(tpMinAtr)
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
  const wins = r.trades.filter((t) => t.pnlR > 0)
  const losses = r.trades.filter((t) => t.pnlR < 0)
  const totalWinR = wins.reduce((a, t) => a + t.pnlR, 0)
  const totalLossR = Math.abs(losses.reduce((a, t) => a + t.pnlR, 0))
  const totalR = r.trades.reduce((a, t) => a + t.pnlR, 0)
  const winRate = r.trades.length > 0 ? (wins.length / r.trades.length) * 100 : 0
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? Infinity : 0)
  const ev = r.trades.length > 0 ? totalR / r.trades.length : 0
  return {
    symbol: c.symbol, side: c.side, tpMinAtr,
    trades: r.trades.length, totalR, rPerTrade: ev, winRate, pf,
  }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

async function main() {
  console.log(`Sweep tpMinAtr ∈ {${TP_MIN_ATR_VALUES.join(', ')}} on ${CASES.length} new stable setups\n`)
  const allResults: Result[] = []
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.side} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`SKIP`); continue }

    console.log('tpMinAtr  trades  totalR   R/tr   WR    PF')
    console.log('-'.repeat(50))
    for (const tpMin of TP_MIN_ATR_VALUES) {
      const r = runOne(data, c, tpMin)
      allResults.push(r)
      const totalRStr = (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)
      const evStr = (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)
      console.log(
        `${tpMin.toFixed(1).padStart(7)}  ${r.trades.toString().padStart(6)}  ${totalRStr.padStart(6)}  ${evStr.padStart(5)}  ${r.winRate.toFixed(0).padStart(3)}%  ${fmtPF(r.pf).padStart(5)}`
      )
    }
  }

  console.log('\n\n========== BEST tpMinAtr per setup ==========\n')
  console.log('Symbol         Side  | best tpMinAtr | R/tr (vs baseline R/tr=0)')
  console.log('-'.repeat(75))
  const bestPerCase: { symbol: string; side: Side; bestTpMinAtr: number; rPerTrade: number; trades: number }[] = []
  for (const c of CASES) {
    const my = allResults.filter(r => r.symbol === c.symbol && r.side === c.side)
    if (my.length === 0) continue
    // Best by total R (not R/tr — to penalize over-pruning)
    const best = my.reduce((a, b) => b.totalR > a.totalR ? b : a)
    const baseline = my.find(r => r.tpMinAtr === 0)!
    const dStr = `${(best.rPerTrade >= 0 ? '+' : '') + best.rPerTrade.toFixed(2)} (Δ ${best.rPerTrade > baseline.rPerTrade ? '+' : ''}${(best.rPerTrade - baseline.rPerTrade).toFixed(2)})`
    bestPerCase.push({ symbol: c.symbol, side: c.side, bestTpMinAtr: best.tpMinAtr, rPerTrade: best.rPerTrade, trades: best.trades })
    console.log(`${c.symbol.padEnd(13)} ${c.side.padEnd(5)} | ${best.tpMinAtr.toFixed(1).padStart(13)} | ${dStr}, N=${best.trades}, totalR=${best.totalR.toFixed(0)}`)
  }

  console.log('\n=== FINAL ADDITIONS WITH OPTIMAL tpMinAtr ===')
  for (const b of bestPerCase) {
    const tpStr = b.bestTpMinAtr === 0 ? '(baseline)' : `tpMinAtr=${b.bestTpMinAtr}`
    console.log(`  ${b.symbol.padEnd(13)} ${b.side.padEnd(5)} ${tpStr}`)
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `tpsweep_new_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults, bestPerCase }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
