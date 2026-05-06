/**
 * 365-day backtest of V2 levels strategy on US ETFs via Polygon free plan:
 * SPY (S&P 500 proxy), QQQ (Nasdaq 100 proxy), USO (WTI oil proxy).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest365_polygon.ts
 *
 * Note: ETFs only trade during market hours so candle counts are ~50k/year for 5m
 * (vs ~105k for 24/7 crypto). Statistical sample is smaller.
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadPolygonHistorical } from './polygonLoader'
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

interface SetupConfig {
  symbol: string
  label: string
  sides: Side[]
  feesRoundTrip: number  // ETFs have tiny fees; we use 0.02% as a typical retail spread
}

const SETUPS: SetupConfig[] = [
  { symbol: 'SPY', label: 'S&P 500 ETF',     sides: ['BUY', 'SELL', 'BOTH'], feesRoundTrip: 0.0002 },
  { symbol: 'QQQ', label: 'Nasdaq 100 ETF',  sides: ['BUY', 'SELL', 'BOTH'], feesRoundTrip: 0.0002 },
  { symbol: 'USO', label: 'WTI Crude Oil ETF', sides: ['BUY', 'SELL', 'BOTH'], feesRoundTrip: 0.0004 },
]

// Use the same loosened FOREX-ish config — ETFs have similar volatility characteristics
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
    fiboZoneFrom: 0.382, fiboZoneTo: 0.786,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 3.5,
  }
}

function sliceLastDays(arr: OHLCV[], days: number, bufferDays = BUFFER_DAYS): OHLCV[] {
  const cutoff = Date.now() - (days + bufferDays) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface ComboResult {
  symbol: string; side: Side; trades: number; totalR: number; rPerTrade: number;
  winRate: number; profitFactor: number; avgWin: number; avgLoss: number; spanDays: number;
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[]; spanDays: number }

async function loadAll(setup: SetupConfig): Promise<LoadedData | null> {
  try {
    const m5  = await loadPolygonHistorical(setup.symbol, '5m',  MONTHS_BACK)
    const m15 = await loadPolygonHistorical(setup.symbol, '15m', MONTHS_BACK)
    const h1  = await loadPolygonHistorical(setup.symbol, '1h',  MONTHS_BACK)
    const d1  = await loadPolygonHistorical(setup.symbol, '1d',  MONTHS_BACK)
    if (m5.length === 0) { console.warn(`[${setup.symbol}] no 5m data`); return null }
    const span = (m5[m5.length - 1].time - m5[0].time) / (24 * 60 * 60_000)
    console.log(`[${setup.symbol}] loaded: m5=${m5.length} m15=${m15.length} h1=${h1.length} d1=${d1.length} span=${span.toFixed(0)}d`)
    return { m5, m15, h1, d1, spanDays: span }
  } catch (e: any) {
    console.warn(`[${setup.symbol}] load failed: ${e.message}`)
    return null
  }
}

function runComboBacktest(data: LoadedData, setup: SetupConfig, side: Side): ComboResult {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg()
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (side !== 'BOTH' && s.side !== side) continue
    sigByIdx.set(i, { side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason })
  }

  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: setup.feesRoundTrip,
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

  return { symbol: setup.symbol, side, trades: r.trades.length,
    totalR, rPerTrade: ev, winRate, profitFactor: pf,
    avgWin: wins.length > 0 ? totalWinR / wins.length : 0,
    avgLoss: losses.length > 0 ? -totalLossR / losses.length : 0,
    spanDays: data.spanDays }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

function recommendation(results: ComboResult[]) {
  console.log('\n=== POLYGON RECOMMENDATION (R/trade > 0.3 AND trades >= 25) ===')
  const passes = results.filter((r) => r.rPerTrade > 0.3 && r.trades >= 25)
  if (passes.length === 0) console.log('No combo passes threshold.')
  else {
    console.log('PASS:')
    for (const r of passes.sort((a, b) => b.rPerTrade - a.rPerTrade)) {
      console.log(`  ${r.symbol.padEnd(8)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}  PF=${fmtPF(r.profitFactor)}  WR=${r.winRate.toFixed(0)}%`)
    }
  }
  console.log('\nNear-miss (R/trade > 0):')
  const near = results.filter((r) => !passes.includes(r) && r.rPerTrade > 0 && r.trades >= 25)
  for (const r of near.sort((a, b) => b.rPerTrade - a.rPerTrade)) {
    console.log(`  ${r.symbol.padEnd(8)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}`)
  }
  console.log('\nLosers:')
  const losers = results.filter((r) => r.rPerTrade <= 0 && r.trades >= 25)
  for (const r of losers.sort((a, b) => a.rPerTrade - b.rPerTrade)) {
    console.log(`  ${r.symbol.padEnd(8)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=${r.rPerTrade.toFixed(2)}  totalR=${r.totalR.toFixed(1)}`)
  }
}

async function main() {
  console.log(`Polygon backtest: ${SETUPS.length} ETFs × 3 sides = ${SETUPS.length * 3} combos`)
  console.log(`POLYGON_API_KEY: ${process.env.POLYGON_API_KEY ? 'present' : 'MISSING'}`)
  console.log(`Cutoff = ${new Date(Date.now() - DAYS_BACK * 24 * 60 * 60_000).toISOString().slice(0, 10)}`)

  const results: ComboResult[] = []
  for (const setup of SETUPS) {
    console.log(`\n--- ${setup.symbol} (${setup.label}) ---`)
    const data = await loadAll(setup)
    if (!data) { console.warn(`[${setup.symbol}] SKIPPED`); continue }
    if (data.spanDays < DAYS_BACK * 0.5) {
      console.warn(`[${setup.symbol}] WARNING: only ${data.spanDays.toFixed(0)}d available`)
    }
    for (const side of setup.sides) {
      const r = runComboBacktest(data, setup, side)
      console.log(`  ${setup.symbol} ${side}: trades=${r.trades} totalR=${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)} R/tr=${r.rPerTrade >= 0 ? '+' : ''}${r.rPerTrade.toFixed(2)} WR=${r.winRate.toFixed(0)}% PF=${fmtPF(r.profitFactor)}`)
      results.push(r)
    }
  }

  recommendation(results)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `backtest365_polygon_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), daysBack: DAYS_BACK, results }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
