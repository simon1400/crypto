/**
 * Daily Breakout — Variant B with "FULL CLOSE ON TP1" exit rule.
 *
 * Rule: close 100% of position when TP1 is hit (instead of the default
 *       50/30/20 ladder with TP1 → BE trailing).
 *       SL handling unchanged (initial SL until TP1 hit; no trailing because
 *       there's nothing to trail — the whole position exits at TP1).
 *
 * Compares against baseline B (default ladder 50/30/20 with full trailing).
 *
 * Identical setup otherwise:
 *   - Universe: 23 PROD symbols
 *   - Period: 365d (FULL / TRAIN 60% / TEST 40%)
 *   - Sizing: $320 start, 20 max conc, 5% target margin, 2% risk
 *   - Filters: BTC ADX>20, dedup carry-over + same-day
 *   - Fees: Binance taker 0.05% / maker 0.02% / slip 0.03%
 *   - Entry: taker market (live formula entry = c.close + slip)
 *   - TP1 fill = maker (limit at TP1, no slip)
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_B_full_tp1.ts
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

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS_BASELINE = [0.5, 0.3, 0.2]

const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20

const VARIANT_B = {
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
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
// Signal generation — same as binance_AB live formula
// ============================================================================

interface RawSignal {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  rangeEdge: number
  sl: number
  tpLadder: number[]
  utcDate: string
}

function generateBreakoutSignalsForSymbol(
  symbol: string,
  m5: OHLCV[],
  periodFrom: number,
  periodTo: number,
): RawSignal[] {
  const sigs: RawSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }
  for (const [, candles] of byDay) {
    if (candles.length < RANGE_BARS + 5) continue
    const rangeBars = candles.slice(0, RANGE_BARS)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue
    let triggered = false
    for (let i = RANGE_BARS; i < candles.length && !triggered; i++) {
      const c = candles[i]
      const start = Math.max(0, i - 24)
      const avgVol = candles.slice(start, i).reduce((s, x) => s + x.volume, 0) / Math.max(1, i - start)
      if (c.volume < avgVol * VOL_MULT) continue
      let side: 'BUY' | 'SELL' | null = null
      let entryPrice = 0
      let anchor = 0
      if (c.high > rangeHigh && c.close > rangeHigh) {
        side = 'BUY'
        entryPrice = c.close
        anchor = rangeHigh
      } else if (c.low < rangeLow && c.close < rangeLow) {
        side = 'SELL'
        entryPrice = c.close
        anchor = rangeLow
      }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [anchor + rangeSize * TP_MULTS[0], anchor + rangeSize * TP_MULTS[1], anchor + rangeSize * TP_MULTS[2]]
        : [anchor - rangeSize * TP_MULTS[0], anchor - rangeSize * TP_MULTS[1], anchor - rangeSize * TP_MULTS[2]]

      const tp1Overshoot = side === 'BUY' ? entryPrice >= tpLadder[0] : entryPrice <= tpLadder[0]
      if (tp1Overshoot) continue

      sigs.push({
        symbol, side, entryTime: c.time, entryPrice,
        rangeEdge: anchor, sl, tpLadder,
        utcDate: utcDateOf(c.time),
      })
      triggered = true
    }
  }
  return sigs
}

// ============================================================================
// Per-trade walker — supports two modes:
//   'baseline': default ladder 50/30/20 with full trailing (TP1→BE, TP2→TP1)
//   'fullTp1':  close 100% on first wick to TP1, no further TPs, no trailing
// ============================================================================

type ExitMode = 'baseline' | 'fullTp1'
type FillKind = 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EOD'

interface TradeFill {
  time: number
  price: number
  frac: number
  kind: FillKind
}

interface SimulatedTrade {
  symbol: string
  utcDate: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
  m5: OHLCV[]
  startIdx: number
}

function walkTradeFills(
  t: SimulatedTrade,
  effectiveEntryPrice: number,
  mode: ExitMode,
): { fills: TradeFill[]; closeTime: number } {
  const isLong = t.side === 'BUY'
  const fills: TradeFill[] = []
  let trailingSL = t.sl
  let nextTpIdx = 0
  let remaining = 1.0

  const splits = mode === 'fullTp1' ? [1.0] : SPLITS_BASELINE
  const ladder = mode === 'fullTp1' ? [t.tpLadder[0]] : t.tpLadder

  const lastIdx = t.m5.length - 1
  let closeTime = t.m5[lastIdx].time

  for (let i = t.startIdx + 1; i <= lastIdx; i++) {
    const c = t.m5[i]

    // 1) SL wick check first
    const slHit = isLong ? c.low <= trailingSL : c.high >= trailingSL
    if (slHit) {
      fills.push({ time: c.time, price: trailingSL, frac: remaining, kind: 'SL' })
      remaining = 0
      closeTime = c.time
      break
    }

    // 2) TP wick checks (same logic as ladderBacktester)
    let tpProgressed = true
    while (tpProgressed && nextTpIdx < ladder.length && remaining > 1e-9) {
      tpProgressed = false
      const tp = ladder[nextTpIdx]
      const wickReached = isLong ? c.high >= tp : c.low <= tp
      if (!wickReached) break
      const isLastTp = nextTpIdx === ladder.length - 1
      const closeBeyond = isLong ? c.close > tp : c.close < tp
      const fill = !closeBeyond || isLastTp
      if (fill) {
        const frac = splits[nextTpIdx] ?? 0
        const actualFrac = Math.min(frac, remaining)
        if (actualFrac > 0) {
          const kind: FillKind = nextTpIdx === 0 ? 'TP1' : nextTpIdx === 1 ? 'TP2' : 'TP3'
          fills.push({ time: c.time, price: tp, frac: actualFrac, kind })
          remaining = Math.max(0, remaining - actualFrac)
          // Trailing only matters when we keep position alive after TP1 → baseline.
          if (mode === 'baseline') {
            if (nextTpIdx === 0) trailingSL = effectiveEntryPrice    // TP1 → BE
            else trailingSL = ladder[nextTpIdx - 1]                   // TPn → TP(n-1)
          }
        }
        nextTpIdx++
        tpProgressed = true
        if (remaining <= 1e-9) {
          closeTime = c.time
          break
        }
      } else {
        nextTpIdx++
        tpProgressed = true
      }
    }
    if (remaining <= 1e-9) break
  }

  // Force-close leftover at last available candle
  if (remaining > 1e-9) {
    const last = t.m5[lastIdx]
    fills.push({ time: last.time, price: last.close, frac: remaining, kind: 'EOD' })
    closeTime = last.time
  }

  return { fills, closeTime }
}

// ============================================================================
// Portfolio simulator
// ============================================================================

interface SimResult {
  label: string
  startingDeposit: number
  signalsTotal: number
  skippedBtcAdx: number
  skippedCarryOver: number
  skippedSameDay: number
  skippedConcurrent: number
  skippedMargin: number
  opened: number
  trades: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
  fillCounts: Record<FillKind, number>
}

function emptyFillCounts(): Record<FillKind, number> {
  return { TP1: 0, TP2: 0, TP3: 0, SL: 0, EOD: 0 }
}

interface SimInput {
  signals: RawSignal[]
  m5BySymbol: Map<string, OHLCV[]>
  btc: BtcRegime
  mode: ExitMode
  label: string
}

function simulate(input: SimInput): SimResult {
  const { signals, m5BySymbol, btc, mode, label } = input
  const sorted = [...signals].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = VARIANT_B.startingDeposit
  let peak = VARIANT_B.startingDeposit
  let trough = VARIANT_B.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0
  const fillCounts = emptyFillCounts()

  interface Active {
    sig: RawSignal
    id: number
    positionSizeUsd: number
    positionUnits: number
    leverage: number
    marginUsd: number
    effectiveEntryPrice: number
    pendingFills: TradeFill[]
    closeTime: number
    statusKey: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
    closedFracPct: number
    realizedPnlUsd: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  let tradesClosed = 0
  let wins = 0
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
      while (a.pendingFills.length > 0 && a.pendingFills[0].time <= t) {
        const f = a.pendingFills.shift()!
        const isLong = a.sig.side === 'BUY'
        const isMaker = f.kind === 'TP1' || f.kind === 'TP2' || f.kind === 'TP3'
        let exitPrice: number
        if (isMaker) {
          exitPrice = f.price
        } else {
          exitPrice = isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP)
        }
        const fillUnits = a.positionUnits * f.frac
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeRate = isMaker ? MAKER_FEE : TAKER_FEE
        const feeUsd = fillNotional * feeRate
        const slipUsd = isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        totalFees += feeUsd
        totalSlip += slipUsd
        a.realizedPnlUsd += netPnl
        a.closedFracPct += f.frac * 100
        if (f.kind === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.kind === 'TP2') a.statusKey = 'TP2_HIT'
        fillCounts[f.kind]++
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.pendingFills.length === 0 || a.closedFracPct >= 99.99) {
        if (a.realizedPnlUsd > 0) wins++
        tradesClosed++
        addMonthly(a.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  for (const sig of sorted) {
    realizeFillsUntil(sig.entryTime)

    if (!btc.isTrending(sig.entryTime)) { skippedBtcAdx++; continue }
    if (active.some(a => a.sig.symbol === sig.symbol && a.sig.utcDate !== sig.utcDate)) {
      skippedCarryOver++; continue
    }
    const key = `${sig.symbol}|${sig.utcDate}`
    if (takenSet.has(key)) { skippedSameDay++; continue }

    const slDist = Math.abs(sig.entryPrice - sig.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= VARIANT_B.maxConcurrent) { skippedConcurrent++; continue }

    const isLong = sig.side === 'BUY'
    const effectiveEntry = isLong
      ? sig.entryPrice * (1 + TAKER_SLIP)
      : sig.entryPrice * (1 - TAKER_SLIP)

    const sizing = computeSizing({
      symbol: sig.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_B.targetMarginPct,
      entry: effectiveEntry, sl: sig.sl,
    })
    if (!sizing) { skippedMargin++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.sig.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: 0,
      hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
      hasTP2: a.statusKey === 'TP2_HIT',
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) { skippedMargin++; continue }
    if (guard.toClose.length > 0) { skippedMargin++; continue }

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFee = entryNotional * TAKER_FEE
    currentDeposit -= entryFee
    totalFees += entryFee
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - sig.entryPrice)
    totalSlip += entrySlip
    applyDD(sig.entryTime)

    const m5 = m5BySymbol.get(sig.symbol)
    if (!m5) { skippedMargin++; continue }
    const startIdx = m5.findIndex(c => c.time === sig.entryTime)
    if (startIdx < 0) { skippedMargin++; continue }

    const simulated: SimulatedTrade = {
      symbol: sig.symbol, utcDate: sig.utcDate, side: sig.side,
      entryTime: sig.entryTime, entryPrice: sig.entryPrice,
      sl: sig.sl, tpLadder: sig.tpLadder, m5, startIdx,
    }
    const { fills, closeTime } = walkTradeFills(simulated, effectiveEntry, mode)

    takenSet.add(key)
    active.push({
      sig, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      effectiveEntryPrice: effectiveEntry,
      pendingFills: fills,
      closeTime,
      statusKey: 'OPEN',
      closedFracPct: 0,
      realizedPnlUsd: 0,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedPnlUsd > 0) wins++
    tradesClosed++
  }

  return {
    label,
    startingDeposit: VARIANT_B.startingDeposit,
    signalsTotal: signals.length,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: tradesClosed,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: tradesClosed > 0 ? (wins / tradesClosed) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
    fillCounts,
  }
}

// ============================================================================
// Output
// ============================================================================

function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(period: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${period} | ${r.label} ($${r.startingDeposit} start) ---`)
  console.log(
    `signals=${r.signalsTotal} | ` +
    `skip btcAdx=${r.skippedBtcAdx} carryOver=${r.skippedCarryOver} sameDay=${r.skippedSameDay} ` +
    `conc=${r.skippedConcurrent} margin=${r.skippedMargin} | opened=${r.opened} trades=${r.trades}`
  )
  console.log(
    `final=$${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) ` +
    `peak=$${r.peakDeposit.toFixed(0)} min=$${r.minDeposit.toFixed(0)} DD=${r.maxDD.toFixed(1)}% WR=${r.winRate.toFixed(0)}%`
  )
  console.log(
    `fills: TP1=${r.fillCounts.TP1} TP2=${r.fillCounts.TP2} TP3=${r.fillCounts.TP3} ` +
    `SL=${r.fillCounts.SL} EOD=${r.fillCounts.EOD}`
  )
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)} effCost=$${(r.totalFeesUsd + r.totalSlipUsd).toFixed(2)}`)
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- monthly P&L (${label}) ---`)
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  console.log('-'.repeat(45))
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Daily Breakout — Variant B with FULL CLOSE ON TP1')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`Variant B: $${VARIANT_B.startingDeposit} start | ${VARIANT_B.maxConcurrent} max conc | ${VARIANT_B.targetMarginPct}% target margin`)
  console.log(`Risk ${RISK_PCT}% | BTC ADX>${BTC_ADX_THRESHOLD} | dedup guards on`)
  console.log(`Period: ${DAYS_BACK}d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log()

  console.log('Loading m5 + BTC regime...')
  const btc = await buildBtcRegime()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const m5BySymbol = new Map<string, OHLCV[]>()
  for (const sym of PROD_SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    m5BySymbol.set(sym, m5)
  }
  console.log(`Loaded m5 for ${m5BySymbol.size} symbols`)

  function buildSignals(periodFrom: number, periodTo: number): RawSignal[] {
    const all: RawSignal[] = []
    for (const [sym, m5] of m5BySymbol.entries()) {
      generateBreakoutSignalsForSymbol(sym, m5, periodFrom, periodTo).forEach(s => all.push(s))
    }
    return all
  }
  const sigsFull = buildSignals(fullStart, now)
  const sigsTrain = buildSignals(fullStart, trainEnd)
  const sigsTest = buildSignals(trainEnd, now)
  console.log(`Signal pool: FULL ${sigsFull.length} | TRAIN ${sigsTrain.length} | TEST ${sigsTest.length}`)
  console.log()

  function runBoth(period: string, sigs: RawSignal[]) {
    console.log(`================== ${period} ==================`)
    const baseline = simulate({
      signals: sigs, m5BySymbol, btc,
      mode: 'baseline',
      label: 'B baseline (50/30/20 ladder, full trailing)',
    })
    const fullTp1 = simulate({
      signals: sigs, m5BySymbol, btc,
      mode: 'fullTp1',
      label: 'B full close @ TP1',
    })
    printResult(period, baseline)
    console.log()
    printResult(period, fullTp1)
    console.log()
    return { baseline, fullTp1 }
  }

  const full = runBoth('FULL (365d)', sigsFull)
  const train = runBoth('TRAIN (60%, ~219d)', sigsTrain)
  const test = runBoth('TEST (40%, ~146d)', sigsTest)

  console.log('================== Δ baseline → full close @ TP1 ==================')
  function delta(label: string, b: SimResult, e: SimResult) {
    const retB = ((b.finalDeposit / b.startingDeposit - 1) * 100)
    const retE = ((e.finalDeposit / e.startingDeposit - 1) * 100)
    console.log(
      `${label.padEnd(8)} | trades ${b.trades}→${e.trades} | ` +
      `final $${b.finalDeposit.toFixed(0)}→$${e.finalDeposit.toFixed(0)} ` +
      `(${retB.toFixed(0)}%→${retE.toFixed(0)}% Δ${(retE - retB >= 0 ? '+' : '')}${(retE - retB).toFixed(0)}pp) | ` +
      `WR ${b.winRate.toFixed(0)}→${e.winRate.toFixed(0)}% | ` +
      `DD ${b.maxDD.toFixed(1)}→${e.maxDD.toFixed(1)}%`
    )
  }
  delta('FULL', full.baseline, full.fullTp1)
  delta('TRAIN', train.baseline, train.fullTp1)
  delta('TEST', test.baseline, test.fullTp1)
  console.log()

  console.log('================== Risk check (full-TP1 variant) ==================')
  function risk(label: string, r: SimResult) {
    const minPct = (r.minDeposit / r.startingDeposit) * 100
    const flag = r.minDeposit < r.startingDeposit * 0.5 ? '⚠ BELOW 50%' : '✓ stayed above 50%'
    console.log(`${label.padEnd(8)} | min $${r.minDeposit.toFixed(0)} = ${minPct.toFixed(0)}% of start  ${flag}`)
  }
  risk('FULL', full.fullTp1)
  risk('TRAIN', train.fullTp1)
  risk('TEST', test.fullTp1)
  console.log()

  printMonthly('FULL baseline', full.baseline)
  console.log()
  printMonthly('FULL full-TP1', full.fullTp1)
  console.log()

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
