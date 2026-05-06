/**
 * 365d backtest on 20 NEW crypto candidates × 3 sides (BUY/SELL/BOTH).
 * Goal: find new positive-EV setups to add to DEFAULT_SETUPS.
 *
 * PASS criteria: R/tr ≥ 0.3 AND trades ≥ 25.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_new_setups.ts
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

// 20 NEW candidate symbols (not yet in production setups)
const NEW_SYMBOLS = [
  'OPUSDT',     // Optimism L2
  'ATOMUSDT',   // Cosmos
  'FILUSDT',    // Filecoin
  'INJUSDT',    // Injective
  'ICPUSDT',    // Internet Computer
  'AAVEUSDT',   // Aave DeFi
  'UNIUSDT',    // Uniswap
  'MKRUSDT',    // MakerDAO
  'CRVUSDT',    // Curve
  'GMXUSDT',    // GMX perp DEX
  'AXSUSDT',    // Axie Infinity
  'APEUSDT',    // ApeCoin
  'PYTHUSDT',   // Pyth oracle
  'JUPUSDT',    // Jupiter (Solana)
  'WLDUSDT',    // Worldcoin
  'STRKUSDT',   // Starknet
  'BLURUSDT',   // Blur NFT
  'FETUSDT',    // Fetch.ai
  'RNDRUSDT',   // Render Network
  'TAOUSDT',    // Bittensor
]

const SIDES: Side[] = ['BUY', 'SELL', 'BOTH']

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
    tpMinAtr: 0,  // baseline; will sweep later for PASS setups
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface Result {
  symbol: string
  side: Side
  trades: number
  totalR: number
  rPerTrade: number
  winRate: number
  pf: number
  longTrades: number
  shortTrades: number
  pass: boolean
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5  = await loadHistorical(symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
    if (m5.length < 1000) {
      console.warn(`[${symbol}] only ${m5.length} 5m candles — skip`)
      return null
    }
    // Bybit pause to avoid rate-limit
    await new Promise(r => setTimeout(r, 1500))
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    await new Promise(r => setTimeout(r, 1500))
    const h1  = await loadHistorical(symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
    await new Promise(r => setTimeout(r, 1500))
    const d1  = await loadHistorical(symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch (e: any) {
    console.warn(`[${symbol}] load failed: ${e.message}`)
    return null
  }
}

function runOne(data: LoadedData, symbol: string, side: Side): Result {
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
  const longTrades = r.trades.filter(t => t.side === 'BUY').length
  const shortTrades = r.trades.filter(t => t.side === 'SELL').length

  const pass = ev >= 0.3 && r.trades.length >= 25

  return {
    symbol, side,
    trades: r.trades.length, totalR, rPerTrade: ev, winRate, pf,
    longTrades, shortTrades, pass,
  }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

async function main() {
  console.log(`365d backtest: ${NEW_SYMBOLS.length} new symbols × 3 sides = ${NEW_SYMBOLS.length * 3} combos`)
  console.log(`PASS criteria: R/tr ≥ 0.3 AND trades ≥ 25\n`)

  const allResults: Result[] = []
  for (const sym of NEW_SYMBOLS) {
    console.log(`\n=== ${sym} ===`)
    const data = await loadAll(sym)
    if (!data) { console.warn(`SKIP`); continue }

    console.log('side    trades  totalR    R/tr    WR    PF    L/S')
    console.log('-'.repeat(60))
    for (const side of SIDES) {
      const r = runOne(data, sym, side)
      allResults.push(r)
      const totalRStr = (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)
      const evStr = (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)
      const flag = r.pass ? ' ★' : ''
      console.log(
        `${side.padEnd(7)} ${r.trades.toString().padStart(6)}  ${totalRStr.padStart(7)}  ${evStr.padStart(6)}  ${r.winRate.toFixed(0).padStart(3)}%  ${fmtPF(r.pf).padStart(6)}  ${r.longTrades}/${r.shortTrades}${flag}`
      )
    }
  }

  console.log('\n\n========== PASS SUMMARY (R/tr ≥ 0.3, trades ≥ 25) ==========\n')
  const passed = allResults.filter(r => r.pass).sort((a, b) => b.rPerTrade - a.rPerTrade)
  if (passed.length === 0) {
    console.log('No setups passed criteria.')
  } else {
    console.log(`${passed.length} setups passed:\n`)
    console.log('Symbol            Side  | trades  totalR    R/tr    WR    PF')
    console.log('-'.repeat(75))
    for (const r of passed) {
      const totalRStr = (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)
      const evStr = (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)
      console.log(`${r.symbol.padEnd(15)} ${r.side.padEnd(5)} | ${r.trades.toString().padStart(6)}  ${totalRStr.padStart(7)}  ${evStr.padStart(6)}  ${r.winRate.toFixed(0).padStart(3)}%  ${fmtPF(r.pf).padStart(6)}`)
    }
  }

  console.log('\n\n========== ALL RESULTS (sorted by R/tr) ==========\n')
  const sorted = [...allResults].sort((a, b) => b.rPerTrade - a.rPerTrade)
  for (const r of sorted) {
    if (r.trades === 0) continue
    const totalRStr = (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)
    const evStr = (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)
    const flag = r.pass ? ' ★' : (r.rPerTrade >= 0.3 && r.trades < 25 ? ' (low n)' : '')
    console.log(`${r.symbol.padEnd(15)} ${r.side.padEnd(5)}: N=${r.trades.toString().padStart(3)} totR=${totalRStr.padStart(7)} R/tr=${evStr.padStart(6)} WR=${r.winRate.toFixed(0)}% PF=${fmtPF(r.pf).padStart(5)}${flag}`)
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `new_setups_365d_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults, passed }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
