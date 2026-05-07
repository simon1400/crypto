/**
 * maxConcurrentPositions backtest:
 *
 * Тестируем разные лимиты на кол-во одновременно открытых позиций (3, 5, 7, 10, 15, ∞).
 * Когда лимит достигнут — новый сигнал SKIP.
 *
 * Сравниваем по DD, final deposit, R/tr, % skipped в TRAIN и TEST.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_max_concurrent.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const FEES_RT = 0.0008
const SPLITS = [0.5, 0.3, 0.2]

const CONCURRENT_LIMITS = [3, 5, 7, 10, 15, 999]  // 999 ≈ no limit (baseline)

interface RunCase { symbol: string; side: 'BUY' | 'SELL' | 'BOTH'; tpMinAtr?: number }

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'SEIUSDT',      side: 'SELL' },
  { symbol: 'WIFUSDT',      side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'SOLUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ARBUSDT',      side: 'SELL' },
  { symbol: 'AVAXUSDT',     side: 'SELL', tpMinAtr: 1.0 },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT',      side: 'SELL' },
  { symbol: 'HYPEUSDT',     side: 'BUY',  tpMinAtr: 0.5 },
  { symbol: 'ENAUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'AAVEUSDT',     side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'STRKUSDT',     side: 'SELL' },
  { symbol: 'BLURUSDT',     side: 'SELL' },
  { symbol: 'CRVUSDT',      side: 'SELL', tpMinAtr: 0.5 },
]

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter', fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr, minRR: 0, maxRR: 8, excludeKillzones: ['NY_PM'],
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

interface Sig {
  symbol: string
  side: 'BUY' | 'SELL'
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
}

interface SymbolData {
  symbol: string
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  m5: OHLCV[]
  signals: Sig[]
  candleByTime: Map<number, OHLCV>
}

function generateSigsForCase(data: LoadedData, c: RunCase): Sig[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigs.push({
      symbol: c.symbol, side: s.side, setupSide: c.side,
      entryTime: s.entryTime, entryPrice: s.entryPrice, sl: s.slPrice, tpLadder: s.tpLadder,
    })
  }
  return sigs
}

interface OpenPos {
  symbol: string
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  side: 'BUY' | 'SELL'
  entryTime: number
  fillPrice: number
  initialSL: number
  trailingSL: number
  riskUsd: number
  positionSizeUsd: number
  riskPerUnit: number
  nextTpIdx: number
  remainingFrac: number
  splits: number[]
  tps: number[]
  fills: Array<{ tpIdx: number; price: number; frac: number; rContrib: number; pnlUsd: number }>
  reachedTp1: boolean
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
}

interface ClosedTrade {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  exitTime: number
  pnlR: number
  pnlUsd: number
  exitReason: 'SL' | 'LADDER_DONE' | 'EOD'
  reachedTp1: boolean
}

interface SimResult {
  limit: number
  startingDeposit: number
  finalDeposit: number
  trades: ClosedTrade[]
  signalsAttempted: number
  signalsOpened: number
  signalsSkippedConcurrent: number
  signalsBlockedCrossSide: number
  signalsBlockedSamePos: number
  peakDeposit: number
  peakEquity: number
  maxRealizedDD: number
  maxEquityDD: number
}

function alignSplits(ladderLen: number): number[] {
  if (ladderLen <= 0) return []
  if (ladderLen >= SPLITS.length) {
    const out = [...SPLITS, ...new Array(ladderLen - SPLITS.length).fill(0)]
    const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
    out[out.length - 1] = Math.max(0, 1 - used)
    return out
  }
  const out = SPLITS.slice(0, ladderLen)
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[out.length - 1] = Math.max(0, 1 - used)
  return out
}

function simulate(
  symbolData: SymbolData[],
  maxConcurrent: number,
  range?: { from: number; to: number },
): SimResult {
  const allTimes = new Set<number>()
  for (const s of symbolData) for (const c of s.m5) {
    if (range && (c.time < range.from || c.time > range.to)) continue
    allTimes.add(c.time)
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b)

  let deposit = STARTING_DEPOSIT
  let peakDeposit = STARTING_DEPOSIT, peakEquity = STARTING_DEPOSIT
  let maxRealizedDD = 0, maxEquityDD = 0
  const openPositions: OpenPos[] = []
  const trades: ClosedTrade[] = []
  let signalsAttempted = 0, signalsOpened = 0, signalsSkippedConcurrent = 0
  let signalsBlockedCrossSide = 0, signalsBlockedSamePos = 0

  const candleLookup = new Map<string, Map<number, OHLCV>>()
  for (const s of symbolData) candleLookup.set(s.symbol, s.candleByTime)
  const sigByTime = new Map<number, Sig[]>()
  for (const s of symbolData) {
    for (const sig of s.signals) {
      if (range && (sig.entryTime < range.from || sig.entryTime > range.to)) continue
      if (!sigByTime.has(sig.entryTime)) sigByTime.set(sig.entryTime, [])
      sigByTime.get(sig.entryTime)!.push(sig)
    }
  }

  function finalizeTrade(pos: OpenPos, exitTime: number, reason: ClosedTrade['exitReason']): void {
    const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
    const grossUsd = pos.fills.reduce((s, f) => s + f.pnlUsd, 0)
    const feeR = (pos.fillPrice * FEES_RT) / pos.riskPerUnit
    const feeUsd = pos.positionSizeUsd * FEES_RT
    deposit += grossUsd - feeUsd
    if (deposit > peakDeposit) peakDeposit = deposit
    const dd = ((peakDeposit - deposit) / peakDeposit) * 100
    if (dd > maxRealizedDD) maxRealizedDD = dd
    trades.push({
      symbol: pos.symbol, side: pos.side,
      entryTime: pos.entryTime, exitTime,
      pnlR: Math.round((grossR - feeR) * 10000) / 10000,
      pnlUsd: Math.round((grossUsd - feeUsd) * 100) / 100,
      exitReason: reason, reachedTp1: pos.reachedTp1,
    })
    const idx = openPositions.indexOf(pos)
    if (idx >= 0) openPositions.splice(idx, 1)
  }

  function processBar(pos: OpenPos, c: OHLCV): void {
    const isLong = pos.side === 'BUY'
    const slHit = isLong ? c.low <= pos.trailingSL : c.high >= pos.trailingSL
    if (slHit) {
      const exitFill = pos.trailingSL
      const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.riskPerUnit
      const pnlUsd = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
      pos.fills.push({ tpIdx: -1, price: exitFill, frac: pos.remainingFrac, rContrib, pnlUsd })
      pos.remainingFrac = 0
      finalizeTrade(pos, c.time, 'SL')
      return
    }
    while (pos.nextTpIdx < pos.splits.length && pos.remainingFrac > 1e-9) {
      const tpIdx = pos.nextTpIdx
      const tp = pos.tps[tpIdx]
      const wickReached = isLong ? c.high >= tp : c.low <= tp
      if (!wickReached) break
      const isLastTp = tpIdx === pos.splits.length - 1
      const closeBeyond = isLong ? c.close > tp : c.close < tp
      const fill = !closeBeyond || isLastTp
      if (!fill) { pos.nextTpIdx++; continue }
      const frac = pos.splits[tpIdx] ?? 0
      if (frac > 0) {
        const rContrib = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * frac) / pos.riskPerUnit
        const pnlUsd = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * pos.positionSizeUsd / pos.fillPrice) * frac
        pos.fills.push({ tpIdx, price: tp, frac, rContrib, pnlUsd })
        pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)
        if (tpIdx === 0) { pos.reachedTp1 = true; pos.trailingSL = pos.fillPrice; pos.status = 'TP1_HIT' }
        else if (tpIdx === 1) { pos.trailingSL = pos.tps[0]; pos.status = 'TP2_HIT' }
        else pos.trailingSL = pos.tps[tpIdx - 1]
      }
      pos.nextTpIdx++
      if (pos.remainingFrac <= 1e-9) { finalizeTrade(pos, c.time, 'LADDER_DONE'); return }
    }
  }

  function unrealizedPnl(pos: OpenPos, currentPrice: number): number {
    const isLong = pos.side === 'BUY'
    return ((isLong ? currentPrice - pos.fillPrice : pos.fillPrice - currentPrice) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
  }

  for (const t of sortedTimes) {
    for (const pos of [...openPositions]) {
      const c = candleLookup.get(pos.symbol)?.get(t)
      if (c) processBar(pos, c)
    }

    // Equity DD tracking
    const perSymPrices = new Map<string, number>()
    for (const [sym, m] of candleLookup) {
      const c = m.get(t); if (c) perSymPrices.set(sym, c.close)
    }
    let unrealized = 0
    for (const pos of openPositions) {
      const p = perSymPrices.get(pos.symbol)
      if (p != null) unrealized += unrealizedPnl(pos, p)
    }
    const eq = deposit + unrealized
    if (eq > peakEquity) peakEquity = eq
    const eqDD = ((peakEquity - eq) / peakEquity) * 100
    if (eqDD > maxEquityDD) maxEquityDD = eqDD

    const sigs = sigByTime.get(t)
    if (!sigs) continue
    for (const sig of sigs) {
      signalsAttempted++
      // Cross-side block для BOTH
      if (sig.setupSide === 'BOTH') {
        const opp = openPositions.find(p => p.symbol === sig.symbol && p.side !== sig.side && !p.reachedTp1)
        if (opp) { signalsBlockedCrossSide++; continue }
      }
      // Single-position-per-side per symbol
      const samePos = openPositions.find(p => p.symbol === sig.symbol && p.side === sig.side)
      if (samePos) { signalsBlockedSamePos++; continue }
      // maxConcurrentPositions guard
      if (openPositions.length >= maxConcurrent) { signalsSkippedConcurrent++; continue }

      const isLong = sig.side === 'BUY'
      const entryFill = sig.entryPrice
      const riskPerUnit = Math.abs(entryFill - sig.sl)
      if (riskPerUnit <= 0) continue
      if (isLong && sig.sl >= entryFill) continue
      if (!isLong && sig.sl <= entryFill) continue
      if (!sig.tpLadder.every(p => isLong ? p > entryFill : p < entryFill)) continue

      const riskUsd = deposit * (RISK_PCT / 100)
      const positionUnits = riskUsd / riskPerUnit
      const positionSizeUsd = entryFill * positionUnits

      const newPos: OpenPos = {
        symbol: sig.symbol, setupSide: sig.setupSide, side: sig.side,
        entryTime: t, fillPrice: entryFill, initialSL: sig.sl, trailingSL: sig.sl,
        riskUsd, positionSizeUsd, riskPerUnit,
        nextTpIdx: 0, remainingFrac: 1,
        splits: alignSplits(sig.tpLadder.length), tps: sig.tpLadder,
        fills: [], reachedTp1: false, status: 'OPEN',
      }
      openPositions.push(newPos)
      signalsOpened++
    }
  }

  // Close remaining at last bar (EOD)
  for (const pos of [...openPositions]) {
    const symCandles = candleLookup.get(pos.symbol)
    if (!symCandles) continue
    const lastTime = [...symCandles.keys()].sort((a, b) => b - a)[0]
    const c = symCandles.get(lastTime)
    if (!c) continue
    const isLong = pos.side === 'BUY'
    const exitPrice = c.close
    const rContrib = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.remainingFrac) / pos.riskPerUnit
    const pnlUsd = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
    pos.fills.push({ tpIdx: -1, price: exitPrice, frac: pos.remainingFrac, rContrib, pnlUsd })
    pos.remainingFrac = 0
    finalizeTrade(pos, c.time, 'EOD')
  }

  return {
    limit: maxConcurrent, startingDeposit: STARTING_DEPOSIT, finalDeposit: deposit,
    trades, signalsAttempted, signalsOpened, signalsSkippedConcurrent,
    signalsBlockedCrossSide, signalsBlockedSamePos,
    peakDeposit, peakEquity, maxRealizedDD, maxEquityDD,
  }
}

function summarizeRow(r: SimResult): string {
  const n = r.trades.length
  const ret = ((r.finalDeposit - r.startingDeposit) / r.startingDeposit) * 100
  const wins = r.trades.filter(t => t.pnlUsd > 0).length
  const wr = n > 0 ? (wins / n) * 100 : 0
  const totalR = r.trades.reduce((s, t) => s + t.pnlR, 0)
  const rPerTr = n > 0 ? totalR / n : 0
  const skipPct = r.signalsAttempted > 0 ? (r.signalsSkippedConcurrent / r.signalsAttempted) * 100 : 0
  const limStr = r.limit === 999 ? '∞' : r.limit.toString()
  return `${limStr.padStart(3)} | $${r.finalDeposit.toFixed(0).padStart(5)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0).padStart(4)}%) | DD ${r.maxEquityDD.toFixed(0).padStart(2)}% | N=${n.toString().padStart(4)} R/tr=${(rPerTr >= 0 ? '+' : '') + rPerTr.toFixed(2)} WR=${wr.toFixed(0)}% | skip=${skipPct.toFixed(0)}%`
}

async function main() {
  console.log('maxConcurrentPositions backtest — Депо $500, риск 2%')
  console.log('Тестируем лимиты: 3, 5, 7, 10, 15, ∞ (без лимита)')
  console.log('Walk-forward: FULL (365d) / TRAIN (60% = 219d) / TEST (40% = 146d)')
  console.log()

  console.log('Loading symbols...')
  const symbolData: SymbolData[] = []
  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) continue
    const sigs = generateSigsForCase(data, c)
    const m5 = sliceLastDays(data.m5, DAYS_BACK)
    const candleByTime = new Map<number, OHLCV>()
    for (const candle of m5) candleByTime.set(candle.time, candle)
    symbolData.push({ symbol: c.symbol, setupSide: c.side, m5, signals: sigs, candleByTime })
    console.log(`  ${c.symbol.padEnd(15)} sigs=${sigs.length}`)
  }

  const now = Date.now()
  const fullStart = now - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = now - Math.round(DAYS_BACK * 0.4) * 24 * 60 * 60_000

  console.log('\n=== FULL period (365d) ===')
  console.log('Lim | Финал           | DD   | Trades & R/tr             | Skip due to maxConcurrent')
  console.log('-'.repeat(95))
  const fullResults: SimResult[] = []
  for (const lim of CONCURRENT_LIMITS) {
    const r = simulate(symbolData, lim, { from: fullStart, to: now })
    fullResults.push(r)
    console.log(summarizeRow(r))
  }

  console.log('\n=== TRAIN period (60% = 219d) ===')
  console.log('Lim | Финал           | DD   | Trades & R/tr             | Skip')
  console.log('-'.repeat(95))
  const trainResults: SimResult[] = []
  for (const lim of CONCURRENT_LIMITS) {
    const r = simulate(symbolData, lim, { from: fullStart, to: trainEnd })
    trainResults.push(r)
    console.log(summarizeRow(r))
  }

  console.log('\n=== TEST period (40% = 146d) ===')
  console.log('Lim | Финал           | DD   | Trades & R/tr             | Skip')
  console.log('-'.repeat(95))
  const testResults: SimResult[] = []
  for (const lim of CONCURRENT_LIMITS) {
    const r = simulate(symbolData, lim, { from: trainEnd, to: now })
    testResults.push(r)
    console.log(summarizeRow(r))
  }

  // Подведение итогов
  console.log('\n=== SUMMARY: deposit/DD по периодам ===')
  console.log('Lim |     FULL deposit    |    TRAIN deposit    |     TEST deposit    | TEST DD')
  console.log('-'.repeat(100))
  for (let i = 0; i < CONCURRENT_LIMITS.length; i++) {
    const f = fullResults[i], tr = trainResults[i], te = testResults[i]
    const limStr = (f.limit === 999 ? '∞' : f.limit.toString()).padStart(3)
    function cell(r: SimResult): string {
      const ret = ((r.finalDeposit - r.startingDeposit) / r.startingDeposit) * 100
      return `$${r.finalDeposit.toFixed(0).padStart(5)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0).padStart(3)}%) DD${r.maxEquityDD.toFixed(0).padStart(2)}%`
    }
    console.log(`${limStr} | ${cell(f).padEnd(20)} | ${cell(tr).padEnd(20)} | ${cell(te).padEnd(20)} | ${te.maxEquityDD.toFixed(0)}%`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
