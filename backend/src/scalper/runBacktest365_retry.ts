/**
 * Re-run for symbols that were rate-limited in the main run.
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

const SETUPS = [
  { symbol: 'BCHUSDT', sides: ['BUY', 'SELL', 'BOTH'] as Side[] },
  { symbol: 'LTCUSDT', sides: ['BUY', 'SELL', 'BOTH'] as Side[] },
  { symbol: 'TIAUSDT', sides: ['BUY', 'SELL', 'BOTH'] as Side[] },
  { symbol: 'SEIUSDT', sides: ['BUY', 'SELL', 'BOTH'] as Side[] },
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
  }
}

function sliceLastDays<T extends { time: number }>(arr: T[], days: number, bufferDays = BUFFER_DAYS): T[] {
  const cutoff = Date.now() - (days + bufferDays) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function loadAllWithRetry(symbol: string, attempts = 3): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const m5  = await loadHistorical(symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
      await sleep(2000)
      const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
      await sleep(2000)
      const h1  = await loadHistorical(symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
      await sleep(2000)
      const d1  = await loadHistorical(symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
      if (m5.length === 0) { console.warn(`[${symbol}] no 5m`); return null }
      const span = (m5[m5.length - 1].time - m5[0].time) / (24 * 60 * 60_000)
      console.log(`[${symbol}] loaded: m5=${m5.length} span=${span.toFixed(0)}d`)
      return { m5, m15, h1, d1, spanDays: span }
    } catch (e: any) {
      console.warn(`[${symbol}] attempt ${i + 1}/${attempts} failed: ${e.message}`)
      if (i < attempts - 1) {
        console.log(`[${symbol}] sleeping 60s before retry...`)
        await sleep(60_000)
      }
    }
  }
  return null
}

function runComboBacktest(data: any, symbol: string, side: Side) {
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

  return { symbol, side, trades: r.trades.length, totalR, rPerTrade: ev, winRate, pf }
}

async function main() {
  const results: any[] = []
  for (const setup of SETUPS) {
    console.log(`\n--- ${setup.symbol} ---`)
    const data = await loadAllWithRetry(setup.symbol)
    if (!data) { console.warn(`[${setup.symbol}] FAILED after retries`); continue }
    for (const side of setup.sides) {
      const r = runComboBacktest(data, setup.symbol, side)
      console.log(`  ${setup.symbol} ${side}: trades=${r.trades} totalR=${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(1)} R/tr=${r.rPerTrade >= 0 ? '+' : ''}${r.rPerTrade.toFixed(2)} WR=${r.winRate.toFixed(0)}% PF=${r.pf === Infinity ? '∞' : r.pf.toFixed(2)}`)
      results.push(r)
    }
    // Pause between symbols to avoid rate-limit
    await new Promise((r) => setTimeout(r, 3000))
  }

  console.log('\n=== RECOMMENDATION ===')
  for (const r of results.filter((r) => r.rPerTrade > 0.3 && r.trades >= 25).sort((a, b) => b.rPerTrade - a.rPerTrade)) {
    console.log(`  ${r.symbol.padEnd(10)} ${r.side.padEnd(6)} → N=${r.trades}  R/tr=+${r.rPerTrade.toFixed(2)}  totalR=+${r.totalR.toFixed(1)}`)
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `backtest365_retry_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ results }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
