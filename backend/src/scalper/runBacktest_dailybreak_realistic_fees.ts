/**
 * Daily Breakout — realistic Bybit fees + slippage backtest.
 *
 * Compares two fee/slip models on Variant A (23 prod symbols, $500, 2% risk,
 * 10 max conc, 10% target margin, BTC ADX>20, EOD-NO-TP1):
 *
 *   (a) CURRENT paper trader model — flat 0.08% × close-side notional, no
 *       slippage. This is what's in BreakoutPaperConfig.feesRoundTripPct + the
 *       paper trader code today.
 *
 *   (b) REALISTIC Bybit model:
 *       - Entry: taker (market open after breakout candle) — 0.055%
 *       - TP exit: maker (limit sitting at TP price) — 0.02%
 *       - SL exit: taker (stop-market) — 0.055%
 *       - EXPIRED close: taker (manual market close at 23:55) — 0.055%
 *       - Slippage: 0.05% per side on taker fills (entry/SL/EXPIRED). TP maker
 *         fills slip-free (you posted the limit, you get your price).
 *
 * Both models share the same signal pool (same generateBreakoutSignals, same
 * ladderBacktester structural exits). They differ only in fee/slip math
 * applied to each fill. This isolates "how much edge does the realistic cost
 * structure eat" vs the current optimistic paper.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_realistic_fees.ts
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

const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const TARGET_MARGIN_PCT = 10
const MAX_CONCURRENT = 10

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]

const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20

// Current paper model
const CURRENT_FEES_FLAT = 0.0008  // 0.08% × close-side notional
// (no slip in paper)

// Bybit model — base tier (no VIP, no native token discount)
//   maker 0.02% / taker 0.055%
//   alt-coin spread ~0.02-0.05%, taker slip on $500 market order ~0.05-0.10%
const BYBIT_TAKER_FEE = 0.00055
const BYBIT_MAKER_FEE = 0.00020
const BYBIT_TAKER_SLIP = 0.0007  // 0.07% — middle of altcoin range

// Binance model — base tier
//   maker 0.02% / taker 0.05%
//   alt-coin spread/slip noticeably tighter than Bybit on top altcoins
const BINANCE_TAKER_FEE = 0.00050
const BINANCE_MAKER_FEE = 0.00020
const BINANCE_TAKER_SLIP = 0.0003  // 0.03% — tighter on Binance altcoin perps

// MEXC model — cheapest fees on the market BUT thin altcoin liquidity
//   maker 0.00% / taker 0.02% (some symbols even lower w/ promos)
//   spread on alts ~0.05-0.15%, taker slip on $500 alt market ~0.10-0.25%
//   The fee saving is real, but slip eats most of it on illiquid alts.
const MEXC_TAKER_FEE = 0.00020
const MEXC_MAKER_FEE = 0.00000
const MEXC_TAKER_SLIP = 0.0015  // 0.15% — middle of altcoin range, much wider than Bybit/Binance

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
// BTC ADX(14) on 1h timeline
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
// Signal generation (same as compare.ts)
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

// We use ladderBacktester ONLY to determine exit structure (which TPs hit, when
// SL/EOD fired). Then we re-compute fees/slip outside according to our model.
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

// ============================================================================
// Trade record we feed into the portfolio sim
// ============================================================================

interface PortfolioFill {
  time: number
  price: number          // raw structural price (no slip applied)
  pnlR: number           // rContrib from ladderBacktester (no fees, no slip)
  percent: number        // 0..100 — fraction of position closed at this fill
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

interface PortfolioTrade {
  symbol: string
  utcDate: string
  entryTime: number
  closeTime: number
  side: 'BUY' | 'SELL'
  entryPrice: number     // raw rangeEdge
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
// Fee/slip models
// ============================================================================

interface FeeModel {
  name: string
  /**
   * Returns net pnlUsd for this fill given:
   * - structural price (no slip)
   * - position size in coin units
   * - entry price (raw)
   * - side
   * - close fraction (0..1) of total position closed at this fill
   * - reason (TP1/TP2/TP3/SL/EXPIRED)
   *
   * Returns: { netPnlUsd, feeUsd, slipUsd }
   */
  evaluateFill(args: {
    structPrice: number
    entryPriceEffective: number  // entry already adjusted for slip
    positionUnits: number
    side: 'BUY' | 'SELL'
    fillFracOfPos: number
    reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
  }): { netPnlUsd: number; feeUsd: number; slipUsd: number }

  /**
   * Compute the entry-side cost: returns slip-adjusted entry price + entry fee
   * to be deducted from realized PnL.
   */
  evaluateEntry(args: {
    rawEntryPrice: number
    positionUnits: number
    side: 'BUY' | 'SELL'
  }): { effectiveEntryPrice: number; entryFeeUsd: number }
}

const CURRENT_MODEL: FeeModel = {
  name: 'CURRENT (paper)',
  evaluateEntry({ rawEntryPrice }) {
    // No slip, no entry fee
    return { effectiveEntryPrice: rawEntryPrice, entryFeeUsd: 0 }
  },
  evaluateFill({ structPrice, entryPriceEffective, positionUnits, side, fillFracOfPos }) {
    // Pnl on structural prices, fee = 0.08% × close-side notional, no slip
    const isLong = side === 'BUY'
    const fillUnits = positionUnits * fillFracOfPos
    const grossPnl = (isLong ? structPrice - entryPriceEffective : entryPriceEffective - structPrice) * fillUnits
    const fillNotional = fillUnits * structPrice
    const feeUsd = fillNotional * CURRENT_FEES_FLAT
    return { netPnlUsd: grossPnl - feeUsd, feeUsd, slipUsd: 0 }
  },
}

function makeExchangeModel(name: string, takerFee: number, makerFee: number, takerSlip: number): FeeModel {
  return {
    name,
    evaluateEntry({ rawEntryPrice, positionUnits, side }) {
      const isLong = side === 'BUY'
      const slipped = isLong ? rawEntryPrice * (1 + takerSlip) : rawEntryPrice * (1 - takerSlip)
      const entryNotional = positionUnits * slipped
      const entryFeeUsd = entryNotional * takerFee
      return { effectiveEntryPrice: slipped, entryFeeUsd }
    },
    evaluateFill({ structPrice, entryPriceEffective, positionUnits, side, fillFracOfPos, reason }) {
      const isLong = side === 'BUY'
      const isMaker = reason === 'TP1' || reason === 'TP2' || reason === 'TP3'
      let exitPrice: number
      if (isMaker) {
        exitPrice = structPrice
      } else {
        exitPrice = isLong ? structPrice * (1 - takerSlip) : structPrice * (1 + takerSlip)
      }
      const fillUnits = positionUnits * fillFracOfPos
      const grossPnl = (isLong ? exitPrice - entryPriceEffective : entryPriceEffective - exitPrice) * fillUnits
      const fillNotional = fillUnits * exitPrice
      const feeRate = isMaker ? makerFee : takerFee
      const feeUsd = fillNotional * feeRate
      const slipUsd = isMaker ? 0 : fillUnits * Math.abs(exitPrice - structPrice)
      return { netPnlUsd: grossPnl - feeUsd, feeUsd, slipUsd }
    },
  }
}

const BYBIT_MODEL = makeExchangeModel('BYBIT', BYBIT_TAKER_FEE, BYBIT_MAKER_FEE, BYBIT_TAKER_SLIP)
const BINANCE_MODEL = makeExchangeModel('BINANCE', BINANCE_TAKER_FEE, BINANCE_MAKER_FEE, BINANCE_TAKER_SLIP)
const MEXC_MODEL = makeExchangeModel('MEXC', MEXC_TAKER_FEE, MEXC_MAKER_FEE, MEXC_TAKER_SLIP)

// ============================================================================
// Portfolio simulator
// ============================================================================

interface ScenarioFlags {
  applyBtcAdx: boolean
  carryOverGuard: boolean
  sameDayPerSymbolGuard: boolean
}

interface SimResult {
  modelName: string
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
  maxDD: number
  winRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(
  allTrades: PortfolioTrade[],
  scenario: ScenarioFlags,
  btc: BtcRegime,
  startDeposit: number,
  model: FeeModel,
): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = startDeposit
  let peak = startDeposit
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
        const ev = model.evaluateFill({
          structPrice: f.price,
          entryPriceEffective: a.effectiveEntryPrice,
          positionUnits: a.positionUnits,
          side: a.pt.side,
          fillFracOfPos: f.percent / 100,
          reason: f.reason,
        })
        currentDeposit += ev.netPnlUsd
        totalFees += ev.feeUsd
        totalSlip += ev.slipUsd
        a.realizedR += f.pnlR
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        addMonthly(f.time, ev.netPnlUsd, 0)
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

    if (scenario.applyBtcAdx && !btc.isTrending(pt.entryTime)) { skippedBtcAdx++; continue }
    if (scenario.carryOverGuard) {
      const blocked = active.some(a => a.pt.symbol === pt.symbol && a.pt.utcDate !== pt.utcDate)
      if (blocked) { skippedCarryOver++; continue }
    }
    if (scenario.sameDayPerSymbolGuard) {
      const key = `${pt.symbol}|${pt.utcDate}`
      if (takenSet.has(key)) { skippedSameDay++; continue }
    }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= MAX_CONCURRENT) { skippedConcurrent++; continue }

    // Step 1: get slipped entry price (no positionUnits needed yet — slip is just %)
    const entryEval = model.evaluateEntry({
      rawEntryPrice: pt.entryPrice,
      positionUnits: 0,
      side: pt.side,
    })
    // Step 2: size against the slipped entry so risk is correct
    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: TARGET_MARGIN_PCT,
      entry: entryEval.effectiveEntryPrice, sl: pt.sl,
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

    // Step 3: charge entry fee + record slip — call evaluateEntry again with
    // the now-known positionUnits (model.evaluateEntry computes the entry fee
    // for its own taker/maker rate, or returns 0 for CURRENT paper).
    const entryFinal = model.evaluateEntry({
      rawEntryPrice: pt.entryPrice,
      positionUnits: sizing.positionUnits,
      side: pt.side,
    })
    currentDeposit -= entryFinal.entryFeeUsd
    totalFees += entryFinal.entryFeeUsd
    const slipDelta = sizing.positionUnits * Math.abs(entryFinal.effectiveEntryPrice - pt.entryPrice)
    totalSlip += slipDelta

    takenSet.add(`${pt.symbol}|${pt.utcDate}`)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      effectiveEntryPrice: entryEval.effectiveEntryPrice,
    })
    opened++
    applyDD(pt.entryTime)
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    modelName: model.name,
    signalsTotal: allTrades.length,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
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
  console.log(`--- ${label}: ${r.modelName} ---`)
  console.log(
    `signals=${r.signalsTotal} | ` +
    `skip btcAdx=${r.skippedBtcAdx} carryOver=${r.skippedCarryOver} sameDay=${r.skippedSameDay} ` +
    `conc=${r.skippedConcurrent} margin=${r.skippedMargin} | opened=${r.opened}`
  )
  console.log(
    `totalR=${fmtR(r.totalR)} R/tr=${fmtR(r.rPerTr)} WR=${r.winRate.toFixed(0)}% | ` +
    `final=$${r.finalDeposit.toFixed(2)} peak=$${r.peakDeposit.toFixed(2)} DD=${r.maxDD.toFixed(1)}% | ` +
    `fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)}`
  )
}

async function main() {
  console.log('Daily Breakout — REALISTIC fees + slippage backtest')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | $${STARTING_DEPOSIT} | ${RISK_PCT}% risk | ${MAX_CONCURRENT} max conc | ${TARGET_MARGIN_PCT}% target margin`)
  console.log(`Fees:`)
  console.log(`  CURRENT (paper): 0.08% × close-side notional, no slip, no entry fee`)
  console.log(`  BYBIT:   taker ${(BYBIT_TAKER_FEE * 100).toFixed(3)}% / maker ${(BYBIT_MAKER_FEE * 100).toFixed(2)}% / taker slip ${(BYBIT_TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`  BINANCE: taker ${(BINANCE_TAKER_FEE * 100).toFixed(3)}% / maker ${(BINANCE_MAKER_FEE * 100).toFixed(2)}% / taker slip ${(BINANCE_TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`  MEXC:    taker ${(MEXC_TAKER_FEE * 100).toFixed(3)}% / maker ${(MEXC_MAKER_FEE * 100).toFixed(2)}% / taker slip ${(MEXC_TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`BTC ADX>${BTC_ADX_THRESHOLD} | dedup guards on | EOD-NO-TP1`)
  console.log(`Period: 365d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log()

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

  const flags: ScenarioFlags = {
    applyBtcAdx: true, carryOverGuard: true, sameDayPerSymbolGuard: true,
  }

  function runAll(label: string, pool: PortfolioTrade[]) {
    console.log(`================== ${label} ==================`)
    const cur = simulate(pool, flags, btc, STARTING_DEPOSIT, CURRENT_MODEL)
    const bb = simulate(pool, flags, btc, STARTING_DEPOSIT, BYBIT_MODEL)
    const bn = simulate(pool, flags, btc, STARTING_DEPOSIT, BINANCE_MODEL)
    const mx = simulate(pool, flags, btc, STARTING_DEPOSIT, MEXC_MODEL)
    printResult(label, cur)
    printResult(label, bb)
    printResult(label, bn)
    printResult(label, mx)
    console.log()
    return { cur, bb, bn, mx }
  }

  const full = runAll('FULL (365d)', allFull)
  const train = runAll('TRAIN (60%, ~219d)', allTrain)
  const test = runAll('TEST (40%, ~146d)', allTest)

  console.log('================== Summary by exchange ==================')
  function row(label: string, r: SimResult) {
    const ret = ((r.finalDeposit / STARTING_DEPOSIT - 1) * 100)
    console.log(
      `${label.padEnd(20)} | R/tr=${fmtR(r.rPerTr)} | WR=${r.winRate.toFixed(0)}% | ` +
      `final=$${r.finalDeposit.toFixed(0).padStart(6)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) | ` +
      `DD=${r.maxDD.toFixed(1)}% | fees=$${r.totalFeesUsd.toFixed(0).padStart(4)} | slip=$${r.totalSlipUsd.toFixed(0).padStart(4)}`
    )
  }
  for (const [label, group] of [['FULL', full], ['TRAIN', train], ['TEST', test]] as const) {
    console.log(`--- ${label} ---`)
    row('CURRENT (paper)', group.cur)
    row('BYBIT (live)', group.bb)
    row('BINANCE (live)', group.bn)
    row('MEXC (live)', group.mx)
    console.log()
  }

  console.log('================== Exchange ranking ==================')
  function rank(label: string, group: { bb: SimResult; bn: SimResult; mx: SimResult }) {
    const list: Array<{ name: string; r: SimResult }> = [
      { name: 'BYBIT', r: group.bb },
      { name: 'BINANCE', r: group.bn },
      { name: 'MEXC', r: group.mx },
    ]
    list.sort((a, b) => b.r.finalDeposit - a.r.finalDeposit)
    console.log(`${label}:`)
    for (let i = 0; i < list.length; i++) {
      const x = list[i]
      const ret = (x.r.finalDeposit / STARTING_DEPOSIT - 1) * 100
      console.log(
        `  ${i + 1}. ${x.name.padEnd(8)} final=$${x.r.finalDeposit.toFixed(0).padStart(6)} ` +
        `(${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) ` +
        `fees=$${x.r.totalFeesUsd.toFixed(0).padStart(4)} slip=$${x.r.totalSlipUsd.toFixed(0).padStart(4)} ` +
        `effCost=$${(x.r.totalFeesUsd + x.r.totalSlipUsd).toFixed(0).padStart(4)}`
      )
    }
  }
  rank('FULL', full)
  rank('TRAIN', train)
  rank('TEST', test)
  console.log()

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
