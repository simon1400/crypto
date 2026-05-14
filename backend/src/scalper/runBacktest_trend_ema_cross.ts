/**
 * Trend-Following Strategy #1: EMA Cross + ADX filter on 4h.
 *
 * Logic:
 *   - Aggregate 5m candles → 4h
 *   - EMA(10) cross above EMA(30) + ADX(14) > 25 on cross bar → LONG
 *   - EMA(10) cross below EMA(30) + ADX(14) > 25 on cross bar → SHORT
 *   - Entry: market at close of cross bar
 *   - SL: entry ± 2×ATR(14)
 *   - TP1: entry ± 2×ATR (close 50%)
 *   - TP2: entry ± 4×ATR (close 50%)
 *   - Trailing: after TP1 → SL=entry (BE), after TP2 → SL=TP1
 *   - Exit if EMA cross reverses (force close at market)
 *   - Max hold: 7 days (42 4h bars) — trend usually plays out within a week
 *
 * Fees: Binance USDT-M (taker 0.05% / maker 0.02% / slip 0.03%)
 * Position sizing: 2% risk per trade, 5% margin target, 20 max concurrent
 *
 * Universe: top-10 majors
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_trend_ema_cross.ts
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
const MAX_HOLD_BARS = 42  // 42 × 4h = 7 days

// Strategy params
const EMA_FAST = 10
const EMA_SLOW = 30
const ADX_PERIOD = 14
const ADX_THRESHOLD = 25
const ATR_PERIOD = 14
const SL_ATR_MULT = 2.0
const TP1_ATR_MULT = 2.0
const TP2_ATR_MULT = 4.0

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const UNIVERSE_TOP10 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'POLUSDT',
]

const VARIANT_D = {
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

// ============================================================================
// Aggregate 5m → 4h
// ============================================================================

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

// ============================================================================
// Indicators
// ============================================================================

function atrSeries(candles: OHLCV[], period = ATR_PERIOD): number[] {
  const n = candles.length
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  return ema(tr, period)
}

function adxSeries(candles: OHLCV[], period = ADX_PERIOD): number[] {
  const n = candles.length
  if (n < period * 2) return new Array(n).fill(0)
  const plusDM: number[] = [0], minusDM: number[] = [0]
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  const trEma = ema(tr, period)
  const plusEma = ema(plusDM, period)
  const minusEma = ema(minusDM, period)
  const dx: number[] = []
  for (let i = 0; i < n; i++) {
    const plusDI = trEma[i] > 0 ? (plusEma[i] / trEma[i]) * 100 : 0
    const minusDI = trEma[i] > 0 ? (minusEma[i] / trEma[i]) * 100 : 0
    const denom = plusDI + minusDI
    dx.push(denom > 0 ? (Math.abs(plusDI - minusDI) / denom) * 100 : 0)
  }
  return ema(dx, period)
}

// ============================================================================
// Signal generation
// ============================================================================

interface TrendSignal {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryIdx: number     // index in 4h array
  entryPrice: number
  sl: number
  tp1: number
  tp2: number
  atr: number
}

function generateSignals(
  candles4h: OHLCV[], symbol: string, periodFrom: number, periodTo: number,
): TrendSignal[] {
  const closes = candles4h.map(c => c.close)
  const emaFast = ema(closes, EMA_FAST)
  const emaSlow = ema(closes, EMA_SLOW)
  const adx = adxSeries(candles4h, ADX_PERIOD)
  const atr = atrSeries(candles4h, ATR_PERIOD)

  const signals: TrendSignal[] = []
  // Need at least EMA_SLOW + ADX_PERIOD bars before first signal
  const minBars = Math.max(EMA_SLOW, ADX_PERIOD * 2) + 1
  for (let i = minBars; i < candles4h.length; i++) {
    const c = candles4h[i]
    if (c.time < periodFrom || c.time > periodTo) continue

    const prevFast = emaFast[i - 1]
    const prevSlow = emaSlow[i - 1]
    const curFast = emaFast[i]
    const curSlow = emaSlow[i]

    if (!isFinite(prevFast) || !isFinite(curFast) || !isFinite(adx[i]) || !isFinite(atr[i])) continue
    if (atr[i] <= 0) continue

    // Cross detection
    const crossUp = prevFast <= prevSlow && curFast > curSlow
    const crossDown = prevFast >= prevSlow && curFast < curSlow
    if (!crossUp && !crossDown) continue

    if (adx[i] < ADX_THRESHOLD) continue

    const side: 'BUY' | 'SELL' = crossUp ? 'BUY' : 'SELL'
    const entryPrice = c.close
    const atrValue = atr[i]
    const sl = side === 'BUY' ? entryPrice - SL_ATR_MULT * atrValue : entryPrice + SL_ATR_MULT * atrValue
    const tp1 = side === 'BUY' ? entryPrice + TP1_ATR_MULT * atrValue : entryPrice - TP1_ATR_MULT * atrValue
    const tp2 = side === 'BUY' ? entryPrice + TP2_ATR_MULT * atrValue : entryPrice - TP2_ATR_MULT * atrValue

    signals.push({ symbol, side, entryTime: c.time, entryIdx: i, entryPrice, sl, tp1, tp2, atr: atrValue })
  }
  return signals
}

// ============================================================================
// Exit simulator
// ============================================================================

interface ExitFill {
  time: number; price: number; percent: number
  reason: 'TP1' | 'TP2' | 'SL' | 'TRAIL_SL' | 'EMA_REVERSE' | 'MAX_HOLD'
  isMaker: boolean
}

interface ExitResult { fills: ExitFill[]; closeTime: number }

function simulateExit(
  candles4h: OHLCV[],
  signal: TrendSignal,
  emaFast: number[],
  emaSlow: number[],
): ExitResult {
  const isLong = signal.side === 'BUY'
  let currentSL = signal.sl
  let tp1Hit = false
  let tp2Hit = false
  let remainingPct = 100
  const exitFills: ExitFill[] = []

  for (let i = signal.entryIdx + 1; i < Math.min(candles4h.length, signal.entryIdx + 1 + MAX_HOLD_BARS); i++) {
    const c = candles4h[i]
    // SL check first
    const slHit = isLong ? c.low <= currentSL : c.high >= currentSL
    if (slHit) {
      const reason: ExitFill['reason'] = tp1Hit ? 'TRAIL_SL' : 'SL'
      exitFills.push({ time: c.time, price: currentSL, percent: remainingPct, reason, isMaker: false })
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
        currentSL = signal.entryPrice  // → BE
      }
    }
    // TP2
    if (tp1Hit && !tp2Hit) {
      const tp2Reached = isLong ? c.high >= signal.tp2 : c.low <= signal.tp2
      if (tp2Reached) {
        const pct = remainingPct  // close all remaining (50%)
        exitFills.push({ time: c.time, price: signal.tp2, percent: pct, reason: 'TP2', isMaker: true })
        remainingPct = 0
        tp2Hit = true
        return { fills: exitFills, closeTime: c.time }
      }
    }
    // EMA reverse exit
    if (i >= signal.entryIdx + 1) {
      const reverseExit = isLong
        ? emaFast[i] < emaSlow[i]
        : emaFast[i] > emaSlow[i]
      if (reverseExit && remainingPct > 0) {
        exitFills.push({
          time: c.time, price: c.close, percent: remainingPct,
          reason: 'EMA_REVERSE', isMaker: false,
        })
        return { fills: exitFills, closeTime: c.time }
      }
    }
  }

  // Max hold reached
  const lastIdx = Math.min(candles4h.length - 1, signal.entryIdx + MAX_HOLD_BARS)
  if (remainingPct > 0 && lastIdx > signal.entryIdx) {
    const lastBar = candles4h[lastIdx]
    exitFills.push({ time: lastBar.time, price: lastBar.close, percent: remainingPct, reason: 'MAX_HOLD', isMaker: false })
    return { fills: exitFills, closeTime: lastBar.time }
  }

  return { fills: exitFills, closeTime: exitFills[exitFills.length - 1]?.time ?? signal.entryTime }
}

// ============================================================================
// Portfolio simulator
// ============================================================================

interface PortfolioTrade { signal: TrendSignal; exit: ExitResult }

interface SimResult {
  startingDeposit: number
  signalsTotal: number
  opened: number
  trades: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
  tp1Rate: number
  tp2Rate: number
  slRate: number
  reverseRate: number
  maxHoldRate: number
  totalFeesUsd: number
  totalSlipUsd: number
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
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    positionUnits: number
    leverage: number
    marginUsd: number
    realizedR: number
    effectiveEntryPrice: number
    riskUsd: number
    closedFracPct: number
    fillsApplied: number
    statusKey: 'OPEN' | 'TP1_HIT'
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let wins = 0, tp1Hits = 0, tp2Hits = 0, slHits = 0, reverseHits = 0, maxHoldHits = 0
  let totalR = 0
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
        const exitPrice = f.isMaker
          ? f.price
          : (isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP))
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeRate = f.isMaker ? MAKER_FEE : TAKER_FEE
        const feeUsd = fillNotional * feeRate
        const slipUsd = f.isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        totalFees += feeUsd
        totalSlip += slipUsd
        const slDist = Math.abs(a.pt.signal.entryPrice - a.pt.signal.sl)
        const rContrib = ((isLong ? f.price - a.pt.signal.entryPrice : a.pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
        a.realizedR += rContrib
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        const fills = a.pt.exit.fills
        const hadTp1 = fills.some(f => f.reason === 'TP1')
        const hadTp2 = fills.some(f => f.reason === 'TP2')
        const lastReason = fills[fills.length - 1]?.reason
        if (hadTp2) tp2Hits++
        else if (hadTp1) tp1Hits++
        if (lastReason === 'SL' || lastReason === 'TRAIL_SL') slHits++
        else if (lastReason === 'EMA_REVERSE') reverseHits++
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

    // Same-symbol guard: не открываем вторую позицию по той же монете
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
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT', hasTP2: false,
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFee = entryNotional * TAKER_FEE
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.signal.entryPrice)
    currentDeposit -= entryFee
    totalFees += entryFee
    totalSlip += entrySlip
    applyDD(pt.signal.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      realizedR: 0, effectiveEntryPrice: effectiveEntry,
      riskUsd: sizing.riskUsd,
      closedFracPct: 0, fillsApplied: 0, statusKey: 'OPEN',
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
    startingDeposit: VARIANT_D.startingDeposit,
    signalsTotal: allTrades.length,
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

// ============================================================================
// Main
// ============================================================================

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
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Trend Strategy #1: EMA Cross + ADX filter on 4h')
  console.log(`Params: EMA(${EMA_FAST})/EMA(${EMA_SLOW}) + ADX(${ADX_PERIOD})>${ADX_THRESHOLD}`)
  console.log(`Entry: market on cross | SL: ±${SL_ATR_MULT}×ATR(${ATR_PERIOD}) | TP1: ±${TP1_ATR_MULT}×ATR (50%) | TP2: ±${TP2_ATR_MULT}×ATR (50%) | max hold ${MAX_HOLD_BARS} bars (${MAX_HOLD_BARS * TIMEFRAME_HOURS}h)`)
  console.log(`Universe: top-10 majors (${UNIVERSE_TOP10.length} symbols)`)
  console.log(`Variant D candidate: $${VARIANT_D.startingDeposit} | ${VARIANT_D.maxConcurrent} conc | ${VARIANT_D.targetMarginPct}% margin | ${RISK_PCT}% risk`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading m5 candles + aggregating to 4h...')
  const candles4hBySymbol = new Map<string, OHLCV[]>()
  for (const sym of UNIVERSE_TOP10) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    const candles4h = aggregate5mTo4h(m5)
    candles4hBySymbol.set(sym, candles4h)
  }
  console.log(`Loaded ${candles4hBySymbol.size} symbols on 4h\n`)

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  console.log('Generating signals...')
  function buildSignalsForPeriod(from: number, to: number): TrendSignal[] {
    const all: TrendSignal[] = []
    for (const [sym, candles] of candles4hBySymbol.entries()) {
      all.push(...generateSignals(candles, sym, from, to))
    }
    return all
  }

  function buildTrades(signals: TrendSignal[]): PortfolioTrade[] {
    return signals.map(s => {
      const c = candles4hBySymbol.get(s.symbol)!
      const closes = c.map(x => x.close)
      const eFast = ema(closes, EMA_FAST)
      const eSlow = ema(closes, EMA_SLOW)
      return { signal: s, exit: simulateExit(c, s, eFast, eSlow) }
    })
  }

  const signalsFull = buildSignalsForPeriod(fullStart, now)
  const signalsTrain = buildSignalsForPeriod(fullStart, trainEnd)
  const signalsTest = buildSignalsForPeriod(trainEnd, now)
  console.log(`Signals: FULL ${signalsFull.length} | TRAIN ${signalsTrain.length} | TEST ${signalsTest.length}\n`)

  const fullR = simulate(buildTrades(signalsFull))
  const trainR = simulate(buildTrades(signalsTrain))
  const testR = simulate(buildTrades(signalsTest))

  printResult('FULL (365d)', fullR)
  printResult('TRAIN (60%)', trainR)
  printResult('TEST (40%)', testR)
  console.log()
  printMonthly('FULL', fullR)
  console.log()

  // Per-symbol breakdown
  console.log('--- Per-symbol breakdown (FULL) ---')
  const bySymbol = new Map<string, { signals: number; wins: number; losses: number; r: number }>()
  for (const s of signalsFull) {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, { signals: 0, wins: 0, losses: 0, r: 0 })
    bySymbol.get(s.symbol)!.signals++
  }
  // Build trade-level R per symbol (re-using simulate would mix; do simple per-sig backtest)
  const fullTrades = buildTrades(signalsFull)
  for (const pt of fullTrades) {
    const ent = bySymbol.get(pt.signal.symbol)!
    let r = 0
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    const isLong = pt.signal.side === 'BUY'
    for (const f of pt.exit.fills) {
      r += ((isLong ? f.price - pt.signal.entryPrice : pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
    }
    ent.r += r
    if (r > 0) ent.wins++
    else ent.losses++
  }
  for (const [sym, e] of [...bySymbol.entries()].sort((a, b) => b[1].r - a[1].r)) {
    const wr = (e.signals > 0 ? (e.wins / (e.wins + e.losses)) * 100 : 0).toFixed(0)
    console.log(`  ${sym.padEnd(10)} | sig=${e.signals.toString().padStart(3)} W=${e.wins.toString().padStart(2)} L=${e.losses.toString().padStart(2)} WR=${wr}% | totalR=${fmtR(e.r)}`)
  }
  console.log()

  // Verdict
  const trainRet = (trainR.finalDeposit / trainR.startingDeposit - 1) * 100
  const testRet = (testR.finalDeposit / testR.startingDeposit - 1) * 100
  console.log('=== Verdict ===')
  console.log(`TRAIN: ${trainRet >= 0 ? '+' : ''}${trainRet.toFixed(0)}% | TEST: ${testRet >= 0 ? '+' : ''}${testRet.toFixed(0)}%`)
  const robust = trainRet > 0 && testRet > 0
  console.log(`Robust (both positive): ${robust ? '✓ YES' : '✗ NO'}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `trend_ema_cross_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'EMA Cross + ADX', params: { EMA_FAST, EMA_SLOW, ADX_PERIOD, ADX_THRESHOLD, ATR_PERIOD, SL_ATR_MULT, TP1_ATR_MULT, TP2_ATR_MULT, MAX_HOLD_BARS },
    universe: UNIVERSE_TOP10, variant: VARIANT_D,
    full: { ...fullR, monthly: Object.fromEntries(fullR.monthly) },
    train: { ...trainR, monthly: Object.fromEntries(trainR.monthly) },
    test: { ...testR, monthly: Object.fromEntries(testR.monthly) },
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
