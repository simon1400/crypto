/**
 * Daily Breakout — Binance live model: Variant A vs Variant B comparison.
 *
 * Same underlying signal pool (23 prod symbols, 365d, BTC ADX>20 filter,
 * EOD-NO-TP1, dedup guards on). Only sizing/concurrency differs:
 *
 *   Variant A: $500 deposit, 10 max conc, 10% target margin
 *   Variant B: $320 deposit, 20 max conc, 5%  target margin
 *
 * Both run with the realistic Binance fee model:
 *   - Entry market = taker 0.05% + slip 0.03%
 *   - TP exit = maker 0.02% (limit at TP, no slip)
 *   - SL/EXPIRED = taker 0.05% + slip 0.03%
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_binance_AB.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from '../services/marginGuard'
import { ema } from '../services/indicators'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

// Binance USDT-M perp base tier (no VIP, no native token discount)
const TAKER_FEE = 0.00050   // 0.05%
const MAKER_FEE = 0.00020   // 0.02%
const TAKER_SLIP = 0.0003   // 0.03% on altcoin perps

const RISK_PCT = 2

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]

const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

interface Variant {
  name: 'A' | 'B'
  startingDeposit: number
  maxConcurrent: number
  targetMarginPct: number
}

const VARIANTS: Variant[] = [
  { name: 'A', startingDeposit: 500, maxConcurrent: 10, targetMarginPct: 10 },
  { name: 'B', startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5  },
]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ============================================================================
// BTC ADX(14) on 1h
// ============================================================================

function aggregate5mTo1h(m5: OHLCV[]): OHLCV[] {
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const h = Math.floor(c.time / 3600_000) * 3600_000
    const list = buckets.get(h) ?? []
    list.push(c); buckets.set(h, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function adxSeries(candles: OHLCV[], period = BTC_ADX_PERIOD): number[] {
  const n = candles.length
  if (n < period * 2) return new Array(n).fill(0)
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
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

interface BtcRegime { isTrending(unixMs: number): boolean }

async function buildBtcRegime(): Promise<BtcRegime> {
  const m5 = await loadHistorical('BTCUSDT', '5m', MONTHS_BACK, 'bybit', 'linear')
  const h1 = aggregate5mTo1h(m5)
  const adx = adxSeries(h1, BTC_ADX_PERIOD)
  const byHour = new Map<number, number>()
  for (let i = 0; i < h1.length; i++) byHour.set(h1[i].time, adx[i])
  return {
    isTrending(t: number) {
      const h = Math.floor(t / 3600_000) * 3600_000
      const v = byHour.get(h)
      return v == null ? true : v > BTC_ADX_THRESHOLD
    },
  }
}

// ============================================================================
// Signal generation + ladder backtest (raw, fees applied at portfolio level)
// ============================================================================

interface BreakoutCfg {
  rangeBars: number
  volMultiplier: number
  tp1Mult: number
  tp2Mult: number
  tp3Mult: number
}

function generateBreakoutSignals(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): LadderSignal[] {
  const sigs: LadderSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }
  for (const [, candles] of byDay) {
    if (candles.length < cfg.rangeBars + 5) continue
    const rangeBars = candles.slice(0, cfg.rangeBars)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue
    let triggered = false
    for (let i = cfg.rangeBars; i < candles.length && !triggered; i++) {
      const c = candles[i]
      const start = Math.max(0, i - 24)
      const avgVol = candles.slice(start, i).reduce((s, x) => s + x.volume, 0) / Math.max(1, i - start)
      if (c.volume < avgVol * cfg.volMultiplier) continue
      let side: 'BUY' | 'SELL' | null = null
      let entryPrice = 0
      if (c.high > rangeHigh && c.close > rangeHigh) { side = 'BUY'; entryPrice = rangeHigh }
      else if (c.low < rangeLow && c.close < rangeLow) { side = 'SELL'; entryPrice = rangeLow }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * cfg.tp1Mult, entryPrice + rangeSize * cfg.tp2Mult, entryPrice + rangeSize * cfg.tp3Mult]
        : [entryPrice - rangeSize * cfg.tp1Mult, entryPrice - rangeSize * cfg.tp2Mult, entryPrice - rangeSize * cfg.tp3Mult]
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

function runLadderRaw(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): LadderTrade[] {
  const sigs = generateBreakoutSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  // Use 0 fees / 0 slip in ladder — we apply our own model on top.
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: 0, slippagePerSide: 0,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface PortfolioFill {
  time: number
  price: number
  pnlR: number
  percent: number
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

interface PortfolioTrade {
  symbol: string
  utcDate: string
  entryTime: number
  closeTime: number
  side: 'BUY' | 'SELL'
  entryPrice: number
  sl: number
  fills: PortfolioFill[]
}

function toPortfolioTrade(symbol: string, t: LadderTrade): PortfolioTrade {
  const fills: PortfolioFill[] = (t.fills ?? []).map((f, i) => {
    const fillCount = (t.fills ?? []).length
    const frac = fillCount > 1 ? (i + 1) / fillCount : 1
    const time = t.entryTime + (t.exitTime - t.entryTime) * frac
    let reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
    if (f.idx >= 0) reason = (`TP${f.idx + 1}`) as 'TP1' | 'TP2' | 'TP3'
    else if (t.exitReason === 'EOD' || t.exitReason === 'MAX_HOLD') reason = 'EXPIRED'
    else reason = 'SL'
    return { time, price: f.price, pnlR: f.rContrib, percent: f.frac * 100, reason }
  })
  return {
    symbol,
    utcDate: utcDateOf(t.entryTime),
    entryTime: t.entryTime,
    closeTime: t.exitTime,
    side: t.side,
    entryPrice: t.entryPrice,
    sl: t.initialSL,
    fills,
  }
}

// ============================================================================
// Portfolio simulator with Binance fee/slip + dedup guards
// ============================================================================

interface SimResult {
  variant: 'A' | 'B'
  startingDeposit: number
  signalsTotal: number
  skippedBtcAdx: number
  skippedCarryOver: number
  skippedSameDay: number
  skippedConcurrent: number
  skippedMargin: number
  opened: number
  trades: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(
  allTrades: PortfolioTrade[],
  variant: Variant,
  btc: BtcRegime,
): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = variant.startingDeposit
  let peak = variant.startingDeposit
  let trough = variant.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0

  interface Active {
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    positionUnits: number
    leverage: number
    marginUsd: number
    fillsApplied: number
    closedFracPct: number
    statusKey: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
    realizedR: number
    riskUsd: number
    effectiveEntryPrice: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0
  const takenSet = new Set<string>()

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
      while (a.fillsApplied < a.pt.fills.length && a.pt.fills[a.fillsApplied].time <= t) {
        const f = a.pt.fills[a.fillsApplied]
        a.fillsApplied++
        // Apply Binance fee/slip per fill kind
        const isMaker = f.reason === 'TP1' || f.reason === 'TP2' || f.reason === 'TP3'
        let exitPrice: number
        const isLong = a.pt.side === 'BUY'
        if (isMaker) {
          exitPrice = f.price  // limit at TP, no slip
        } else {
          // SL/EXPIRED = taker market, slip pushes worse
          exitPrice = isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP)
        }
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeRate = isMaker ? MAKER_FEE : TAKER_FEE
        const feeUsd = fillNotional * feeRate
        const slipUsd = isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        totalFees += feeUsd
        totalSlip += slipUsd
        a.realizedR += f.pnlR
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        addMonthly(a.pt.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.entryTime)

    if (!btc.isTrending(pt.entryTime)) { skippedBtcAdx++; continue }
    // Carry-over guard
    if (active.some(a => a.pt.symbol === pt.symbol && a.pt.utcDate !== pt.utcDate)) {
      skippedCarryOver++; continue
    }
    // Same-day per-symbol guard
    const key = `${pt.symbol}|${pt.utcDate}`
    if (takenSet.has(key)) { skippedSameDay++; continue }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= variant.maxConcurrent) { skippedConcurrent++; continue }

    // Apply entry slip BEFORE sizing
    const isLong = pt.side === 'BUY'
    const slippedEntry = isLong ? pt.entryPrice * (1 + TAKER_SLIP) : pt.entryPrice * (1 - TAKER_SLIP)

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: variant.targetMarginPct,
      entry: slippedEntry, sl: pt.sl,
    })
    if (!sizing) { skippedMargin++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
      hasTP2: a.statusKey === 'TP2_HIT',
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) { skippedMargin++; continue }
    if (guard.toClose.length > 0) { skippedMargin++; continue }

    // Charge entry taker fee + record entry slip
    const entryNotional = sizing.positionUnits * slippedEntry
    const entryFee = entryNotional * TAKER_FEE
    currentDeposit -= entryFee
    totalFees += entryFee
    const entrySlip = sizing.positionUnits * Math.abs(slippedEntry - pt.entryPrice)
    totalSlip += entrySlip
    applyDD(pt.entryTime)

    takenSet.add(`${pt.symbol}|${pt.utcDate}`)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      effectiveEntryPrice: slippedEntry,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    variant: variant.name,
    startingDeposit: variant.startingDeposit,
    signalsTotal: allTrades.length,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

// ============================================================================
// Output
// ============================================================================

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label}: Variant ${r.variant} ($${r.startingDeposit} start) ---`)
  console.log(
    `signals=${r.signalsTotal} | ` +
    `skip btcAdx=${r.skippedBtcAdx} carryOver=${r.skippedCarryOver} sameDay=${r.skippedSameDay} ` +
    `conc=${r.skippedConcurrent} margin=${r.skippedMargin} | opened=${r.opened}`
  )
  console.log(
    `totalR=${fmtR(r.totalR)} R/tr=${fmtR(r.rPerTr)} WR=${r.winRate.toFixed(0)}% | ` +
    `final=$${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) ` +
    `peak=$${r.peakDeposit.toFixed(0)} min=$${r.minDeposit.toFixed(0)} DD=${r.maxDD.toFixed(1)}%`
  )
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)} effCost=$${(r.totalFeesUsd + r.totalSlipUsd).toFixed(2)}`)
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- ${label}: monthly P&L (Variant ${r.variant}) ---`)
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  console.log('-'.repeat(45))
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Daily Breakout — Binance live model | Variant A vs Variant B')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`Variant A: $500 start | 10 max conc | 10% target margin`)
  console.log(`Variant B: $320 start | 20 max conc |  5% target margin`)
  console.log(`Risk ${RISK_PCT}% | BTC ADX>${BTC_ADX_THRESHOLD} | dedup guards on | EOD-NO-TP1`)
  console.log(`Period: 365d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log()

  console.log('Loading m5 + BTC regime...')
  const btc = await buildBtcRegime()

  const allFull: PortfolioTrade[] = []
  const allTrain: PortfolioTrade[] = []
  const allTest: PortfolioTrade[] = []
  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  for (const sym of PROD_SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    const cfg: BreakoutCfg = { rangeBars: RANGE_BARS, volMultiplier: VOL_MULT, tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2] }
    runLadderRaw(m5, cfg, fullStart, now).forEach(t => allFull.push(toPortfolioTrade(sym, t)))
    runLadderRaw(m5, cfg, fullStart, trainEnd).forEach(t => allTrain.push(toPortfolioTrade(sym, t)))
    runLadderRaw(m5, cfg, trainEnd, now).forEach(t => allTest.push(toPortfolioTrade(sym, t)))
  }

  console.log(`Trade pool: FULL ${allFull.length} | TRAIN ${allTrain.length} | TEST ${allTest.length}`)
  console.log()

  function runBoth(label: string, pool: PortfolioTrade[]) {
    console.log(`================== ${label} ==================`)
    const a = simulate(pool, VARIANTS[0], btc)
    const b = simulate(pool, VARIANTS[1], btc)
    printResult(label, a)
    printResult(label, b)
    console.log()
    return { a, b }
  }

  const full = runBoth('FULL (365d)', allFull)
  const train = runBoth('TRAIN (60%, ~219d)', allTrain)
  const test = runBoth('TEST (40%, ~146d)', allTest)

  // Comparison table
  console.log('================== Summary table ==================')
  function row(label: string, r: SimResult) {
    const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
    console.log(
      `${label.padEnd(15)} | start $${r.startingDeposit.toString().padStart(4)} | final $${r.finalDeposit.toFixed(0).padStart(6)} ` +
      `(${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) | R/tr=${fmtR(r.rPerTr)} | WR=${r.winRate.toFixed(0)}% | ` +
      `peak $${r.peakDeposit.toFixed(0).padStart(5)} | min $${r.minDeposit.toFixed(0).padStart(4)} | DD ${r.maxDD.toFixed(1)}%`
    )
  }
  for (const [label, group] of [['FULL', full], ['TRAIN', train], ['TEST', test]] as const) {
    console.log(`--- ${label} ---`)
    row('Variant A', group.a)
    row('Variant B', group.b)
    console.log()
  }

  // A vs B head-to-head ratio analysis
  console.log('================== Variant A vs B (% return basis) ==================')
  function vs(label: string, a: SimResult, b: SimResult) {
    const retA = ((a.finalDeposit / a.startingDeposit - 1) * 100)
    const retB = ((b.finalDeposit / b.startingDeposit - 1) * 100)
    const winnerByRet = retB > retA ? 'B' : 'A'
    const dRet = Math.abs(retB - retA)
    const ddDiff = b.maxDD - a.maxDD
    console.log(
      `${label.padEnd(6)} | A: ${retA >= 0 ? '+' : ''}${retA.toFixed(0)}% (DD ${a.maxDD.toFixed(1)}%) | ` +
      `B: ${retB >= 0 ? '+' : ''}${retB.toFixed(0)}% (DD ${b.maxDD.toFixed(1)}%) | ` +
      `winner: ${winnerByRet} by ${dRet.toFixed(0)}pp | ` +
      `B's extra DD: ${ddDiff >= 0 ? '+' : ''}${ddDiff.toFixed(1)}pp`
    )
  }
  vs('FULL', full.a, full.b)
  vs('TRAIN', train.a, train.b)
  vs('TEST', test.a, test.b)
  console.log()

  // Risk indicator: did B drop below 50% of starting deposit at any point?
  console.log('================== Variant B risk check ==================')
  function riskCheck(label: string, b: SimResult) {
    const minPct = (b.minDeposit / b.startingDeposit) * 100
    const droppedBelow50 = b.minDeposit < b.startingDeposit * 0.5
    console.log(
      `${label.padEnd(6)} | B min $${b.minDeposit.toFixed(0).padStart(4)} = ${minPct.toFixed(0)}% of start ` +
      `${droppedBelow50 ? '⚠ BELOW 50%' : '✓ stayed above 50%'}`
    )
  }
  riskCheck('FULL', full.b)
  riskCheck('TRAIN', train.b)
  riskCheck('TEST', test.b)
  console.log()

  // Monthly tables
  printMonthly('FULL', full.a)
  console.log()
  printMonthly('FULL', full.b)
  console.log()

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
