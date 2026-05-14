/**
 * Trend-Following Strategy #4: MACD signal cross + EMA200 trend filter on 4h.
 *
 * Logic:
 *   - MACD(12, 26, 9): macd = EMA12 - EMA26, signal = EMA9(macd), hist = macd - signal
 *   - EMA200 trend filter:
 *       LONG only when close > EMA200 (uptrend)
 *       SHORT only when close < EMA200 (downtrend)
 *   - Entry: market on bar where MACD crosses above signal (LONG) или below (SHORT)
 *     при условии trend filter
 *   - SL: entry ± 2×ATR(14)
 *   - TP1: entry ± 2×ATR (50%), TP2: entry ± 4×ATR (50%)
 *   - Trailing: после TP1 → SL = entry (BE)
 *   - Exit signal: MACD cross в обратную сторону
 *   - Max hold: 42 bars (7 days)
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_trend_macd.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from '../services/marginGuard'
import { ema } from '../services/indicators'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const TAKER_FEE = 0.00050
const MAKER_FEE = 0.00020
const TAKER_SLIP = 0.0003

const RISK_PCT = 2
const TIMEFRAME_HOURS = 4
const MAX_HOLD_BARS = 42

const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
const EMA_TREND = 200
const ATR_PERIOD = 14
const SL_ATR_MULT = 2.0
const TP1_ATR_MULT = 2.0
const TP2_ATR_MULT = 4.0

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const UNIVERSE_TOP10 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'POLUSDT',
]
const VARIANT_D = { startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 }

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mTo4h(m5: OHLCV[]): OHLCV[] {
  const bucketMs = TIMEFRAME_HOURS * 3600_000
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const b = Math.floor(c.time / bucketMs) * bucketMs
    const list = buckets.get(b) ?? []
    list.push(c); buckets.set(b, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t, open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function atrSeries(candles: OHLCV[], period = ATR_PERIOD): number[] {
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  return ema(tr, period)
}

function macd(closes: number[]): { macd: number[]; signal: number[]; hist: number[] } {
  const emaFast = ema(closes, MACD_FAST)
  const emaSlow = ema(closes, MACD_SLOW)
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i])
  const signal = ema(macdLine, MACD_SIGNAL)
  const hist = macdLine.map((v, i) => v - signal[i])
  return { macd: macdLine, signal, hist }
}

interface MacdSignal {
  symbol: string; side: 'BUY' | 'SELL'
  entryTime: number; entryIdx: number; entryPrice: number
  sl: number; tp1: number; tp2: number; atr: number
}

function generateSignals(
  candles4h: OHLCV[], symbol: string, periodFrom: number, periodTo: number,
): MacdSignal[] {
  const closes = candles4h.map(c => c.close)
  const { macd: macdLine, signal: sigLine } = macd(closes)
  const trendEma = ema(closes, EMA_TREND)
  const atr = atrSeries(candles4h, ATR_PERIOD)
  const sigs: MacdSignal[] = []
  const minBars = Math.max(EMA_TREND, MACD_SLOW + MACD_SIGNAL) + 1
  for (let i = minBars; i < candles4h.length; i++) {
    const c = candles4h[i]
    if (c.time < periodFrom || c.time > periodTo) continue
    if (!isFinite(atr[i]) || atr[i] <= 0) continue
    if (!isFinite(trendEma[i])) continue

    const crossUp = macdLine[i - 1] <= sigLine[i - 1] && macdLine[i] > sigLine[i]
    const crossDown = macdLine[i - 1] >= sigLine[i - 1] && macdLine[i] < sigLine[i]
    if (!crossUp && !crossDown) continue

    // Trend filter
    const uptrend = c.close > trendEma[i]
    const downtrend = c.close < trendEma[i]
    let side: 'BUY' | 'SELL' | null = null
    if (crossUp && uptrend) side = 'BUY'
    else if (crossDown && downtrend) side = 'SELL'
    if (!side) continue

    const entryPrice = c.close
    const atrValue = atr[i]
    const sl = side === 'BUY' ? entryPrice - SL_ATR_MULT * atrValue : entryPrice + SL_ATR_MULT * atrValue
    const tp1 = side === 'BUY' ? entryPrice + TP1_ATR_MULT * atrValue : entryPrice - TP1_ATR_MULT * atrValue
    const tp2 = side === 'BUY' ? entryPrice + TP2_ATR_MULT * atrValue : entryPrice - TP2_ATR_MULT * atrValue

    sigs.push({ symbol, side, entryTime: c.time, entryIdx: i, entryPrice, sl, tp1, tp2, atr: atrValue })
  }
  return sigs
}

interface ExitFill {
  time: number; price: number; percent: number
  reason: 'TP1' | 'TP2' | 'SL' | 'TRAIL_SL' | 'MACD_REVERSE' | 'MAX_HOLD'
  isMaker: boolean
}
interface ExitResult { fills: ExitFill[]; closeTime: number }

function simulateExit(
  candles4h: OHLCV[], signal: MacdSignal,
  macdLine: number[], sigLine: number[],
): ExitResult {
  const isLong = signal.side === 'BUY'
  let currentSL = signal.sl
  let tp1Hit = false, tp2Hit = false
  let remainingPct = 100
  const exitFills: ExitFill[] = []

  for (let i = signal.entryIdx + 1; i < Math.min(candles4h.length, signal.entryIdx + 1 + MAX_HOLD_BARS); i++) {
    const c = candles4h[i]
    // SL
    const slHit = isLong ? c.low <= currentSL : c.high >= currentSL
    if (slHit) {
      exitFills.push({
        time: c.time, price: currentSL, percent: remainingPct,
        reason: tp1Hit ? 'TRAIL_SL' : 'SL', isMaker: false,
      })
      return { fills: exitFills, closeTime: c.time }
    }
    // TP1
    if (!tp1Hit) {
      const tp1Reached = isLong ? c.high >= signal.tp1 : c.low <= signal.tp1
      if (tp1Reached) {
        const pct = 50
        exitFills.push({ time: c.time, price: signal.tp1, percent: pct, reason: 'TP1', isMaker: true })
        remainingPct -= pct
        tp1Hit = true
        currentSL = signal.entryPrice
      }
    }
    // TP2
    if (tp1Hit && !tp2Hit) {
      const tp2Reached = isLong ? c.high >= signal.tp2 : c.low <= signal.tp2
      if (tp2Reached) {
        exitFills.push({ time: c.time, price: signal.tp2, percent: remainingPct, reason: 'TP2', isMaker: true })
        remainingPct = 0
        return { fills: exitFills, closeTime: c.time }
      }
    }
    // MACD reverse
    const reverseExit = isLong
      ? macdLine[i] < sigLine[i]
      : macdLine[i] > sigLine[i]
    if (reverseExit && remainingPct > 0) {
      exitFills.push({ time: c.time, price: c.close, percent: remainingPct, reason: 'MACD_REVERSE', isMaker: false })
      return { fills: exitFills, closeTime: c.time }
    }
  }
  // Max hold
  const lastIdx = Math.min(candles4h.length - 1, signal.entryIdx + MAX_HOLD_BARS)
  if (remainingPct > 0 && lastIdx > signal.entryIdx) {
    const lastBar = candles4h[lastIdx]
    exitFills.push({ time: lastBar.time, price: lastBar.close, percent: remainingPct, reason: 'MAX_HOLD', isMaker: false })
    return { fills: exitFills, closeTime: lastBar.time }
  }
  return { fills: exitFills, closeTime: exitFills[exitFills.length - 1]?.time ?? signal.entryTime }
}

interface PortfolioTrade { signal: MacdSignal; exit: ExitResult }

interface SimResult {
  startingDeposit: number; signalsTotal: number; opened: number; trades: number
  totalR: number; rPerTr: number
  finalDeposit: number; peakDeposit: number; minDeposit: number; maxDD: number
  winRate: number
  tp1Rate: number; tp2Rate: number; slRate: number; reverseRate: number; maxHoldRate: number
  totalFeesUsd: number; totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(allTrades: PortfolioTrade[]): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.signal.entryTime - b.signal.entryTime)
  let currentDeposit = VARIANT_D.startingDeposit
  let peak = VARIANT_D.startingDeposit
  let trough = VARIANT_D.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0

  interface Active {
    pt: PortfolioTrade; id: number; positionSizeUsd: number; positionUnits: number
    leverage: number; marginUsd: number; realizedR: number; effectiveEntryPrice: number
    riskUsd: number; closedFracPct: number; fillsApplied: number
    statusKey: 'OPEN' | 'TP1_HIT'
  }
  const active: Active[] = []
  let nextId = 1, opened = 0
  let wins = 0, tp1Hits = 0, tp2Hits = 0, slHits = 0, reverseHits = 0, maxHoldHits = 0, totalR = 0
  const fullyClosed: PortfolioTrade[] = []

  const monthly = new Map<string, { pnl: number; equity: number; trades: number }>()
  function addMonthly(time: number, pnlDelta: number, tradeIncrement = 0) {
    const m = new Date(time).toISOString().slice(0, 7)
    const v = monthly.get(m) ?? { pnl: 0, equity: currentDeposit, trades: 0 }
    v.pnl += pnlDelta
    v.equity = currentDeposit
    v.trades += tradeIncrement
    monthly.set(m, v)
  }
  function applyDD(time: number) {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
    addMonthly(time, 0)
  }

  function realizeFillsUntil(t: number) {
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.exit.fills.length && a.pt.exit.fills[a.fillsApplied].time <= t) {
        const f = a.pt.exit.fills[a.fillsApplied]
        a.fillsApplied++
        const isLong = a.pt.signal.side === 'BUY'
        const exitPrice = f.isMaker ? f.price : (isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP))
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeUsd = fillNotional * (f.isMaker ? MAKER_FEE : TAKER_FEE)
        const slipUsd = f.isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        currentDeposit += grossPnl - feeUsd
        totalFees += feeUsd
        totalSlip += slipUsd
        const slDist = Math.abs(a.pt.signal.entryPrice - a.pt.signal.sl)
        const rContrib = ((isLong ? f.price - a.pt.signal.entryPrice : a.pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
        a.realizedR += rContrib
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        addMonthly(f.time, grossPnl - feeUsd, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        const fills = a.pt.exit.fills
        const hadTp2 = fills.some(f => f.reason === 'TP2')
        const hadTp1 = fills.some(f => f.reason === 'TP1')
        const lastReason = fills[fills.length - 1]?.reason
        if (hadTp2) tp2Hits++
        else if (hadTp1) tp1Hits++
        if (lastReason === 'SL' || lastReason === 'TRAIL_SL') slHits++
        else if (lastReason === 'MACD_REVERSE') reverseHits++
        else if (lastReason === 'MAX_HOLD') maxHoldHits++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        addMonthly(a.pt.exit.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  const takenSet = new Set<string>()
  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.signal.entryTime)
    if (active.some(a => a.pt.signal.symbol === pt.signal.symbol)) continue
    const key = `${pt.signal.symbol}|${pt.signal.entryTime}`
    if (takenSet.has(key)) continue
    if (active.length >= VARIANT_D.maxConcurrent) continue
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    if (slDist <= 0 || currentDeposit <= 0) continue

    const isLong = pt.signal.side === 'BUY'
    const effectiveEntry = isLong
      ? pt.signal.entryPrice * (1 + TAKER_SLIP)
      : pt.signal.entryPrice * (1 - TAKER_SLIP)
    const sizing = computeSizing({
      symbol: pt.signal.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_D.targetMarginPct,
      entry: effectiveEntry, sl: pt.signal.sl,
    })
    if (!sizing) continue
    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.signal.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd, closedFrac: a.closedFracPct / 100,
      leverage: a.leverage, unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT', hasTP2: false,
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    const entryFee = sizing.positionUnits * effectiveEntry * TAKER_FEE
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.signal.entryPrice)
    currentDeposit -= entryFee
    totalFees += entryFee
    totalSlip += entrySlip
    applyDD(pt.signal.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd, positionUnits: sizing.positionUnits,
      leverage: sizing.leverage, marginUsd: sizing.marginUsd,
      realizedR: 0, effectiveEntryPrice: effectiveEntry,
      riskUsd: sizing.riskUsd, closedFracPct: 0, fillsApplied: 0, statusKey: 'OPEN',
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  const tradeCount = fullyClosed.length
  return {
    startingDeposit: VARIANT_D.startingDeposit, signalsTotal: allTrades.length,
    opened, trades: tradeCount,
    totalR, rPerTr: tradeCount > 0 ? totalR / tradeCount : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
    tp1Rate: tradeCount > 0 ? (tp1Hits / tradeCount) * 100 : 0,
    tp2Rate: tradeCount > 0 ? (tp2Hits / tradeCount) * 100 : 0,
    slRate: tradeCount > 0 ? (slHits / tradeCount) * 100 : 0,
    reverseRate: tradeCount > 0 ? (reverseHits / tradeCount) * 100 : 0,
    maxHoldRate: tradeCount > 0 ? (maxHoldHits / tradeCount) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} ---`)
  console.log(
    `signals=${r.signalsTotal} opened=${r.opened} trades=${r.trades} | ` +
    `WR=${r.winRate.toFixed(0)}% TP1=${r.tp1Rate.toFixed(0)}% TP2=${r.tp2Rate.toFixed(0)}% SL=${r.slRate.toFixed(0)}% REV=${r.reverseRate.toFixed(0)}% MAX=${r.maxHoldRate.toFixed(0)}% | ` +
    `R/tr=${fmtR(r.rPerTr)} totalR=${fmtR(r.totalR)} | ` +
    `final $${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%) peak $${r.peakDeposit.toFixed(0)} min $${r.minDeposit.toFixed(0)} DD ${r.maxDD.toFixed(1)}% | ` +
    `fees $${r.totalFeesUsd.toFixed(0)} slip $${r.totalSlipUsd.toFixed(0)}`,
  )
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- ${label} monthly ---`)
  console.log('month   |  P&L     | equity   | trades')
  for (const m of [...r.monthly.keys()].sort()) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Trend Strategy #4: MACD signal cross + EMA200 trend filter on 4h')
  console.log(`Params: MACD(${MACD_FAST},${MACD_SLOW},${MACD_SIGNAL}) + EMA(${EMA_TREND}) trend filter`)
  console.log(`Entry: market on MACD signal cross when EMA200 confirms trend`)
  console.log(`SL: ±${SL_ATR_MULT}×ATR(${ATR_PERIOD}) | TP1: ±${TP1_ATR_MULT}×ATR | TP2: ±${TP2_ATR_MULT}×ATR | max hold ${MAX_HOLD_BARS} bars`)
  console.log(`Universe: top-10 majors`)
  console.log(`Variant D candidate: $${VARIANT_D.startingDeposit} | ${VARIANT_D.maxConcurrent} conc | ${VARIANT_D.targetMarginPct}% margin | ${RISK_PCT}% risk`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading m5 → 4h...')
  const candles4hBySymbol = new Map<string, OHLCV[]>()
  const macdBySymbol = new Map<string, { macd: number[]; signal: number[] }>()
  for (const sym of UNIVERSE_TOP10) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    const c4h = aggregate5mTo4h(m5)
    candles4hBySymbol.set(sym, c4h)
    const closes = c4h.map(c => c.close)
    const m = macd(closes)
    macdBySymbol.set(sym, { macd: m.macd, signal: m.signal })
  }
  console.log(`Loaded ${candles4hBySymbol.size}\n`)

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  function buildSignals(from: number, to: number): MacdSignal[] {
    const all: MacdSignal[] = []
    for (const [sym, c] of candles4hBySymbol.entries()) all.push(...generateSignals(c, sym, from, to))
    return all
  }
  function buildTrades(sigs: MacdSignal[]): PortfolioTrade[] {
    return sigs.map(s => {
      const m = macdBySymbol.get(s.symbol)!
      return { signal: s, exit: simulateExit(candles4hBySymbol.get(s.symbol)!, s, m.macd, m.signal) }
    })
  }

  const sFull = buildSignals(fullStart, now)
  const sTrain = buildSignals(fullStart, trainEnd)
  const sTest = buildSignals(trainEnd, now)
  console.log(`Signals: FULL ${sFull.length} | TRAIN ${sTrain.length} | TEST ${sTest.length}\n`)

  const fullR = simulate(buildTrades(sFull))
  const trainR = simulate(buildTrades(sTrain))
  const testR = simulate(buildTrades(sTest))

  printResult('FULL (365d)', fullR)
  printResult('TRAIN (60%)', trainR)
  printResult('TEST (40%)', testR)
  console.log()
  printMonthly('FULL', fullR)
  console.log()

  const bySymbol = new Map<string, { signals: number; wins: number; losses: number; r: number }>()
  for (const pt of buildTrades(sFull)) {
    const sym = pt.signal.symbol
    if (!bySymbol.has(sym)) bySymbol.set(sym, { signals: 0, wins: 0, losses: 0, r: 0 })
    const e = bySymbol.get(sym)!
    e.signals++
    let r = 0
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    const isLong = pt.signal.side === 'BUY'
    for (const f of pt.exit.fills) {
      r += ((isLong ? f.price - pt.signal.entryPrice : pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
    }
    e.r += r
    if (r > 0) e.wins++
    else e.losses++
  }
  console.log('--- Per-symbol (FULL) ---')
  for (const [sym, e] of [...bySymbol.entries()].sort((a, b) => b[1].r - a[1].r)) {
    const wr = (e.signals > 0 ? (e.wins / (e.wins + e.losses)) * 100 : 0).toFixed(0)
    console.log(`  ${sym.padEnd(10)} | sig=${e.signals.toString().padStart(3)} W=${e.wins.toString().padStart(2)} L=${e.losses.toString().padStart(2)} WR=${wr}% | totalR=${fmtR(e.r)}`)
  }
  console.log()

  const trainRet = (trainR.finalDeposit / trainR.startingDeposit - 1) * 100
  const testRet = (testR.finalDeposit / testR.startingDeposit - 1) * 100
  console.log('=== Verdict ===')
  console.log(`TRAIN: ${trainRet >= 0 ? '+' : ''}${trainRet.toFixed(0)}% | TEST: ${testRet >= 0 ? '+' : ''}${testRet.toFixed(0)}%`)
  console.log(`Robust: ${trainRet > 0 && testRet > 0 ? '✓ YES' : '✗ NO'}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `trend_macd_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'MACD + EMA200', params: { MACD_FAST, MACD_SLOW, MACD_SIGNAL, EMA_TREND, ATR_PERIOD, SL_ATR_MULT, TP1_ATR_MULT, TP2_ATR_MULT, MAX_HOLD_BARS },
    universe: UNIVERSE_TOP10, variant: VARIANT_D,
    full: { ...fullR, monthly: Object.fromEntries(fullR.monthly) },
    train: { ...trainR, monthly: Object.fromEntries(trainR.monthly) },
    test: { ...testR, monthly: Object.fromEntries(testR.monthly) },
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
