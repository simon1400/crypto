/**
 * Sweep backtest for tpMinAtr parameter on BTC and HYPE.
 * Tests different values of tpMinAtr to see how skipping near-entry TPs affects edge.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_tpMinAtr_sweep.ts
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

interface RunCase {
  symbol: string
  side: Side
}

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT', side: 'BOTH' },
  { symbol: 'XRPUSDT', side: 'SELL' },
  { symbol: 'SEIUSDT', side: 'SELL' },
  { symbol: 'WIFUSDT', side: 'SELL' },
  { symbol: 'SOLUSDT', side: 'SELL' },
  { symbol: 'ARBUSDT', side: 'SELL' },
  { symbol: 'AVAXUSDT', side: 'SELL' },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT', side: 'SELL' },
  { symbol: 'HYPEUSDT', side: 'BUY' },
  { symbol: 'ENAUSDT', side: 'BOTH' },
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
  symbol: string
  side: Side
  tpMinAtr: number
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
  console.log(`Sweep backtest: tpMinAtr ∈ {${TP_MIN_ATR_VALUES.join(', ')}}`)
  console.log(`Cases: ${CASES.map(c => `${c.symbol} ${c.side}`).join(', ')}\n`)

  const allResults: Result[] = []
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.side} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`SKIP`); continue }

    console.log('tpMinAtr  trades  totalR   R/tr   WR      PF')
    console.log('-'.repeat(50))
    for (const tpMin of TP_MIN_ATR_VALUES) {
      const r = runOne(data, c, tpMin)
      allResults.push(r)
      console.log(
        `${tpMin.toFixed(1).padStart(7)}  ${r.trades.toString().padStart(6)}  ${(r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1).padStart(6)}  ${(r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)}  ${r.winRate.toFixed(0).padStart(3)}%  ${fmtPF(r.pf).padStart(6)}`
      )
    }
  }

  console.log('\n=== SUMMARY ===')
  for (const c of CASES) {
    console.log(`\n${c.symbol} ${c.side}:`)
    const my = allResults.filter(r => r.symbol === c.symbol)
    const baseline = my.find(r => r.tpMinAtr === 0)
    for (const r of my) {
      const delta = baseline ? `(${r.rPerTrade > baseline.rPerTrade ? '+' : ''}${(r.rPerTrade - baseline.rPerTrade).toFixed(2)} vs baseline)` : ''
      const flag = r.tpMinAtr === 0 ? ' [baseline]' : ''
      console.log(`  tpMinAtr=${r.tpMinAtr.toFixed(1)}: N=${r.trades}, R/tr=${r.rPerTrade >= 0 ? '+' : ''}${r.rPerTrade.toFixed(2)}, totalR=${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)}, PF=${fmtPF(r.pf)}, WR=${r.winRate.toFixed(0)}% ${delta}${flag}`)
    }
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `sweep_tpMinAtr_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
