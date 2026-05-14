/**
 * Variant C — geometry × universe × exit sweep.
 *
 * 3 одновременных гипотезы:
 *   1. TP = midpoint range (reverse-TP вместо ladder) — гипотеза что wick-fills
 *      статистически возвращаются в range, а не продолжают пробой
 *   2. Buffer geometry — limit НЕ на rangeEdge, а внутри range на buffer × rangeSize.
 *      Идея: фильтровать wick-noise, ловить только "честные" касания
 *   3. Universe — top-5 / top-10 majors вместо 23 prod монет.
 *      Идея: low-cap altcoins имеют шумный wick-behavior
 *
 * Sweep:
 *   - buffer ∈ {0 (rangeEdge baseline), 0.1, 0.15, 0.2} × rangeSize
 *   - universe ∈ {top5, top10}
 *   - exit ∈ {reverseTP_midpoint, currentLadder}
 * = 16 сценариев × FULL+TRAIN+TEST.
 *
 * Fill logic: prod C (любое касание = fill) — буфер сдвигает limit price.
 * SL: всегда на противоположной грани range (rangeLow для BUY, rangeHigh для SELL).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_C_geometry_universe.ts
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
const MIN_SL_DIST_PCT = 0.4
const MAX_HOLD_BARS = 288  // 24h EOD

const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const UNIVERSE_TOP5 = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT']
const UNIVERSE_TOP10 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'POLUSDT',
]

const VARIANT_C = {
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

type ExitMode = 'reverseTP_midpoint' | 'currentLadder'
const BUFFER_LEVELS = [0, 0.1, 0.15, 0.2]
const TP_LADDER_MULTS = [1.0, 2.0, 3.0]  // для currentLadder
const SPLITS = [0.5, 0.3, 0.2]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ============================================================================
// BTC ADX
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
      time: t, open: bars[0].open,
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
  const plusDM: number[] = [0], minusDM: number[] = [0]
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
    tr.push(Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)))
  }
  const trEma = ema(tr, period), plusEma = ema(plusDM, period), minusEma = ema(minusDM, period)
  const dx: number[] = []
  for (let i = 0; i < n; i++) {
    const plusDI = trEma[i] > 0 ? (plusEma[i] / trEma[i]) * 100 : 0
    const minusDI = trEma[i] > 0 ? (minusEma[i] / trEma[i]) * 100 : 0
    const denom = plusDI + minusDI
    dx.push(denom > 0 ? (Math.abs(plusDI - minusDI) / denom) * 100 : 0)
  }
  return ema(dx, period)
}

interface BtcRegime { isTrending(ms: number): boolean }

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
// Fill detection — параметризованный buffer
// ============================================================================

interface CFill {
  symbol: string
  utcDate: string
  side: 'BUY' | 'SELL'
  entryPrice: number     // rangeEdge ± buffer × rangeSize
  sl: number             // всегда opposite range edge
  entryTime: number
  entryIdx: number
  rangeHigh: number
  rangeLow: number
  rangeMidpoint: number
  gapFill: boolean
}

/**
 * buffer = 0 → limits на rangeEdge (как в prod)
 * buffer = 0.1 → BUY limit на rangeHigh - 0.1×rangeSize, SELL на rangeLow + 0.1×rangeSize
 * Это сдвигает entry ВНУТРЬ range — фильтрует wick-noise, но даёт меньший R/profit
 * (т.к. SL дальше относительно entry).
 */
function generateFills(
  m5: OHLCV[],
  periodFrom: number, periodTo: number,
  symbol: string,
  bufferFrac: number,
): CFill[] {
  const fills: CFill[] = []
  const byDay = new Map<string, { candles: OHLCV[]; startIdx: number }>()
  for (let i = 0; i < m5.length; i++) {
    const c = m5[i]
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, { candles: [], startIdx: i })
    byDay.get(d)!.candles.push(c)
  }

  for (const [date, { candles, startIdx }] of byDay) {
    if (candles.length < RANGE_BARS + 1) continue
    const rangeBars = candles.slice(0, RANGE_BARS)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue
    const slDistPct = (rangeSize / Math.min(rangeHigh, rangeLow)) * 100
    if (slDistPct < MIN_SL_DIST_PCT) continue

    const buyLimit = rangeHigh - bufferFrac * rangeSize
    const sellLimit = rangeLow + bufferFrac * rangeSize
    const rangeMidpoint = (rangeHigh + rangeLow) / 2

    // Sanity: buffer не должен делать limit'ы пересекающимися (>=0.5 фрак)
    if (buyLimit <= sellLimit) continue

    const placementBar = candles[RANGE_BARS - 1]
    const livePrice = placementBar.close
    // Pre-emptive guard: livePrice не должен уже быть за limit'ом
    const canPlaceBuy = livePrice <= buyLimit
    const canPlaceSell = livePrice >= sellLimit
    if (!canPlaceBuy && !canPlaceSell) continue

    let buyFillIdx = -1, sellFillIdx = -1
    for (let i = RANGE_BARS; i < candles.length; i++) {
      const c = candles[i]
      if (canPlaceBuy && buyFillIdx < 0 && c.high >= buyLimit) buyFillIdx = i
      if (canPlaceSell && sellFillIdx < 0 && c.low <= sellLimit) sellFillIdx = i
      if (buyFillIdx >= 0 && sellFillIdx >= 0) break
    }

    let winningSide: 'BUY' | 'SELL' | null = null
    let winningIdx = -1
    if (buyFillIdx >= 0 && sellFillIdx >= 0) {
      if (buyFillIdx <= sellFillIdx) { winningSide = 'BUY'; winningIdx = buyFillIdx }
      else { winningSide = 'SELL'; winningIdx = sellFillIdx }
    } else if (buyFillIdx >= 0) { winningSide = 'BUY'; winningIdx = buyFillIdx }
    else if (sellFillIdx >= 0) { winningSide = 'SELL'; winningIdx = sellFillIdx }
    if (!winningSide) continue

    const fillCandle = candles[winningIdx]
    const limitPrice = winningSide === 'BUY' ? buyLimit : sellLimit
    let fillPrice: number, gapFill = false
    if (winningSide === 'BUY') {
      if (fillCandle.open > limitPrice) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = limitPrice
    } else {
      if (fillCandle.open < limitPrice) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = limitPrice
    }

    fills.push({
      symbol, utcDate: date, side: winningSide,
      entryPrice: fillPrice,
      sl: winningSide === 'BUY' ? rangeLow : rangeHigh,
      entryTime: fillCandle.time,
      entryIdx: startIdx + winningIdx,
      rangeHigh, rangeLow, rangeMidpoint,
      gapFill,
    })
  }
  return fills
}

// ============================================================================
// Exit simulator — 2 режима
// ============================================================================

interface ExitFill {
  time: number
  price: number
  percent: number
  reason: 'TP' | 'TP1' | 'TP2' | 'TP3' | 'TRAIL_SL' | 'SL' | 'EOD'
  isMaker: boolean
}

interface ExitResult {
  fills: ExitFill[]
  closeTime: number
}

function simulateReverseTP(symbolCandles: OHLCV[], fill: CFill): ExitResult {
  const isLong = fill.side === 'BUY'
  const tpPrice = fill.rangeMidpoint
  const sl = fill.sl

  // Sanity: TP должен быть в правильную сторону от entry
  if (isLong && tpPrice <= fill.entryPrice) {
    return { fills: [{ time: fill.entryTime, price: fill.entryPrice, percent: 100, reason: 'TP', isMaker: false }], closeTime: fill.entryTime }
  }
  if (!isLong && tpPrice >= fill.entryPrice) {
    return { fills: [{ time: fill.entryTime, price: fill.entryPrice, percent: 100, reason: 'TP', isMaker: false }], closeTime: fill.entryTime }
  }

  const startIdx = fill.entryIdx + 1
  const endIdx = Math.min(symbolCandles.length, startIdx + MAX_HOLD_BARS)

  for (let i = startIdx; i < endIdx; i++) {
    const c = symbolCandles[i]
    if (!c) break
    const slHit = isLong ? c.low <= sl : c.high >= sl
    const tpReached = isLong ? c.high >= tpPrice : c.low <= tpPrice
    if (slHit && !tpReached) {
      return { fills: [{ time: c.time, price: sl, percent: 100, reason: 'SL', isMaker: false }], closeTime: c.time }
    }
    if (tpReached) {
      return { fills: [{ time: c.time, price: tpPrice, percent: 100, reason: 'TP', isMaker: true }], closeTime: c.time }
    }
  }

  const lastIdx = Math.min(endIdx - 1, symbolCandles.length - 1)
  if (lastIdx >= startIdx) {
    const lastBar = symbolCandles[lastIdx]
    return { fills: [{ time: lastBar.time, price: lastBar.close, percent: 100, reason: 'EOD', isMaker: false }], closeTime: lastBar.time }
  }
  return { fills: [], closeTime: fill.entryTime }
}

/**
 * currentLadder: воспроизводит prod-логику ladder.
 * TP1=anchor + 1×rangeSize (BUY) или anchor - 1×rangeSize (SELL), где anchor = rangeEdge
 * Splits 50/30/20. Trailing: после TP1→SL=entry, после TP2→SL=TP1.
 */
function simulateCurrentLadder(symbolCandles: OHLCV[], fill: CFill): ExitResult {
  const isLong = fill.side === 'BUY'
  const rangeSize = fill.rangeHigh - fill.rangeLow
  // Anchor = rangeEdge (как в prod engine), не entry
  const anchor = isLong ? fill.rangeHigh : fill.rangeLow
  const tp1 = isLong ? anchor + TP_LADDER_MULTS[0] * rangeSize : anchor - TP_LADDER_MULTS[0] * rangeSize
  const tp2 = isLong ? anchor + TP_LADDER_MULTS[1] * rangeSize : anchor - TP_LADDER_MULTS[1] * rangeSize
  const tp3 = isLong ? anchor + TP_LADDER_MULTS[2] * rangeSize : anchor - TP_LADDER_MULTS[2] * rangeSize
  const tps = [tp1, tp2, tp3]

  let nextTpIdx = 0
  let currentSL = fill.sl
  let remainingPct = 100
  const exitFills: ExitFill[] = []
  const startIdx = fill.entryIdx + 1
  const endIdx = Math.min(symbolCandles.length, startIdx + MAX_HOLD_BARS)

  for (let i = startIdx; i < endIdx; i++) {
    const c = symbolCandles[i]
    if (!c) break
    // SL first
    const slHit = isLong ? c.low <= currentSL : c.high >= currentSL
    if (slHit) {
      const reason: ExitFill['reason'] = nextTpIdx === 0 ? 'SL' : 'TRAIL_SL'
      exitFills.push({ time: c.time, price: currentSL, percent: remainingPct, reason, isMaker: false })
      return { fills: exitFills, closeTime: c.time }
    }
    // TP check (wick mode — wick может пробить TP без close)
    while (nextTpIdx < tps.length) {
      const tp = tps[nextTpIdx]
      const tpReached = isLong ? c.high >= tp : c.low <= tp
      if (!tpReached) break
      // Hit this TP
      const split = SPLITS[nextTpIdx] * 100
      const closePct = Math.min(split, remainingPct)
      exitFills.push({
        time: c.time, price: tp, percent: closePct,
        reason: (`TP${nextTpIdx + 1}`) as ExitFill['reason'], isMaker: true,
      })
      remainingPct -= closePct
      // Trail SL
      if (nextTpIdx === 0) currentSL = fill.entryPrice  // → BE
      else if (nextTpIdx === 1) currentSL = tp1
      else if (nextTpIdx === 2) currentSL = tp2
      nextTpIdx++
      if (remainingPct <= 0.01) return { fills: exitFills, closeTime: c.time }
    }
  }

  // EOD
  const lastIdx = Math.min(endIdx - 1, symbolCandles.length - 1)
  if (lastIdx >= startIdx && remainingPct > 0) {
    const lastBar = symbolCandles[lastIdx]
    exitFills.push({ time: lastBar.time, price: lastBar.close, percent: remainingPct, reason: 'EOD', isMaker: false })
    return { fills: exitFills, closeTime: lastBar.time }
  }
  return { fills: exitFills, closeTime: exitFills[exitFills.length - 1]?.time ?? fill.entryTime }
}

function simulateExit(symbolCandles: OHLCV[], fill: CFill, mode: ExitMode): ExitResult {
  if (mode === 'reverseTP_midpoint') return simulateReverseTP(symbolCandles, fill)
  return simulateCurrentLadder(symbolCandles, fill)
}

// ============================================================================
// Portfolio simulator
// ============================================================================

interface PortfolioTrade {
  fill: CFill
  exit: ExitResult
}

interface SimResult {
  scenario: string
  startingDeposit: number
  signalsTotal: number
  skippedBtcAdx: number
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

function simulate(allTrades: PortfolioTrade[], btc: BtcRegime, scenarioLabel: string): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.fill.entryTime - b.fill.entryTime)
  let currentDeposit = VARIANT_C.startingDeposit
  let peak = VARIANT_C.startingDeposit
  let trough = VARIANT_C.startingDeposit
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
  let skippedBtcAdx = 0, skippedConcurrent = 0, skippedMargin = 0
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
      while (a.fillsApplied < a.pt.exit.fills.length && a.pt.exit.fills[a.fillsApplied].time <= t) {
        const f = a.pt.exit.fills[a.fillsApplied]
        a.fillsApplied++
        const isLong = a.pt.fill.side === 'BUY'
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
        const slDist = Math.abs(a.pt.fill.entryPrice - a.pt.fill.sl)
        const rContrib = ((isLong ? f.price - a.pt.fill.entryPrice : a.pt.fill.entryPrice - f.price) / slDist) * (f.percent / 100)
        a.realizedR += rContrib
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        addMonthly(a.pt.exit.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.fill.entryTime)
    if (!btc.isTrending(pt.fill.entryTime)) { skippedBtcAdx++; continue }
    if (active.some(a => a.pt.fill.symbol === pt.fill.symbol && a.pt.fill.utcDate !== pt.fill.utcDate)) continue
    const key = `${pt.fill.symbol}|${pt.fill.utcDate}`
    if (takenSet.has(key)) continue
    const slDist = Math.abs(pt.fill.entryPrice - pt.fill.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= VARIANT_C.maxConcurrent) { skippedConcurrent++; continue }

    const isLong = pt.fill.side === 'BUY'
    const entryIsMaker = !pt.fill.gapFill
    const effectiveEntry = entryIsMaker
      ? pt.fill.entryPrice
      : (isLong ? pt.fill.entryPrice * (1 + TAKER_SLIP) : pt.fill.entryPrice * (1 - TAKER_SLIP))

    const sizing = computeSizing({
      symbol: pt.fill.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_C.targetMarginPct,
      entry: effectiveEntry, sl: pt.fill.sl,
    })
    if (!sizing) { skippedMargin++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.fill.symbol, status: a.statusKey,
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

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFeeRate = entryIsMaker ? MAKER_FEE : TAKER_FEE
    const entryFee = entryNotional * entryFeeRate
    currentDeposit -= entryFee
    totalFees += entryFee
    if (!entryIsMaker) totalSlip += sizing.positionUnits * Math.abs(effectiveEntry - pt.fill.entryPrice)
    applyDD(pt.fill.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      effectiveEntryPrice: effectiveEntry,
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
    scenario: scenarioLabel,
    startingDeposit: VARIANT_C.startingDeposit,
    signalsTotal: allTrades.length,
    skippedBtcAdx, skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

// ============================================================================
// Main
// ============================================================================

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }

function rowFor(scenario: string, r: SimResult): string {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  return `${scenario.padEnd(46)} | trades=${r.trades.toString().padStart(4)} | R/tr=${fmtR(r.rPerTr).padStart(6)} | WR=${r.winRate.toFixed(0).padStart(2)}% | final $${r.finalDeposit.toFixed(0).padStart(7)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0).padStart(5)}%) | DD ${r.maxDD.toFixed(1).padStart(4)}%`
}

async function main() {
  console.log('Daily Breakout — Variant C: geometry × universe × exit sweep')
  console.log(`Buffer levels: ${BUFFER_LEVELS.join(', ')} × rangeSize`)
  console.log(`Exit modes: reverseTP_midpoint, currentLadder`)
  console.log(`Universes: top5 (${UNIVERSE_TOP5.length}), top10 (${UNIVERSE_TOP10.length})`)
  console.log(`Variant: $${VARIANT_C.startingDeposit} | ${VARIANT_C.maxConcurrent} conc | ${VARIANT_C.targetMarginPct}% margin | ${RISK_PCT}% risk`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading BTC regime...')
  const btc = await buildBtcRegime()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const allSymbols = [...new Set([...UNIVERSE_TOP5, ...UNIVERSE_TOP10])]
  console.log(`Loading m5 candles for ${allSymbols.length} symbols...`)
  const m5BySymbol = new Map<string, OHLCV[]>()
  for (const sym of allSymbols) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    m5BySymbol.set(sym, m5)
  }
  console.log(`Loaded ${m5BySymbol.size}\n`)

  type ScenarioKey = string
  type Group = { full: SimResult; train: SimResult; test: SimResult }
  const allResults = new Map<ScenarioKey, Group>()

  const universes: Array<{ name: 'top5' | 'top10'; symbols: string[] }> = [
    { name: 'top5', symbols: UNIVERSE_TOP5 },
    { name: 'top10', symbols: UNIVERSE_TOP10 },
  ]
  const exitModes: ExitMode[] = ['reverseTP_midpoint', 'currentLadder']

  for (const universe of universes) {
    const presentSymbols = universe.symbols.filter(s => m5BySymbol.has(s))
    if (presentSymbols.length === 0) { console.warn(`No symbols for ${universe.name}`); continue }
    for (const buffer of BUFFER_LEVELS) {
      // Generate fills once per (universe, buffer)
      const fillsFull: CFill[] = []
      const fillsTrain: CFill[] = []
      const fillsTest: CFill[] = []
      for (const sym of presentSymbols) {
        const m5 = m5BySymbol.get(sym)!
        fillsFull.push(...generateFills(m5, fullStart, now, sym, buffer))
        fillsTrain.push(...generateFills(m5, fullStart, trainEnd, sym, buffer))
        fillsTest.push(...generateFills(m5, trainEnd, now, sym, buffer))
      }

      for (const exitMode of exitModes) {
        const label = `${universe.name}_buf${buffer}_${exitMode}`
        console.log(`=== ${label} (fills: F=${fillsFull.length} T=${fillsTrain.length} V=${fillsTest.length}) ===`)
        const buildTrades = (fills: CFill[]) => fills.map(f => ({
          fill: f, exit: simulateExit(m5BySymbol.get(f.symbol)!, f, exitMode),
        }))
        const full = simulate(buildTrades(fillsFull), btc, label)
        const train = simulate(buildTrades(fillsTrain), btc, label)
        const test = simulate(buildTrades(fillsTest), btc, label)
        console.log(rowFor(`${label} FULL`, full))
        console.log(rowFor(`${label} TRAIN`, train))
        console.log(rowFor(`${label} TEST`, test))
        console.log()
        allResults.set(label, { full, train, test })
      }
    }
  }

  // Summary sorted by FULL final
  console.log('================== Summary (sorted by FULL final $) ==================')
  const sorted = [...allResults.entries()].sort((a, b) => b[1].full.finalDeposit - a[1].full.finalDeposit)
  for (const [key, g] of sorted) {
    console.log(rowFor(`${key} FULL`, g.full))
    console.log(rowFor(`${key} TRAIN`, g.train))
    console.log(rowFor(`${key} TEST`, g.test))
    console.log()
  }

  // Best by TEST
  console.log('================== Top-5 by TEST (out-of-sample) ==================')
  const byTest = [...allResults.entries()].sort((a, b) => b[1].test.finalDeposit - a[1].test.finalDeposit)
  for (const [key, g] of byTest.slice(0, 5)) {
    console.log(rowFor(`${key} TEST`, g.test))
  }

  // Robust: positive on both TRAIN and TEST
  console.log('\n================== Robust (positive on BOTH TRAIN+TEST) ==================')
  let foundRobust = 0
  for (const [key, g] of allResults.entries()) {
    const trainRet = g.train.finalDeposit / g.train.startingDeposit
    const testRet = g.test.finalDeposit / g.test.startingDeposit
    if (trainRet > 1.0 && testRet > 1.0) {
      console.log(`✓ ${key}: TRAIN $${g.train.finalDeposit.toFixed(0)} (+${((trainRet - 1) * 100).toFixed(0)}%) | TEST $${g.test.finalDeposit.toFixed(0)} (+${((testRet - 1) * 100).toFixed(0)}%) | DD ${g.full.maxDD.toFixed(0)}%`)
      foundRobust++
    }
  }
  if (foundRobust === 0) console.log('(none — no scenario is profitable on both TRAIN and TEST)')

  // Save
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `dailybreak_C_geometry_universe_${Date.now()}.json`)
  const serializable: any = {}
  for (const [k, g] of allResults.entries()) {
    serializable[k] = {
      full: { ...g.full, monthly: Object.fromEntries(g.full.monthly) },
      train: { ...g.train, monthly: Object.fromEntries(g.train.monthly) },
      test: { ...g.test, monthly: Object.fromEntries(g.test.monthly) },
    }
  }
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    universes, exitModes, bufferLevels: BUFFER_LEVELS,
    variant: VARIANT_C,
    fees: { taker: TAKER_FEE, maker: MAKER_FEE, slip: TAKER_SLIP },
    results: serializable,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
