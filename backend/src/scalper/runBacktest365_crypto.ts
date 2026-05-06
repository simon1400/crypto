/**
 * 365-day backtest of V2 levels strategy on 8 major crypto altcoins.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest365_crypto.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
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

interface SetupConfig {
  symbol: string
  sides: Side[]
}

const SETUPS: SetupConfig[] = [
  { symbol: 'BNBUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'XRPUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'DOGEUSDT', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'AVAXUSDT', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'LINKUSDT', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'ADAUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'DOTUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'ARBUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
  // Hype/meme — короткая история, может быть мало trades
  { symbol: 'TRUMPUSDT', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'WIFUSDT',   sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'PEPEUSDT',  sides: ['BUY', 'SELL', 'BOTH'] },
]

// Same as production buildCfg for CRYPTO market
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
  }
}

function sliceLastDays<T extends { time: number }>(arr: T[], days: number, bufferDays = BUFFER_DAYS): T[] {
  const cutoff = Date.now() - (days + bufferDays) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface ComboResult {
  symbol: string
  side: Side
  trades: number
  totalR: number
  rPerTrade: number
  winRate: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  spanDays: number
}

interface LoadedData {
  m5: any[]
  m15: any[]
  h1: any[]
  d1: any[]
  spanDays: number
}

async function loadAll(setup: SetupConfig): Promise<LoadedData | null> {
  try {
    const m5  = await loadHistorical(setup.symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(setup.symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1  = await loadHistorical(setup.symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
    const d1  = await loadHistorical(setup.symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
    if (m5.length === 0) {
      console.warn(`[${setup.symbol}] no 5m data`)
      return null
    }
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
    sigByIdx.set(i, {
      side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
    })
  }

  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick',
    splits: [0.5, 0.3, 0.2],
    trailing: true,
    feesRoundTrip: 0.0008,
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)

  const wins = r.trades.filter((t) => t.pnlR > 0)
  const losses = r.trades.filter((t) => t.pnlR < 0)
  const totalWinR = wins.reduce((a, t) => a + t.pnlR, 0)
  const totalLossR = Math.abs(losses.reduce((a, t) => a + t.pnlR, 0))
  const totalR = r.trades.reduce((a, t) => a + t.pnlR, 0)
  const winRate = r.trades.length > 0 ? (wins.length / r.trades.length) * 100 : 0
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? Infinity : 0)
  const avgWin = wins.length > 0 ? totalWinR / wins.length : 0
  const avgLoss = losses.length > 0 ? -totalLossR / losses.length : 0
  const ev = r.trades.length > 0 ? totalR / r.trades.length : 0

  return {
    symbol: setup.symbol, side, trades: r.trades.length,
    totalR, rPerTrade: ev, winRate, profitFactor: pf,
    avgWin, avgLoss, spanDays: data.spanDays,
  }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

function printTable(results: ComboResult[]) {
  console.log('\n' + '='.repeat(110))
  console.log('365-DAY CRYPTO BACKTEST RESULTS — V2 Levels Strategy')
  console.log('='.repeat(110))
  console.log(
    'Symbol  '.padEnd(12) +
    'Side'.padEnd(6) +
    'Trades'.padStart(7) +
    'TotalR'.padStart(10) +
    'R/trade'.padStart(10) +
    'WinRate'.padStart(10) +
    'PF'.padStart(8) +
    'Span(d)'.padStart(9)
  )
  console.log('-'.repeat(110))
  for (const r of results) {
    console.log(
      r.symbol.padEnd(12) +
      r.side.padEnd(6) +
      r.trades.toString().padStart(7) +
      ((r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)).padStart(10) +
      ((r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)).padStart(10) +
      (r.winRate.toFixed(1) + '%').padStart(10) +
      fmtPF(r.profitFactor).padStart(8) +
      r.spanDays.toFixed(0).padStart(9)
    )
  }
  console.log('='.repeat(110))
}

function recommendation(results: ComboResult[]) {
  console.log('\n=== RECOMMENDATION (R/trade > 0.3 AND trades >= 25) ===')
  const passes = results.filter((r) => r.rPerTrade > 0.3 && r.trades >= 25)
  if (passes.length === 0) {
    console.log('No combo passes the threshold.')
  } else {
    console.log('PASS:')
    for (const r of passes.sort((a, b) => b.rPerTrade - a.rPerTrade)) {
      console.log(`  ${r.symbol.padEnd(12)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}  PF=${fmtPF(r.profitFactor)}  WR=${r.winRate.toFixed(0)}%`)
    }
  }
  console.log('\nNear-miss:')
  const near = results.filter((r) => !passes.includes(r) && r.rPerTrade > 0 && r.trades >= 25)
  for (const r of near.sort((a, b) => b.rPerTrade - a.rPerTrade)) {
    console.log(`  ${r.symbol.padEnd(12)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}`)
  }
  console.log('\nLosers:')
  const losers = results.filter((r) => r.rPerTrade <= 0 && r.trades >= 25)
  for (const r of losers.sort((a, b) => a.rPerTrade - b.rPerTrade).slice(0, 5)) {
    console.log(`  ${r.symbol.padEnd(12)} ${r.side.padEnd(6)} → N=${r.trades}  R/trade=${r.rPerTrade.toFixed(2)}  totalR=${r.totalR.toFixed(1)}`)
  }
}

async function main() {
  console.log(`Starting 365-day crypto backtest. Cutoff = ${new Date(Date.now() - DAYS_BACK * 24 * 60 * 60_000).toISOString().slice(0, 10)}`)
  console.log(`Symbols: ${SETUPS.map((s) => s.symbol).join(', ')}\n`)

  const results: ComboResult[] = []
  for (const setup of SETUPS) {
    console.log(`\n--- ${setup.symbol} ---`)
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

  printTable(results)
  recommendation(results)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `backtest365_crypto_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), daysBack: DAYS_BACK, results }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
