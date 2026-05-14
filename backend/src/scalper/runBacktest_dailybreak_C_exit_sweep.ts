/**
 * Variant C — exit-logic sweep.
 *
 * Гипотеза: текущая ladder-логика (TP1/TP2/TP3 = +1R/+2R/+3R с trailing) не работает
 * на C, потому что C ловит wick-bounces которые быстро возвращаются в range. Может
 * быть лучше брать quick scalp.
 *
 * Базовая prod-логика fill — без изменений (любое касание = fill). Меняется только
 * exit:
 *   - scalpFullClose: TP = entry + tpR × |entry-SL|, 100% close
 *   - scalpTrail50: TP1 = +tpR × R закрывает 50%, SL→BE, остаток ждёт SL или EOD
 *
 * Sweep по tpR: 0.3 / 0.5 / 0.75 / 1.0
 * EOD per-trade: 24h max hold (288 баров на 5m), потом market close
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_C_exit_sweep.ts
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

const PROD_SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

const VARIANT_C = {
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

type ExitMode = 'scalpFullClose' | 'scalpTrail50'
const TP_R_LEVELS = [0.3, 0.5, 0.75, 1.0]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ============================================================================
// BTC ADX (copy from C_live.ts)
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
// Fill detection (PROD C logic — any wick touch = fill)
// ============================================================================

interface CFill {
  symbol: string
  utcDate: string
  side: 'BUY' | 'SELL'
  entryPrice: number   // rangeEdge or gap-open
  sl: number
  entryTime: number
  entryIdx: number     // index в массиве свечей символа
  rangeHigh: number
  rangeLow: number
  gapFill: boolean
}

function generateFills(m5: OHLCV[], periodFrom: number, periodTo: number, symbol: string): CFill[] {
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

    const placementBar = candles[RANGE_BARS - 1]
    const livePrice = placementBar.close
    const canPlaceBuy = livePrice <= rangeHigh
    const canPlaceSell = livePrice >= rangeLow
    if (!canPlaceBuy && !canPlaceSell) continue

    let buyFillIdx = -1, sellFillIdx = -1
    for (let i = RANGE_BARS; i < candles.length; i++) {
      const c = candles[i]
      if (canPlaceBuy && buyFillIdx < 0 && c.high >= rangeHigh) buyFillIdx = i
      if (canPlaceSell && sellFillIdx < 0 && c.low <= rangeLow) sellFillIdx = i
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
    let fillPrice: number
    let gapFill = false
    if (winningSide === 'BUY') {
      if (fillCandle.open > rangeHigh) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = rangeHigh
    } else {
      if (fillCandle.open < rangeLow) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = rangeLow
    }

    fills.push({
      symbol, utcDate: date, side: winningSide,
      entryPrice: fillPrice,
      sl: winningSide === 'BUY' ? rangeLow : rangeHigh,
      entryTime: fillCandle.time,
      entryIdx: startIdx + winningIdx,
      rangeHigh, rangeLow,
      gapFill,
    })
  }
  return fills
}

// ============================================================================
// Exit simulator (custom — not ladder)
// ============================================================================

interface ExitFill {
  time: number
  price: number
  percent: number       // 0-100
  reason: 'TP' | 'TRAIL_SL' | 'SL' | 'EOD'
  isMaker: boolean
}

interface ExitResult {
  fills: ExitFill[]
  closeTime: number
}

/**
 * Симулирует exit одной сделки начиная со свечи entryIdx+1.
 * Использует свечи по [entryIdx+1, ...maxHoldBars). EOD = MAX_HOLD_BARS.
 */
function simulateExit(
  symbolCandles: OHLCV[],
  fill: CFill,
  exitMode: ExitMode,
  tpR: number,
): ExitResult {
  const isLong = fill.side === 'BUY'
  const slDist = Math.abs(fill.entryPrice - fill.sl)
  const tpPrice = isLong ? fill.entryPrice + tpR * slDist : fill.entryPrice - tpR * slDist
  const exitFills: ExitFill[] = []

  let tpHit = false
  let currentSL = fill.sl
  let remainingPct = 100
  const splitPct = exitMode === 'scalpTrail50' ? 50 : 100

  const startIdx = fill.entryIdx + 1
  const endIdx = Math.min(symbolCandles.length, startIdx + MAX_HOLD_BARS)

  for (let i = startIdx; i < endIdx; i++) {
    const c = symbolCandles[i]
    if (!c) break

    // Check SL first (conservative — assume SL hits before TP on same bar)
    const slHit = isLong ? c.low <= currentSL : c.high >= currentSL
    const tpReached = isLong ? c.high >= tpPrice : c.low <= tpPrice

    if (!tpHit) {
      // TP not yet hit
      if (slHit) {
        // Full close at SL
        exitFills.push({
          time: c.time, price: currentSL, percent: remainingPct,
          reason: 'SL', isMaker: false,
        })
        return { fills: exitFills, closeTime: c.time }
      }
      if (tpReached) {
        exitFills.push({
          time: c.time, price: tpPrice, percent: splitPct,
          reason: 'TP', isMaker: true,
        })
        remainingPct -= splitPct
        tpHit = true
        if (exitMode === 'scalpFullClose' || remainingPct <= 0) {
          return { fills: exitFills, closeTime: c.time }
        }
        // scalpTrail50: SL → entry (BE)
        currentSL = fill.entryPrice
      }
    } else {
      // TP already hit, scalpTrail50 mode — waiting for trail SL or EOD
      if (slHit) {
        // Closed at trail SL (=BE after TP1). Maker if SL=BE (limit), but conservatively
        // model as taker to avoid optimism.
        exitFills.push({
          time: c.time, price: currentSL, percent: remainingPct,
          reason: 'TRAIL_SL', isMaker: false,
        })
        return { fills: exitFills, closeTime: c.time }
      }
    }
  }

  // EOD market close at last available bar
  const lastIdx = Math.min(endIdx - 1, symbolCandles.length - 1)
  if (lastIdx >= startIdx && remainingPct > 0) {
    const lastBar = symbolCandles[lastIdx]
    exitFills.push({
      time: lastBar.time, price: lastBar.close, percent: remainingPct,
      reason: 'EOD', isMaker: false,
    })
    return { fills: exitFills, closeTime: lastBar.time }
  }

  return { fills: exitFills, closeTime: exitFills[exitFills.length - 1]?.time ?? fill.entryTime }
}

// ============================================================================
// Portfolio simulator
// ============================================================================

interface PortfolioTrade {
  fill: CFill
  exit: ExitResult
}

interface SimResult {
  exitMode: ExitMode
  tpR: number
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
  tpRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(allTrades: PortfolioTrade[], btc: BtcRegime, exitMode: ExitMode, tpR: number): SimResult {
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
    statusKey: 'OPEN' | 'TP1_HIT'
    realizedR: number
    riskUsd: number
    effectiveEntryPrice: number
    entryIsMaker: boolean
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, tpWins = 0, totalR = 0
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
        if (f.reason === 'TP') a.statusKey = 'TP1_HIT'
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        if (a.statusKey === 'TP1_HIT') tpWins++
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
      hasTP1: a.statusKey === 'TP1_HIT', hasTP2: false,
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
      entryIsMaker,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    if (a.statusKey === 'TP1_HIT') tpWins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    exitMode, tpR,
    startingDeposit: VARIANT_C.startingDeposit,
    signalsTotal: allTrades.length,
    skippedBtcAdx, skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    tpRate: fullyClosed.length > 0 ? (tpWins / fullyClosed.length) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

// ============================================================================
// Main
// ============================================================================

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }

function rowFor(scenario: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  return `${scenario.padEnd(36)} | trades=${r.trades.toString().padStart(4)} | R/tr=${fmtR(r.rPerTr).padStart(6)} | WR=${r.winRate.toFixed(0).padStart(2)}% TP=${r.tpRate.toFixed(0).padStart(2)}% | final $${r.finalDeposit.toFixed(0).padStart(6)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0).padStart(4)}%) | DD ${r.maxDD.toFixed(1).padStart(4)}%`
}

async function main() {
  console.log('Daily Breakout — Variant C exit-logic sweep')
  console.log(`Fill logic: PROD C (any wick touch = fill, no vol filter)`)
  console.log(`Exit modes: scalpFullClose, scalpTrail50 | TP-R sweep: ${TP_R_LEVELS.join(', ')}`)
  console.log(`Variant: $${VARIANT_C.startingDeposit} | ${VARIANT_C.maxConcurrent} conc | ${VARIANT_C.targetMarginPct}% margin | ${RISK_PCT}% risk`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading BTC regime...')
  const btc = await buildBtcRegime()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  console.log('Loading m5 candles...')
  const m5BySymbol = new Map<string, OHLCV[]>()
  for (const sym of PROD_SYMBOLS) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    m5BySymbol.set(sym, m5)
  }
  console.log(`Loaded ${m5BySymbol.size} symbols\n`)

  // Generate fills once per symbol (fill logic не меняется)
  console.log('Generating fills...')
  const allFillsFull: CFill[] = []
  const allFillsTrain: CFill[] = []
  const allFillsTest: CFill[] = []
  const symbolCandles = new Map<string, OHLCV[]>()
  for (const [sym, m5] of m5BySymbol.entries()) {
    symbolCandles.set(sym, m5)
    allFillsFull.push(...generateFills(m5, fullStart, now, sym))
    allFillsTrain.push(...generateFills(m5, fullStart, trainEnd, sym))
    allFillsTest.push(...generateFills(m5, trainEnd, now, sym))
  }
  console.log(`Fills: FULL ${allFillsFull.length} | TRAIN ${allFillsTrain.length} | TEST ${allFillsTest.length}\n`)

  // For each (exitMode, tpR) — simulate exit on each fill, then portfolio simulate
  const EXIT_MODES: ExitMode[] = ['scalpFullClose', 'scalpTrail50']
  type Group = { full: SimResult; train: SimResult; test: SimResult }
  const allResults = new Map<string, Group>()

  function buildTrades(fills: CFill[], exitMode: ExitMode, tpR: number): PortfolioTrade[] {
    return fills.map(f => ({
      fill: f,
      exit: simulateExit(symbolCandles.get(f.symbol)!, f, exitMode, tpR),
    }))
  }

  for (const exitMode of EXIT_MODES) {
    for (const tpR of TP_R_LEVELS) {
      const scenarioKey = `${exitMode}_tp${tpR}`
      console.log(`================== ${scenarioKey} ==================`)
      const tradesFull = buildTrades(allFillsFull, exitMode, tpR)
      const tradesTrain = buildTrades(allFillsTrain, exitMode, tpR)
      const tradesTest = buildTrades(allFillsTest, exitMode, tpR)
      const full = simulate(tradesFull, btc, exitMode, tpR)
      const train = simulate(tradesTrain, btc, exitMode, tpR)
      const test = simulate(tradesTest, btc, exitMode, tpR)
      console.log(rowFor(`${scenarioKey} FULL`, full))
      console.log(rowFor(`${scenarioKey} TRAIN`, train))
      console.log(rowFor(`${scenarioKey} TEST`, test))
      console.log()
      allResults.set(scenarioKey, { full, train, test })
    }
  }

  // Summary sorted by FULL final deposit
  console.log('================== Summary (sorted by FULL final $) ==================')
  const sorted = [...allResults.entries()].sort((a, b) => b[1].full.finalDeposit - a[1].full.finalDeposit)
  for (const [key, g] of sorted) {
    console.log(`--- ${key} ---`)
    console.log(rowFor(`${key} FULL`, g.full))
    console.log(rowFor(`${key} TRAIN`, g.train))
    console.log(rowFor(`${key} TEST`, g.test))
  }

  // Best by TEST (out-of-sample)
  console.log('\n================== Best by TEST (out-of-sample) ==================')
  const byTest = [...allResults.entries()].sort((a, b) => b[1].test.finalDeposit - a[1].test.finalDeposit)
  for (const [key, g] of byTest.slice(0, 5)) {
    console.log(rowFor(`${key} TEST`, g.test))
  }

  // Save
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `dailybreak_C_exit_sweep_${Date.now()}.json`)
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
    variant: VARIANT_C,
    exitModes: EXIT_MODES, tpLevels: TP_R_LEVELS,
    fees: { taker: TAKER_FEE, maker: MAKER_FEE, slip: TAKER_SLIP },
    results: serializable,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
