/**
 * Walk-forward validation for 8 NEW PASS setups from runBacktest_new_setups.ts.
 * TRAIN = oldest 6mo, TEST = newest 6mo. Stable edge = positive R/tr in BOTH periods.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_walkforward_new.ts
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

const TOTAL_DAYS = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

type Side = 'BUY' | 'SELL' | 'BOTH'

interface RunCase { symbol: string; side: Side }

const CASES: RunCase[] = [
  { symbol: 'ATOMUSDT', side: 'SELL' },
  { symbol: 'AAVEUSDT', side: 'SELL' },
  { symbol: 'STRKUSDT', side: 'SELL' },
  { symbol: 'APEUSDT',  side: 'SELL' },
  { symbol: 'AAVEUSDT', side: 'BOTH' },
  { symbol: 'BLURUSDT', side: 'SELL' },
  { symbol: 'CRVUSDT',  side: 'SELL' },
  { symbol: 'JUPUSDT',  side: 'SELL' },
]

function buildCfg(): LevelsV2Config {
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
    tpMinAtr: 0,
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface PeriodResult {
  trades: number
  totalR: number
  rPerTrade: number
  winRate: number
  pf: number
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

function computeStats(trades: any[]): PeriodResult {
  const wins = trades.filter((t) => t.pnlR > 0)
  const losses = trades.filter((t) => t.pnlR < 0)
  const totalWinR = wins.reduce((a, t) => a + t.pnlR, 0)
  const totalLossR = Math.abs(losses.reduce((a, t) => a + t.pnlR, 0))
  const totalR = trades.reduce((a, t) => a + t.pnlR, 0)
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? Infinity : 0)
  const ev = trades.length > 0 ? totalR / trades.length : 0
  return { trades: trades.length, totalR, rPerTrade: ev, winRate, pf }
}

function runWindow(data: LoadedData, c: RunCase, tStart: number, tEnd: number): PeriodResult {
  const ltf = sliceLastDays(data.m5, TOTAL_DAYS)
  const mtf = sliceLastDays(data.m15, TOTAL_DAYS)
  const htf = sliceLastDays(data.h1, TOTAL_DAYS)
  const dly = sliceLastDays(data.d1, TOTAL_DAYS)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg()
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - TOTAL_DAYS * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    if (s.entryTime < tStart || s.entryTime > tEnd) continue
    sigByIdx.set(i, { side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason })
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0008,
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)
  return computeStats(r.trades)
}

function fmt(p: PeriodResult): string {
  if (p.trades === 0) return '   (no trades)'
  return `N=${p.trades.toString().padStart(3)} R/tr=${(p.rPerTrade >= 0 ? '+' : '') + p.rPerTrade.toFixed(2)} totR=${(p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(0)}`
}

async function main() {
  const now = Date.now()
  const sixMonthsMs = 180 * 24 * 60 * 60_000
  const totalStart = now - TOTAL_DAYS * 24 * 60 * 60_000
  const splitTime = now - sixMonthsMs

  console.log(`Walk-forward (NEW PASS setups): TRAIN [${new Date(totalStart).toISOString().slice(0, 10)} → ${new Date(splitTime).toISOString().slice(0, 10)}], TEST [${new Date(splitTime).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)}]\n`)

  interface CaseResult {
    symbol: string; side: Side
    train: PeriodResult; test: PeriodResult
    stable: boolean
  }
  const allResults: CaseResult[] = []
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.side} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`SKIP`); continue }

    const train = runWindow(data, c, totalStart, splitTime)
    const test = runWindow(data, c, splitTime, now)
    // Stable = positive R/tr in BOTH periods AND >= 5 trades each
    const stable = train.rPerTrade > 0 && test.rPerTrade > 0 && train.trades >= 5 && test.trades >= 5
    allResults.push({ symbol: c.symbol, side: c.side, train, test, stable })

    console.log(`  TRAIN: ${fmt(train)}`)
    console.log(`  TEST:  ${fmt(test)}`)
    console.log(`  ${stable ? '★ STABLE' : '⚠ unstable'}`)
  }

  console.log('\n\n========== SUMMARY ==========\n')
  console.log('Symbol         Side  | TRAIN              | TEST               | Stable?')
  console.log('-'.repeat(95))
  const stableSetups: { symbol: string; side: Side }[] = []
  for (const r of allResults) {
    const trStr = `R/tr=${(r.train.rPerTrade >= 0 ? '+' : '') + r.train.rPerTrade.toFixed(2)} N=${r.train.trades}`
    const teStr = `R/tr=${(r.test.rPerTrade >= 0 ? '+' : '') + r.test.rPerTrade.toFixed(2)} N=${r.test.trades}`
    const flag = r.stable ? '★ ADD TO PROD' : '✗ skip'
    console.log(`${r.symbol.padEnd(13)} ${r.side.padEnd(5)} | ${trStr.padEnd(18)} | ${teStr.padEnd(18)} | ${flag}`)
    if (r.stable) stableSetups.push({ symbol: r.symbol, side: r.side })
  }

  console.log('\n=== RECOMMENDED ADDITIONS TO DEFAULT_SETUPS ===')
  for (const s of stableSetups) console.log(`  ${s.symbol} ${s.side}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `walkforward_new_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults, stableSetups }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
