/**
 * 365-day backtest of the V2 levels strategy on ETHUSDT, SOLUSDT, XAGUSD
 * across LONG (BUY), SHORT (SELL), and BOTH directions.
 *
 * Uses the SAME buildCfg() as production (levelsLiveScanner.ts:48-61) so
 * results are directly comparable to what the live scanner would produce.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest365.ts
 *
 * Required env: TWELVE_DATA_API_KEY (for XAGUSD only).
 *
 * Notes on data:
 *   - Crypto cache may not extend 365d backwards. If the cached range is
 *     shorter than required, the script proceeds with what's available and
 *     reports the actual span used.
 *   - XAGUSD is fetched fresh from Twelve Data (~5–10 min: 5m+15m+1h+1d).
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadForexHistorical } from './forexLoader'
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
// 14 months covers 365d + 60d buffer with a little slack.
const MONTHS_BACK = 14

type Side = 'BUY' | 'SELL' | 'BOTH'

interface SetupConfig {
  symbol: string
  market: 'FOREX' | 'CRYPTO'
  sides: Side[]
}

const SETUPS: SetupConfig[] = [
  { symbol: 'ETHUSDT', market: 'CRYPTO', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'SOLUSDT', market: 'CRYPTO', sides: ['BUY', 'SELL', 'BOTH'] },
  { symbol: 'XAGUSD',  market: 'FOREX',  sides: ['BUY', 'SELL', 'BOTH'] },
]

// === Same as levelsLiveScanner.ts:48-61 (production config) ===
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
    const m5  = await (setup.market === 'FOREX'
      ? loadForexHistorical(setup.symbol, '5m',  MONTHS_BACK)
      : loadHistorical(setup.symbol, '5m',  MONTHS_BACK, 'bybit', 'linear'))
    const m15 = await (setup.market === 'FOREX'
      ? loadForexHistorical(setup.symbol, '15m', MONTHS_BACK)
      : loadHistorical(setup.symbol, '15m', MONTHS_BACK, 'bybit', 'linear'))
    const h1  = await (setup.market === 'FOREX'
      ? loadForexHistorical(setup.symbol, '1h',  MONTHS_BACK)
      : loadHistorical(setup.symbol, '1h',  MONTHS_BACK, 'bybit', 'linear'))
    const d1  = await (setup.market === 'FOREX'
      ? loadForexHistorical(setup.symbol, '1d',  MONTHS_BACK)
      : loadHistorical(setup.symbol, '1d',  MONTHS_BACK, 'bybit', 'linear'))

    if (m5.length === 0) {
      console.warn(`[${setup.symbol}] no 5m data available`)
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

function runComboBacktest(
  data: LoadedData,
  setup: SetupConfig,
  side: Side,
): ComboResult {
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
    feesRoundTrip: setup.market === 'FOREX' ? 0.0004 : 0.0008,
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
    symbol: setup.symbol,
    side,
    trades: r.trades.length,
    totalR,
    rPerTrade: ev,
    winRate,
    profitFactor: pf,
    avgWin,
    avgLoss,
    spanDays: data.spanDays,
  }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

function printTable(results: ComboResult[]) {
  console.log('\n' + '='.repeat(110))
  console.log(`365-DAY BACKTEST RESULTS — V2 Levels Strategy`)
  console.log('='.repeat(110))
  console.log(
    'Symbol  '.padEnd(10) +
    'Side'.padEnd(6) +
    'Trades'.padStart(7) +
    'TotalR'.padStart(10) +
    'R/trade'.padStart(10) +
    'WinRate'.padStart(10) +
    'PF'.padStart(8) +
    'AvgWin'.padStart(9) +
    'AvgLoss'.padStart(9) +
    'Span(d)'.padStart(9)
  )
  console.log('-'.repeat(110))
  for (const r of results) {
    console.log(
      r.symbol.padEnd(10) +
      r.side.padEnd(6) +
      r.trades.toString().padStart(7) +
      (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1).padStart(r.totalR >= 0 ? 9 : 10) +
      (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2).padStart(r.rPerTrade >= 0 ? 9 : 10) +
      r.winRate.toFixed(1).padStart(9) + '%' +
      fmtPF(r.profitFactor).padStart(8) +
      ('+' + r.avgWin.toFixed(2)).padStart(9) +
      r.avgLoss.toFixed(2).padStart(9) +
      r.spanDays.toFixed(0).padStart(9)
    )
  }
  console.log('='.repeat(110))
}

function recommendation(results: ComboResult[]) {
  console.log('\n=== RECOMMENDATION (threshold: R/trade > 0.3 AND trades >= 25) ===')
  const passes = results.filter((r) => r.rPerTrade > 0.3 && r.trades >= 25)
  if (passes.length === 0) {
    console.log('No combo passes the threshold.')
  } else {
    console.log('PASS:')
    for (const r of passes) {
      console.log(`  ${r.symbol} ${r.side}  →  N=${r.trades}  R/trade=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}  PF=${fmtPF(r.profitFactor)}`)
    }
  }
  console.log('\nNear-miss (R/trade > 0 OR trades >= 25, but not both):')
  const near = results.filter((r) => !passes.includes(r) && (r.rPerTrade > 0 || r.trades >= 25))
  for (const r of near) {
    console.log(`  ${r.symbol} ${r.side}  →  N=${r.trades}  R/trade=${r.rPerTrade >= 0 ? '+' : ''}${r.rPerTrade.toFixed(2)}  totalR=${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)}`)
  }
}

async function main() {
  console.log(`Starting 365-day backtest. Cutoff = ${new Date(Date.now() - DAYS_BACK * 24 * 60 * 60_000).toISOString().slice(0, 10)}`)
  console.log(`Symbols: ${SETUPS.map((s) => s.symbol).join(', ')}`)
  console.log(`TWELVE_DATA_API_KEY: ${process.env.TWELVE_DATA_API_KEY ? 'present' : 'MISSING (XAGUSD will fail)'}`)
  console.log('')

  const results: ComboResult[] = []
  for (const setup of SETUPS) {
    console.log(`\n--- Loading ${setup.symbol} (${setup.market}) ---`)
    const data = await loadAll(setup)
    if (!data) {
      console.warn(`[${setup.symbol}] SKIPPED — data unavailable`)
      continue
    }
    if (data.spanDays < DAYS_BACK * 0.5) {
      console.warn(`[${setup.symbol}] WARNING: only ${data.spanDays.toFixed(0)}d available, requested ${DAYS_BACK}d`)
    }
    for (const side of setup.sides) {
      const r = runComboBacktest(data, setup, side)
      console.log(`  ${setup.symbol} ${side}: trades=${r.trades} totalR=${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)} R/tr=${r.rPerTrade >= 0 ? '+' : ''}${r.rPerTrade.toFixed(2)} WR=${r.winRate.toFixed(0)}% PF=${fmtPF(r.profitFactor)}`)
      results.push(r)
    }
  }

  printTable(results)
  recommendation(results)

  // Persist a JSON for later inspection
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `backtest365_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), daysBack: DAYS_BACK, results }, null, 2))
  console.log(`\nSaved detailed results to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
