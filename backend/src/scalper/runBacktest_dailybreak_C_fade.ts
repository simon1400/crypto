/**
 * Variant C — FADE (mean reversion on range edges) sweep.
 *
 * Концептуальная разворачивающая гипотеза:
 *   - Прежний C: BUY @ rangeHigh ожидая пробой вверх (breakout trader)
 *   - FADE C: SELL @ rangeHigh ожидая возврат в range (mean reversion trader)
 *
 * Геометрия FADE:
 *   - Touch на rangeHigh (или rangeHigh - buffer×rS если buffer>0) → SELL
 *     SL = rangeHigh + slBuffer × rangeSize (за пробоем)
 *     TP = midpoint range = (rangeHigh + rangeLow) / 2
 *   - Touch на rangeLow → BUY (симметрично)
 *
 * Sweep:
 *   - buffer ∈ {0, 0.05, 0.1, 0.15} × rangeSize (где ставить limit относительно edge)
 *   - slBuffer ∈ {0.2, 0.3, 0.5} × rangeSize (как далеко SL за пробоем)
 *   - universe ∈ {top5, top10}
 * = 24 сценария × FULL+TRAIN+TEST
 *
 * Логика:
 *   buffer=0 + slBuf=0.3 → SELL @ rangeHigh, SL @ rangeHigh+0.3×rS, TP @ midpoint
 *     R при TP = (rangeHigh - midpoint) / (SL - rangeHigh) = 0.5×rS / 0.3×rS = ~1.67R
 *   buffer=0.1 + slBuf=0.3 → SELL @ rangeHigh-0.1×rS, SL @ rangeHigh+0.3×rS, TP @ midpoint
 *     R при TP = (entry - midpoint) / (SL - entry) = 0.4×rS / 0.4×rS = 1.0R
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_C_fade.ts
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
const MIN_RANGE_SIZE_PCT = 0.4
const MAX_HOLD_BARS = 288

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

const BUFFER_LEVELS = [0, 0.05, 0.1, 0.15]
const SL_BUFFER_LEVELS = [0.2, 0.3, 0.5]

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
// FADE Fill detection
// ============================================================================

interface FadeFill {
  symbol: string
  utcDate: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  sl: number
  tp: number
  entryTime: number
  entryIdx: number
}

/**
 * FADE логика:
 *   BUY-fade: касание rangeLow (или rangeLow + buffer×rS) → BUY (мы fade пробой вниз).
 *     SL = rangeLow - slBufFrac × rS (за пробоем вниз)
 *     TP = midpoint
 *   SELL-fade: касание rangeHigh (или rangeHigh - buffer×rS) → SELL (мы fade пробой вверх).
 *     SL = rangeHigh + slBufFrac × rS
 *     TP = midpoint
 */
function generateFadeFills(
  m5: OHLCV[],
  periodFrom: number, periodTo: number,
  symbol: string,
  bufferFrac: number,
  slBufFrac: number,
): FadeFill[] {
  const fills: FadeFill[] = []
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
    const rangeSizePct = (rangeSize / Math.min(rangeHigh, rangeLow)) * 100
    if (rangeSizePct < MIN_RANGE_SIZE_PCT) continue

    // FADE limits — внутри range на buffer×rS
    const sellLimit = rangeHigh - bufferFrac * rangeSize   // SELL fade entry
    const buyLimit = rangeLow + bufferFrac * rangeSize     // BUY fade entry
    const sellSL = rangeHigh + slBufFrac * rangeSize
    const buySL = rangeLow - slBufFrac * rangeSize
    const tp = (rangeHigh + rangeLow) / 2

    if (sellLimit <= buyLimit) continue  // buffer слишком велик
    if (tp <= buyLimit || tp >= sellLimit) continue  // TP должен быть в правильную сторону

    // Pre-emptive placement guard (как в prod)
    const placementBar = candles[RANGE_BARS - 1]
    const livePrice = placementBar.close
    // Для SELL fade — livePrice должен быть НИЖЕ sellLimit (иначе уже за уровнем для входа)
    // НО ВНИМАНИЕ: для fade-режима, если livePrice уже выше sellLimit, это уже хорошее место для SELL fade — оно даже лучше! Но мы не можем выставить limit на пройденную цену.
    // Используем: limit SELL ставим если livePrice <= sellLimit (тогда price должна вырасти к нему).
    const canPlaceSell = livePrice <= sellLimit
    const canPlaceBuy = livePrice >= buyLimit
    if (!canPlaceSell && !canPlaceBuy) continue

    let sellFillIdx = -1, buyFillIdx = -1
    for (let i = RANGE_BARS; i < candles.length; i++) {
      const c = candles[i]
      // SELL fade fills when high reaches sellLimit
      if (canPlaceSell && sellFillIdx < 0 && c.high >= sellLimit) sellFillIdx = i
      // BUY fade fills when low reaches buyLimit
      if (canPlaceBuy && buyFillIdx < 0 && c.low <= buyLimit) buyFillIdx = i
      if (sellFillIdx >= 0 && buyFillIdx >= 0) break
    }

    let winningSide: 'BUY' | 'SELL' | null = null
    let winningIdx = -1
    if (sellFillIdx >= 0 && buyFillIdx >= 0) {
      if (sellFillIdx <= buyFillIdx) { winningSide = 'SELL'; winningIdx = sellFillIdx }
      else { winningSide = 'BUY'; winningIdx = buyFillIdx }
    } else if (sellFillIdx >= 0) { winningSide = 'SELL'; winningIdx = sellFillIdx }
    else if (buyFillIdx >= 0) { winningSide = 'BUY'; winningIdx = buyFillIdx }
    if (!winningSide) continue

    const limitPrice = winningSide === 'SELL' ? sellLimit : buyLimit
    fills.push({
      symbol, utcDate: date, side: winningSide,
      entryPrice: limitPrice,
      sl: winningSide === 'SELL' ? sellSL : buySL,
      tp,
      entryTime: candles[winningIdx].time,
      entryIdx: startIdx + winningIdx,
    })
  }
  return fills
}

// ============================================================================
// Exit simulator — simple TP/SL
// ============================================================================

interface ExitFill {
  time: number
  price: number
  percent: number
  reason: 'TP' | 'SL' | 'EOD'
  isMaker: boolean
}

interface ExitResult { fills: ExitFill[]; closeTime: number }

function simulateExit(symbolCandles: OHLCV[], fill: FadeFill): ExitResult {
  const isLong = fill.side === 'BUY'
  const tp = fill.tp
  const sl = fill.sl
  const startIdx = fill.entryIdx + 1
  const endIdx = Math.min(symbolCandles.length, startIdx + MAX_HOLD_BARS)

  for (let i = startIdx; i < endIdx; i++) {
    const c = symbolCandles[i]
    if (!c) break
    const slHit = isLong ? c.low <= sl : c.high >= sl
    const tpReached = isLong ? c.high >= tp : c.low <= tp
    // Conservative: если оба triggered на одной свече — считаем SL первым
    if (slHit && !tpReached) {
      return { fills: [{ time: c.time, price: sl, percent: 100, reason: 'SL', isMaker: false }], closeTime: c.time }
    }
    if (slHit && tpReached) {
      // Both hit — pessimistic assume SL first
      return { fills: [{ time: c.time, price: sl, percent: 100, reason: 'SL', isMaker: false }], closeTime: c.time }
    }
    if (tpReached) {
      return { fills: [{ time: c.time, price: tp, percent: 100, reason: 'TP', isMaker: true }], closeTime: c.time }
    }
  }
  const lastIdx = Math.min(endIdx - 1, symbolCandles.length - 1)
  if (lastIdx >= startIdx) {
    const lastBar = symbolCandles[lastIdx]
    return { fills: [{ time: lastBar.time, price: lastBar.close, percent: 100, reason: 'EOD', isMaker: false }], closeTime: lastBar.time }
  }
  return { fills: [], closeTime: fill.entryTime }
}

// ============================================================================
// Portfolio simulator
// ============================================================================

interface PortfolioTrade { fill: FadeFill; exit: ExitResult }

interface SimResult {
  scenario: string
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
  tpRate: number
  slRate: number
  eodRate: number
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
    realizedR: number
    effectiveEntryPrice: number
    riskUsd: number
    closedFracPct: number
    fillsApplied: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  const fullyClosed: { pt: PortfolioTrade; r: number; reason: 'TP' | 'SL' | 'EOD' }[] = []
  let wins = 0, tpHits = 0, slHits = 0, eodHits = 0, totalR = 0
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
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        const lastFill = a.pt.exit.fills[a.pt.exit.fills.length - 1]
        const reason = (lastFill?.reason ?? 'EOD') as 'TP' | 'SL' | 'EOD'
        if (a.realizedR > 0) wins++
        if (reason === 'TP') tpHits++
        else if (reason === 'SL') slHits++
        else eodHits++
        totalR += a.realizedR
        fullyClosed.push({ pt: a.pt, r: a.realizedR, reason })
        addMonthly(a.pt.exit.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.fill.entryTime)
    if (!btc.isTrending(pt.fill.entryTime)) continue
    if (active.some(a => a.pt.fill.symbol === pt.fill.symbol && a.pt.fill.utcDate !== pt.fill.utcDate)) continue
    const key = `${pt.fill.symbol}|${pt.fill.utcDate}`
    if (takenSet.has(key)) continue
    const slDist = Math.abs(pt.fill.entryPrice - pt.fill.sl)
    if (slDist <= 0 || currentDeposit <= 0) continue
    if (active.length >= VARIANT_C.maxConcurrent) continue

    const effectiveEntry = pt.fill.entryPrice   // limit maker — без slip
    const sizing = computeSizing({
      symbol: pt.fill.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_C.targetMarginPct,
      entry: effectiveEntry, sl: pt.fill.sl,
    })
    if (!sizing) continue

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.fill.symbol, status: 'OPEN',
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: false, hasTP2: false,
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFee = entryNotional * MAKER_FEE   // limit = maker
    currentDeposit -= entryFee
    totalFees += entryFee
    applyDD(pt.fill.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      realizedR: 0, effectiveEntryPrice: effectiveEntry,
      riskUsd: sizing.riskUsd,
      closedFracPct: 0, fillsApplied: 0,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push({ pt: a.pt, r: a.realizedR, reason: 'EOD' })
    eodHits++
  }

  const tradeCount = fullyClosed.length
  return {
    scenario: scenarioLabel,
    startingDeposit: VARIANT_C.startingDeposit,
    signalsTotal: allTrades.length,
    opened, trades: tradeCount,
    totalR, rPerTr: tradeCount > 0 ? totalR / tradeCount : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
    tpRate: tradeCount > 0 ? (tpHits / tradeCount) * 100 : 0,
    slRate: tradeCount > 0 ? (slHits / tradeCount) * 100 : 0,
    eodRate: tradeCount > 0 ? (eodHits / tradeCount) * 100 : 0,
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
  return `${scenario.padEnd(40)} | trades=${r.trades.toString().padStart(4)} | R/tr=${fmtR(r.rPerTr).padStart(6)} | WR=${r.winRate.toFixed(0).padStart(2)}% TP=${r.tpRate.toFixed(0).padStart(2)}% SL=${r.slRate.toFixed(0).padStart(2)}% EOD=${r.eodRate.toFixed(0).padStart(2)}% | final $${r.finalDeposit.toFixed(0).padStart(7)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0).padStart(5)}%) | DD ${r.maxDD.toFixed(1).padStart(4)}%`
}

async function main() {
  console.log('Daily Breakout — Variant C: FADE (mean reversion) sweep')
  console.log(`Logic: SELL @ rangeHigh edge, BUY @ rangeLow edge (fade the breakout)`)
  console.log(`Buffer: ${BUFFER_LEVELS.join(', ')} × rangeSize | slBuffer: ${SL_BUFFER_LEVELS.join(', ')} × rangeSize`)
  console.log(`Universes: top5, top10`)
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

  type Group = { full: SimResult; train: SimResult; test: SimResult }
  const allResults = new Map<string, Group>()

  const universes: Array<{ name: 'top5' | 'top10'; symbols: string[] }> = [
    { name: 'top5', symbols: UNIVERSE_TOP5 },
    { name: 'top10', symbols: UNIVERSE_TOP10 },
  ]

  for (const universe of universes) {
    const presentSymbols = universe.symbols.filter(s => m5BySymbol.has(s))
    if (presentSymbols.length === 0) continue
    for (const buffer of BUFFER_LEVELS) {
      for (const slBuf of SL_BUFFER_LEVELS) {
        const fillsFull: FadeFill[] = []
        const fillsTrain: FadeFill[] = []
        const fillsTest: FadeFill[] = []
        for (const sym of presentSymbols) {
          const m5 = m5BySymbol.get(sym)!
          fillsFull.push(...generateFadeFills(m5, fullStart, now, sym, buffer, slBuf))
          fillsTrain.push(...generateFadeFills(m5, fullStart, trainEnd, sym, buffer, slBuf))
          fillsTest.push(...generateFadeFills(m5, trainEnd, now, sym, buffer, slBuf))
        }

        const label = `${universe.name}_buf${buffer}_slBuf${slBuf}`
        console.log(`=== ${label} (fills: F=${fillsFull.length} T=${fillsTrain.length} V=${fillsTest.length}) ===`)
        const buildTrades = (fills: FadeFill[]) => fills.map(f => ({
          fill: f, exit: simulateExit(m5BySymbol.get(f.symbol)!, f),
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
  console.log('================== Summary sorted by FULL final $ ==================')
  const sorted = [...allResults.entries()].sort((a, b) => b[1].full.finalDeposit - a[1].full.finalDeposit)
  for (const [key, g] of sorted.slice(0, 10)) {
    console.log(rowFor(`${key} FULL`, g.full))
    console.log(rowFor(`${key} TRAIN`, g.train))
    console.log(rowFor(`${key} TEST`, g.test))
    console.log()
  }

  // Top by TEST
  console.log('================== Top-10 by TEST (out-of-sample) ==================')
  const byTest = [...allResults.entries()].sort((a, b) => b[1].test.finalDeposit - a[1].test.finalDeposit)
  for (const [key, g] of byTest.slice(0, 10)) {
    console.log(rowFor(`${key} TEST`, g.test))
  }

  // Robust
  console.log('\n================== Robust (positive on BOTH TRAIN+TEST) ==================')
  let foundRobust = 0
  for (const [key, g] of allResults.entries()) {
    const trainRet = g.train.finalDeposit / g.train.startingDeposit
    const testRet = g.test.finalDeposit / g.test.startingDeposit
    if (trainRet > 1.0 && testRet > 1.0) {
      console.log(`✓ ${key}: TRAIN $${g.train.finalDeposit.toFixed(0)} (+${((trainRet - 1) * 100).toFixed(0)}%) | TEST $${g.test.finalDeposit.toFixed(0)} (+${((testRet - 1) * 100).toFixed(0)}%) | FULL DD ${g.full.maxDD.toFixed(0)}%`)
      foundRobust++
    }
  }
  if (foundRobust === 0) console.log('(none)')

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `dailybreak_C_fade_${Date.now()}.json`)
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
    universes, bufferLevels: BUFFER_LEVELS, slBufferLevels: SL_BUFFER_LEVELS,
    variant: VARIANT_C,
    fees: { taker: TAKER_FEE, maker: MAKER_FEE, slip: TAKER_SLIP },
    results: serializable,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
