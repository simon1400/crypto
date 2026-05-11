/**
 * Daily Breakout — Variant C HEDGE mode backtest.
 *
 * Базовая стратегия — limit-on-rangeEdge (вариант C). Новая идея:
 *
 *   Текущий C: пара BUY @ rangeHigh + SELL @ rangeLow, при fill одной → cancel другой.
 *
 *   HEDGE C:   противоположный limit НЕ отменяется при fill первого.
 *              Если первая сделка закрылась по TP → cancel второй (тренд подтверждён).
 *              Если первая закрылась по SL → в этот же момент цена коснулась
 *              rangeEdge противоположной стороны = второй limit заполняется,
 *              новая позиция в обратную сторону. Максимум 2 сделки на сетап в день.
 *
 * Реализация: переиспользуем проверенную инфраструктуру AB-script (generateBreakoutSignals,
 * runLadderBacktest, портфельный simulate). Hedge — пост-обработка SL'нувшихся limit-сделок:
 * генерируем вторую сделку противоположной стороны с entry на rangeEdge противоположной
 * границы и прогоняем через тот же ladder со старта close-времени первой.
 *
 * 3 сценария на 365d / 23 prod-монеты на Binance, общий портфельный симулятор:
 *   1. taker market (= PROD A/B baseline)
 *   2. limit на rangeEdge (= текущий C)
 *   3. limit + HEDGE (= новая идея)
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_hedge_C.ts
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

const TAKER_FEE = 0.00050
const MAKER_FEE = 0.00020
const TAKER_SLIP = 0.0003

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
  name: 'C-taker' | 'C-limit' | 'C-hedge'
  startingDeposit: number
  maxConcurrent: number
  targetMarginPct: number
}

// Все три сценария используют параметры C ($320 / 20 conc / 5% margin).
const VARIANTS: Variant[] = [
  { name: 'C-taker', startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 },
  { name: 'C-limit', startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 },
  { name: 'C-hedge', startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 },
]

type Mode = 'taker' | 'limit' | 'hedge'

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
// Signal generation (copied verbatim from AB-script — proven baseline)
// ============================================================================

interface BreakoutCfg {
  rangeBars: number
  volMultiplier: number
  tp1Mult: number
  tp2Mult: number
  tp3Mult: number
  /** Live engine formula: entry = c.close (триггерная свеча). Idealized = false → entry=rangeEdge. */
  liveEntryFormula: boolean
  /** Min entry→TP1 distance % filter. 0 = no filter. */
  minEntryTp1Pct: number
}

interface BreakoutSignal extends LadderSignal {
  /** Range info — нужно для hedge, чтобы знать opposite rangeEdge. */
  rangeHigh: number
  rangeLow: number
  /** UTC date — для same-day guard. */
  utcDate: string
}

function generateBreakoutSignals(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): BreakoutSignal[] {
  const sigs: BreakoutSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }
  for (const [day, candles] of byDay) {
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
      let anchor = 0
      if (c.high > rangeHigh && c.close > rangeHigh) {
        side = 'BUY'
        entryPrice = cfg.liveEntryFormula ? c.close : rangeHigh
        anchor = rangeHigh
      } else if (c.low < rangeLow && c.close < rangeLow) {
        side = 'SELL'
        entryPrice = cfg.liveEntryFormula ? c.close : rangeLow
        anchor = rangeLow
      }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [anchor + rangeSize * cfg.tp1Mult, anchor + rangeSize * cfg.tp2Mult, anchor + rangeSize * cfg.tp3Mult]
        : [anchor - rangeSize * cfg.tp1Mult, anchor - rangeSize * cfg.tp2Mult, anchor - rangeSize * cfg.tp3Mult]
      const tp1Overshoot = side === 'BUY' ? entryPrice >= tpLadder[0] : entryPrice <= tpLadder[0]
      if (tp1Overshoot) continue
      if (cfg.minEntryTp1Pct > 0) {
        const entryTp1Pct = (Math.abs(tpLadder[0] - entryPrice) / entryPrice) * 100
        if (entryTp1Pct < cfg.minEntryTp1Pct) continue
      }
      sigs.push({
        side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout',
        rangeHigh, rangeLow, utcDate: day,
      })
      triggered = true
    }
  }
  return sigs
}

function runLadderRaw(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): { trades: LadderTrade[]; signals: BreakoutSignal[] } {
  const sigs = generateBreakoutSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, BreakoutSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: 0, slippagePerSide: 0,
  }
  const trades = runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
  return { trades, signals: sigs }
}

/**
 * HEDGE pass — для каждой SL-сделки первого прохода (limit mode) генерирует hedge trade
 * с противоположной стороны: entry на opposite rangeEdge, SL на первичной rangeEdge,
 * TP ladder зеркально. Hedge filling: entry time = exit time первой сделки (тот же бар
 * на котором первая закрылась по SL — это касание противоположной границы).
 *
 * Симулируем hedge через тот же ladderBacktester, передавая отфильтрованные candles
 * с start = первый бар после exitTime первой сделки. signalGenerator вернёт hedge сигнал
 * ровно на этом баре.
 *
 * Возвращаем массив hedge trades, помеченных isHedge для подсчёта в портфельном симе.
 */
function generateHedgeTrades(
  m5: OHLCV[],
  primaryTrades: LadderTrade[],
  primarySignals: BreakoutSignal[],
  periodFrom: number,
  periodTo: number,
): { trades: LadderTrade[]; signals: BreakoutSignal[] } {
  // Map primary trades to their range info via entryTime
  const sigByEntryTime = new Map<number, BreakoutSignal>()
  for (const s of primarySignals) sigByEntryTime.set(s.entryTime, s)

  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  // For each primary trade that hit SL, build a hedge signal.
  // Hedge entry happens at the candle where primary SL was hit (= exitTime).
  // We treat the hedge as a NEW signal at index `idxOfExitTime` in periodCandles.
  const hedgeSigByIdx = new Map<number, BreakoutSignal>()
  const hedgeSigs: BreakoutSignal[] = []

  for (const pt of primaryTrades) {
    if (pt.exitReason !== 'SL') continue
    const primSig = sigByEntryTime.get(pt.entryTime)
    if (!primSig) continue

    const isLongPrimary = pt.side === 'BUY'
    const hedgeSide: 'BUY' | 'SELL' = isLongPrimary ? 'SELL' : 'BUY'
    // Hedge entry at the SL price (= opposite rangeEdge, by construction of variant C).
    const hedgeEntry = isLongPrimary ? primSig.rangeLow : primSig.rangeHigh
    const hedgeSl    = isLongPrimary ? primSig.rangeHigh : primSig.rangeLow
    const rangeSize  = primSig.rangeHigh - primSig.rangeLow
    const hedgeTp = hedgeSide === 'BUY'
      ? [primSig.rangeHigh + rangeSize * TP_MULTS[0], primSig.rangeHigh + rangeSize * TP_MULTS[1], primSig.rangeHigh + rangeSize * TP_MULTS[2]]
      : [primSig.rangeLow  - rangeSize * TP_MULTS[0], primSig.rangeLow  - rangeSize * TP_MULTS[1], primSig.rangeLow  - rangeSize * TP_MULTS[2]]

    // Find index of exitTime in periodCandles
    const exitIdx = periodCandles.findIndex(c => c.time === pt.exitTime)
    if (exitIdx < 0) continue

    const hedgeSig: BreakoutSignal = {
      side: hedgeSide,
      entryTime: pt.exitTime,
      entryPrice: hedgeEntry,
      sl: hedgeSl,
      tpLadder: hedgeTp,
      reason: 'hedge',
      rangeHigh: primSig.rangeHigh,
      rangeLow: primSig.rangeLow,
      utcDate: primSig.utcDate,
    }
    hedgeSigByIdx.set(exitIdx, hedgeSig)
    hedgeSigs.push(hedgeSig)
  }

  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: 0, slippagePerSide: 0,
  }
  const trades = runLadderBacktest(periodCandles, (i) => hedgeSigByIdx.get(i) ?? null, ladderCfg).trades
  return { trades, signals: hedgeSigs }
}

// ============================================================================
// Portfolio model (same as AB) — converts LadderTrade → PortfolioTrade
// ============================================================================

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
  isHedge: boolean
}

function toPortfolioTrade(symbol: string, t: LadderTrade, isHedge: boolean): PortfolioTrade {
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
    isHedge,
  }
}

// ============================================================================
// Portfolio simulator (copy from AB, extended with hedge stats and 2-trades-per-day)
// ============================================================================

interface SimResult {
  variant: string
  startingDeposit: number
  signalsTotal: number
  skippedBtcAdx: number
  skippedCarryOver: number
  skippedSameDay: number
  skippedConcurrent: number
  skippedMargin: number
  opened: number
  trades: number
  hedgeTrades: number
  hedgeWins: number
  hedgeNetUsd: number
  hedgeWinPnl: number
  hedgeLossPnl: number
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
  mode: Mode,
): SimResult {
  // Sort by entryTime; if same time, primary first.
  const sorted = [...allTrades].sort((a, b) => {
    if (a.entryTime !== b.entryTime) return a.entryTime - b.entryTime
    return (a.isHedge ? 1 : 0) - (b.isHedge ? 1 : 0)
  })
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
    pnlUsd: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0
  let hedgeTrades = 0, hedgeWins = 0, hedgeWinPnl = 0, hedgeLossPnl = 0
  // Per (symbol, day): track primary trades + permit up to 1 hedge per setup
  const primaryTaken = new Set<string>()
  const hedgeTaken = new Set<string>()

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
        const isMaker = f.reason === 'TP1' || f.reason === 'TP2' || f.reason === 'TP3'
        let exitPrice: number
        const isLong = a.pt.side === 'BUY'
        if (isMaker) exitPrice = f.price
        else exitPrice = isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP)
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeRate = isMaker ? MAKER_FEE : TAKER_FEE
        const feeUsd = fillNotional * feeRate
        const slipUsd = isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        a.pnlUsd += netPnl
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
        if (a.pt.isHedge) {
          hedgeTrades++
          if (a.pnlUsd > 0) { hedgeWins++; hedgeWinPnl += a.pnlUsd }
          else hedgeLossPnl += a.pnlUsd
        }
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
    // Same-day guards:
    //   - taker / limit: at most 1 trade per (sym, day)
    //   - hedge mode: at most 1 primary + 1 hedge per (sym, day);
    //       hedge requires that the primary for that key was actually opened
    const key = `${pt.symbol}|${pt.utcDate}`
    if (pt.isHedge) {
      if (mode !== 'hedge') { skippedSameDay++; continue }
      if (!primaryTaken.has(key)) { skippedSameDay++; continue }  // primary was blocked → no hedge
      if (hedgeTaken.has(key)) { skippedSameDay++; continue }
    } else {
      if (primaryTaken.has(key)) { skippedSameDay++; continue }
    }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= variant.maxConcurrent) { skippedConcurrent++; continue }

    const isLong = pt.side === 'BUY'
    // taker = market: slip pushes entry worse, taker fee.
    // limit / hedge = limit on rangeEdge: exact fill, maker fee, no slip.
    const effectiveEntry = mode === 'taker'
      ? (isLong ? pt.entryPrice * (1 + TAKER_SLIP) : pt.entryPrice * (1 - TAKER_SLIP))
      : pt.entryPrice

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: variant.targetMarginPct,
      entry: effectiveEntry, sl: pt.sl,
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

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFeeRate = mode === 'taker' ? TAKER_FEE : MAKER_FEE
    const entryFee = entryNotional * entryFeeRate
    currentDeposit -= entryFee
    totalFees += entryFee
    if (mode === 'taker') {
      const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.entryPrice)
      totalSlip += entrySlip
    }
    applyDD(pt.entryTime)

    if (pt.isHedge) hedgeTaken.add(key)
    else primaryTaken.add(key)

    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      effectiveEntryPrice: effectiveEntry,
      pnlUsd: -entryFee,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    if (a.pt.isHedge) {
      hedgeTrades++
      if (a.pnlUsd > 0) { hedgeWins++; hedgeWinPnl += a.pnlUsd }
      else hedgeLossPnl += a.pnlUsd
    }
    fullyClosed.push(a.pt)
  }

  return {
    variant: variant.name,
    startingDeposit: variant.startingDeposit,
    signalsTotal: allTrades.length,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    hedgeTrades, hedgeWins, hedgeNetUsd: hedgeWinPnl + hedgeLossPnl,
    hedgeWinPnl, hedgeLossPnl,
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
  console.log(`--- ${label}: ${r.variant} ($${r.startingDeposit} start) ---`)
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
  if (r.hedgeTrades > 0) {
    const hedgeWr = (r.hedgeWins / r.hedgeTrades) * 100
    console.log(
      `hedges=${r.hedgeTrades} (WR=${hedgeWr.toFixed(0)}%) | ` +
      `hedge win$=${fmtUsd(r.hedgeWinPnl)} loss$=${fmtUsd(r.hedgeLossPnl)} ` +
      `net=${fmtUsd(r.hedgeNetUsd)}`
    )
  }
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)} effCost=$${(r.totalFeesUsd + r.totalSlipUsd).toFixed(2)}`)
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- ${label}: monthly P&L (${r.variant}) ---`)
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  console.log('-'.repeat(45))
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Daily Breakout — Variant C HEDGE backtest (vs taker baseline vs limit-only C)')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`All variants: $320 start / 20 max conc / 5% target margin / 2% risk`)
  console.log(`BTC ADX>${BTC_ADX_THRESHOLD} | TP ladder ${TP_MULTS.join('/')}R, splits ${SPLITS.join('/')}`)
  console.log(`Period: 365d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log(`Hedge logic: if primary SL'd → open opposite-side limit (entry on opposite rangeEdge) at same bar`)
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
  console.log(`Loaded ${m5BySymbol.size} symbols`)
  console.log()

  // For each mode, build a portfolio of PortfolioTrades, then run portfolio sim.
  // Modes:
  //   'taker' → liveEntryFormula=true, entry=c.close (taker market)
  //   'limit' → liveEntryFormula=false, entry=rangeEdge (limit). NO hedge trades.
  //   'hedge' → same primary as 'limit' + hedge trades on SL exits

  type ModeResults = {
    full: SimResult
    train: SimResult
    test: SimResult
    poolFull: number
    poolTrain: number
    poolTest: number
    hedgeCount: number
  }
  const modeResults = new Map<Mode, ModeResults>()

  const MODES: Array<{ mode: Mode; variant: Variant; label: string; liveFormula: boolean }> = [
    { mode: 'taker', variant: VARIANTS[0], label: 'taker market (PROD A/B baseline)',  liveFormula: true  },
    { mode: 'limit', variant: VARIANTS[1], label: 'limit on rangeEdge (current C)',    liveFormula: false },
    { mode: 'hedge', variant: VARIANTS[2], label: 'limit + HEDGE (NEW idea)',          liveFormula: false },
  ]

  for (const { mode, variant, label, liveFormula } of MODES) {
    const cfg: BreakoutCfg = {
      rangeBars: RANGE_BARS, volMultiplier: VOL_MULT,
      tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2],
      liveEntryFormula: liveFormula,
      minEntryTp1Pct: 0,
    }

    const allFull: PortfolioTrade[] = []
    const allTrain: PortfolioTrade[] = []
    const allTest: PortfolioTrade[] = []
    let hedgeFull = 0, hedgeTrain = 0, hedgeTest = 0

    for (const [sym, m5] of m5BySymbol.entries()) {
      // Run primary pass over the FULL period — exactly like AB-script does.
      const primaryFull = runLadderRaw(m5, cfg, fullStart, now)
      primaryFull.trades.forEach(t => allFull.push(toPortfolioTrade(sym, t, false)))

      const primaryTrain = runLadderRaw(m5, cfg, fullStart, trainEnd)
      primaryTrain.trades.forEach(t => allTrain.push(toPortfolioTrade(sym, t, false)))

      const primaryTest = runLadderRaw(m5, cfg, trainEnd, now)
      primaryTest.trades.forEach(t => allTest.push(toPortfolioTrade(sym, t, false)))

      if (mode === 'hedge') {
        const hFull = generateHedgeTrades(m5, primaryFull.trades, primaryFull.signals, fullStart, now)
        hFull.trades.forEach(t => allFull.push(toPortfolioTrade(sym, t, true)))
        hedgeFull += hFull.trades.length

        const hTrain = generateHedgeTrades(m5, primaryTrain.trades, primaryTrain.signals, fullStart, trainEnd)
        hTrain.trades.forEach(t => allTrain.push(toPortfolioTrade(sym, t, true)))
        hedgeTrain += hTrain.trades.length

        const hTest = generateHedgeTrades(m5, primaryTest.trades, primaryTest.signals, trainEnd, now)
        hTest.trades.forEach(t => allTest.push(toPortfolioTrade(sym, t, true)))
        hedgeTest += hTest.trades.length
      }
    }

    console.log(`================== Scenario: ${label} ==================`)
    console.log(`Trade pool (closed by ladder): FULL ${allFull.length}` +
      (mode === 'hedge' ? ` (hedge ${hedgeFull})` : '') +
      ` | TRAIN ${allTrain.length}` + (mode === 'hedge' ? ` (hedge ${hedgeTrain})` : '') +
      ` | TEST ${allTest.length}` + (mode === 'hedge' ? ` (hedge ${hedgeTest})` : ''))
    console.log()

    const full = simulate(allFull, variant, btc, mode)
    const train = simulate(allTrain, variant, btc, mode)
    const test = simulate(allTest, variant, btc, mode)
    printResult('FULL (365d)', full); console.log()
    printResult('TRAIN (60%)', train); console.log()
    printResult('TEST (40%)', test); console.log()

    modeResults.set(mode, {
      full, train, test,
      poolFull: allFull.length, poolTrain: allTrain.length, poolTest: allTest.length,
      hedgeCount: hedgeFull,
    })
  }

  // Summary table
  console.log('================== Summary table ==================')
  function row(label: string, r: SimResult) {
    const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
    console.log(
      `${label.padEnd(36)} | final $${r.finalDeposit.toFixed(0).padStart(6)} ` +
      `(${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) | R/tr=${fmtR(r.rPerTr)} | WR=${r.winRate.toFixed(0)}% | ` +
      `peak $${r.peakDeposit.toFixed(0).padStart(5)} | min $${r.minDeposit.toFixed(0).padStart(4)} | DD ${r.maxDD.toFixed(1)}%`
    )
  }
  for (const period of ['full', 'train', 'test'] as const) {
    console.log(`--- ${period.toUpperCase()} ---`)
    for (const { mode, label } of MODES) {
      const m = modeResults.get(mode)!
      row(label, m[period])
    }
    console.log()
  }

  // Delta: limit-only → limit+hedge
  console.log('================== Δ limit-only C → limit + HEDGE ==================')
  const limitR = modeResults.get('limit')!
  const hedgeR = modeResults.get('hedge')!
  function deltaRow(label: string, before: SimResult, after: SimResult) {
    const retBefore = ((before.finalDeposit / before.startingDeposit - 1) * 100)
    const retAfter = ((after.finalDeposit / after.startingDeposit - 1) * 100)
    const added = after.trades - before.trades
    console.log(
      `${label.padEnd(8)} | trades ${before.trades}→${after.trades} (${added >= 0 ? '+' : ''}${added}) | ` +
      `final $${before.finalDeposit.toFixed(0)}→$${after.finalDeposit.toFixed(0)} (${retBefore.toFixed(0)}%→${retAfter.toFixed(0)}%) | ` +
      `R/tr ${fmtR(before.rPerTr)}→${fmtR(after.rPerTr)} | WR ${before.winRate.toFixed(0)}→${after.winRate.toFixed(0)}% | ` +
      `DD ${before.maxDD.toFixed(1)}→${after.maxDD.toFixed(1)}%`
    )
    if (after.hedgeTrades > 0) {
      const hedgeWr = (after.hedgeWins / after.hedgeTrades) * 100
      console.log(
        `         hedges only: ${after.hedgeTrades} trades, WR ${hedgeWr.toFixed(0)}%, ` +
        `net ${fmtUsd(after.hedgeNetUsd)} (wins ${fmtUsd(after.hedgeWinPnl)} / losses ${fmtUsd(after.hedgeLossPnl)})`
      )
    }
  }
  deltaRow('FULL', limitR.full, hedgeR.full)
  deltaRow('TRAIN', limitR.train, hedgeR.train)
  deltaRow('TEST', limitR.test, hedgeR.test)
  console.log()

  console.log('================== Monthly P&L (HEDGE FULL) ==================')
  printMonthly('FULL', hedgeR.full); console.log()
  console.log('================== Monthly P&L (LIMIT-only FULL) ==================')
  printMonthly('FULL', limitR.full); console.log()

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
