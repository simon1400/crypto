/**
 * Diagnostics — figure out WHERE the strategy bleeds money on the recent 90d window.
 * Breaks down trades by:
 *   - exit reason (SL initial, BE-SL after TP1, trailing after TP2, full TP3, EOD)
 *   - by symbol
 *   - by event type (REACTION vs BREAKOUT_RETEST)
 *   - by Fibo confluence (always true here, but split anyway)
 *   - by time of day / session
 */

import 'dotenv/config'
import { loadForexHistorical } from './forexLoader'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const DAYS_BACK = 90

interface SetupConfig { symbol: string; market: 'FOREX' | 'CRYPTO'; side: 'BUY' | 'SELL' | 'BOTH' }
const SETUPS: SetupConfig[] = [
  { symbol: 'XAUUSD',  market: 'FOREX',  side: 'BUY' },
  { symbol: 'EURUSD',  market: 'FOREX',  side: 'BUY' },
  { symbol: 'GBPUSD',  market: 'FOREX',  side: 'BUY' },
  { symbol: 'BTCUSDT', market: 'CRYPTO', side: 'BOTH' },
  { symbol: 'ETHUSDT', market: 'CRYPTO', side: 'SELL' },
  { symbol: 'SOLUSDT', market: 'CRYPTO', side: 'SELL' },
]

function sliceLastDays<T extends { time: number }>(arr: T[], days: number, bufferDays = 60): T[] {
  const cutoff = Date.now() - (days + bufferDays) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

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

interface ExtTrade {
  symbol: string
  market: 'FOREX' | 'CRYPTO'
  entryTime: number
  side: 'BUY' | 'SELL'
  pnlR: number
  exitReason: string
  fillsCount: number  // how many TPs hit before SL
  reachedTp1: boolean
  fullLadder: boolean
  source: string
  event: string
  hourUTC: number
}

async function collectTrades(): Promise<ExtTrade[]> {
  const all: ExtTrade[] = []
  for (const setup of SETUPS) {
    try {
      const m5  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '5m', 4) : loadHistorical(setup.symbol, '5m', 4, 'bybit', 'linear'))
      const m15 = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '15m', 4) : loadHistorical(setup.symbol, '15m', 4, 'bybit', 'linear'))
      const h1  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '1h', 4) : loadHistorical(setup.symbol, '1h', 4, 'bybit', 'linear'))
      const d1  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '1d', 4) : loadHistorical(setup.symbol, '1d', 4, 'bybit', 'linear'))
      const ltf = sliceLastDays(m5, DAYS_BACK, 60)
      const mtf = sliceLastDays(m15, DAYS_BACK, 60)
      const htf = sliceLastDays(h1, DAYS_BACK, 60)
      const dly = sliceLastDays(d1, DAYS_BACK, 60)
      const w1 = aggregateDailyToWeekly(dly)
      const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
      const cfg = buildCfg()
      const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
      const sigByIdx = new Map<number, LadderSignal & { source: string; event: string }>()
      const state = newSignalState()
      for (let i = 0; i < ltf.length; i++) {
        if (ltf[i].time < cutoff) continue
        const s = generateSignalV2(ltf, i, cfg, pre, state)
        if (!s) continue
        if (setup.side !== 'BOTH' && s.side !== setup.side) continue
        sigByIdx.set(i, {
          side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
          sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
          source: s.source, event: s.event,
        })
      }
      const ladderCfg: LadderConfig = {
        ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2], trailing: true,
        feesRoundTrip: setup.market === 'FOREX' ? 0.0004 : 0.0008,
      }
      const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)
      for (const t of r.trades) {
        // Find original signal by entryTime
        const matchedSig = [...sigByIdx.values()].find((s) => s.entryTime === t.entryTime)
        const fillsCount = t.fills.filter((f) => f.idx >= 0).length
        all.push({
          symbol: setup.symbol,
          market: setup.market,
          entryTime: t.entryTime,
          side: t.side,
          pnlR: t.pnlR,
          exitReason: t.exitReason,
          fillsCount,
          reachedTp1: fillsCount >= 1,
          fullLadder: fillsCount >= t.ladderLength && t.ladderLength > 0,
          source: matchedSig?.source ?? '?',
          event: matchedSig?.event ?? '?',
          hourUTC: new Date(t.entryTime).getUTCHours(),
        })
      }
      console.log(`${setup.symbol}: ${r.trades.length} trades`)
    } catch (e: any) {
      console.warn(`${setup.symbol} failed: ${e.message}`)
    }
  }
  return all
}

function describe(label: string, trades: ExtTrade[]) {
  if (trades.length === 0) { console.log(`${label}: 0 trades`); return }
  const totalR = trades.reduce((a, t) => a + t.pnlR, 0)
  const wins = trades.filter((t) => t.pnlR > 0).length
  const losses = trades.filter((t) => t.pnlR < 0).length
  const ev = totalR / trades.length
  const wr = (wins / trades.length) * 100
  console.log(`${label.padEnd(45)} N=${trades.length.toString().padStart(4)} | EV ${ev >= 0 ? '+' : ''}${ev.toFixed(2)}R | WR ${wr.toFixed(0)}% | total ${totalR >= 0 ? '+' : ''}${totalR.toFixed(0)}R`)
}

async function main() {
  const trades = await collectTrades()
  console.log(`\nTotal: ${trades.length} trades\n`)

  console.log('=== BY EXIT REASON ===')
  const byExit: Record<string, ExtTrade[]> = {}
  for (const t of trades) {
    const k = `${t.exitReason} (fills=${t.fillsCount})`
    byExit[k] = byExit[k] ?? []
    byExit[k].push(t)
  }
  for (const [k, ts] of Object.entries(byExit).sort((a, b) => b[1].length - a[1].length)) describe(k, ts)

  console.log('\n=== BY SYMBOL ===')
  const bySym: Record<string, ExtTrade[]> = {}
  for (const t of trades) { bySym[t.symbol] = bySym[t.symbol] ?? []; bySym[t.symbol].push(t) }
  for (const [k, ts] of Object.entries(bySym)) describe(k, ts)

  console.log('\n=== BY EVENT TYPE ===')
  const byEv: Record<string, ExtTrade[]> = {}
  for (const t of trades) { byEv[t.event] = byEv[t.event] ?? []; byEv[t.event].push(t) }
  for (const [k, ts] of Object.entries(byEv)) describe(k, ts)

  console.log('\n=== BY LEVEL SOURCE ===')
  const bySrc: Record<string, ExtTrade[]> = {}
  for (const t of trades) { bySrc[t.source] = bySrc[t.source] ?? []; bySrc[t.source].push(t) }
  for (const [k, ts] of Object.entries(bySrc).sort((a, b) => b[1].length - a[1].length)) describe(k, ts)

  console.log('\n=== BY HOUR UTC (top 5 best/worst) ===')
  const byHour: Record<number, ExtTrade[]> = {}
  for (const t of trades) { byHour[t.hourUTC] = byHour[t.hourUTC] ?? []; byHour[t.hourUTC].push(t) }
  const hourEntries = Object.entries(byHour).map(([h, ts]) => ({ h: parseInt(h), n: ts.length, ev: ts.reduce((a, t) => a + t.pnlR, 0) / ts.length, total: ts.reduce((a, t) => a + t.pnlR, 0) }))
  console.log('Best hours by EV:')
  for (const x of [...hourEntries].sort((a, b) => b.ev - a.ev).slice(0, 5)) {
    console.log(`  ${x.h.toString().padStart(2)}:00 UTC  N=${x.n}  EV ${x.ev >= 0 ? '+' : ''}${x.ev.toFixed(2)}R  total ${x.total.toFixed(0)}R`)
  }
  console.log('Worst hours:')
  for (const x of [...hourEntries].sort((a, b) => a.ev - b.ev).slice(0, 5)) {
    console.log(`  ${x.h.toString().padStart(2)}:00 UTC  N=${x.n}  EV ${x.ev >= 0 ? '+' : ''}${x.ev.toFixed(2)}R  total ${x.total.toFixed(0)}R`)
  }

  console.log('\n=== TP1 vs FULL LADDER vs FULL SL ===')
  const tp1Hit = trades.filter((t) => t.reachedTp1 && !t.fullLadder)
  const fullLadder = trades.filter((t) => t.fullLadder)
  const fullSL = trades.filter((t) => !t.reachedTp1)
  describe('TP1 hit then BE/trailing SL', tp1Hit)
  describe('Full ladder (TP3 hit)', fullLadder)
  describe('Initial SL (no TP)', fullSL)

  console.log('\n=== HYPOTHETICAL ALTERNATIVES (replay trades with different exit) ===')
  // Hypothetical 1: take everything at TP1 (no laddering, no trailing)
  let h1Total = 0, h1Wins = 0, h1Losses = 0
  for (const t of trades) {
    // If reached TP1 → assume +1R (ladder gave 1R worth at TP1, more at higher tp)
    // Approximated: if reachedTp1 → +1R, if not → t.pnlR (the SL)
    // This is rough — actual full TP1 close would have been ~1R for whole position
    // But ladder fills = 0.5R for 50% at 2R distance — let's skip this approximation
    // Use reachedTp1 as marker
    if (t.reachedTp1) { h1Total += 1.0; h1Wins++ }
    else { h1Total += -1.0; h1Losses++ }
  }
  console.log(`Take all at TP1 (1R fixed):  N=${trades.length} EV ${(h1Total/trades.length).toFixed(2)}R total ${h1Total.toFixed(0)}R WR ${(h1Wins/trades.length*100).toFixed(0)}%`)

  // Hypothetical 2: take all at TP2
  let h2Total = 0, h2Wins = 0
  for (const t of trades) {
    if (t.fillsCount >= 2) { h2Total += 2; h2Wins++ }
    else if (t.reachedTp1) { h2Total += 1; h2Wins++ } // got TP1 but stopped after
    else h2Total += -1
  }
  console.log(`Take all at TP2 (2R fixed):  N=${trades.length} EV ${(h2Total/trades.length).toFixed(2)}R total ${h2Total.toFixed(0)}R WR ${(h2Wins/trades.length*100).toFixed(0)}%`)

  // Hypothetical 3: 50% at TP1, 50% at TP2 (no TP3, no trailing past TP2)
  let h3Total = 0
  for (const t of trades) {
    if (t.fillsCount >= 2) h3Total += 0.5 * 1 + 0.5 * 2  // 1.5R
    else if (t.reachedTp1) h3Total += 0.5 * 1 + 0.5 * 0  // BE on remaining → 0.5R
    else h3Total += -1
  }
  console.log(`50% TP1, 50% TP2, BE between: EV ${(h3Total/trades.length).toFixed(2)}R total ${h3Total.toFixed(0)}R`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
