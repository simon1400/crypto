/**
 * Daily Breakout — Variant A: scale-in (pyramiding) при движении в ПЛЮС.
 *
 * Логика scale-in UP:
 *   1. Первичный вход: entry=c.close (taker), SL=rangeEdge противоположной, размер
 *      под 2% risk (как обычно)
 *   2. Если после входа цена ПРОШЛА 50% пути от entry к TP1 (mid(entry, TP1)) —
 *      открываем ВТОРУЮ позицию (scale-in) того же направления:
 *      - entry = mid(entry, TP1) (цена на этом баре, как pre-placed limit)
 *      - SL = тот же rangeEdge (исходный SL первичной — НЕ подтягиваем)
 *      - размер = +50% от первичного position units
 *      - тот же TP ladder (50/30/20 splits)
 *   3. Обе сделки живут независимо: full trailing для обеих.
 *
 * Гипотеза: pyramiding-up по тренду. Trigger активируется на УСПЕШНЫХ сделках
 * которые показали momentum (прошли половину к TP1). Selection bias positive —
 * вероятность дойти до TP1 от этой точки выше чем от entry.
 *
 * Риск: если цена после midTP1 откатывается и выбивает SL — scale-in теряет
 * больше (entry дальше от SL geometrically, но размер на 50% больше).
 *
 * Сравнение:
 *   - baseline: одна сделка на сетап (PROD)
 *   - scaleInUp: первичная + scale-in когда цена прошла 50% к TP1
 *
 * Variant B: $320 / 20 conc / 5% target margin / 2% risk per trade
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_scalein_up_B.ts
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
const SCALE_IN_FRAC = 0.5  // +50% от первичного размера

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

type Mode = 'baseline' | 'scaleInUp'

const VARIANT_A = {
  name: 'B' as const,
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

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
// Signal generation
// ============================================================================

interface BreakoutCfg {
  rangeBars: number
  volMultiplier: number
  tp1Mult: number
  tp2Mult: number
  tp3Mult: number
}

interface PrimarySignal extends LadderSignal {
  /** Index of entry candle in symbol's m5 array — used to scan forward for scale-in trigger. */
  entryIdx: number
}

function generateBreakoutSignals(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): PrimarySignal[] {
  const sigs: PrimarySignal[] = []
  const byDay = new Map<string, { candles: OHLCV[]; startIdx: number }>()
  for (let idx = 0; idx < m5.length; idx++) {
    const c = m5[idx]
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, { candles: [], startIdx: idx })
    byDay.get(d)!.candles.push(c)
  }
  for (const [, { candles, startIdx }] of byDay) {
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
        side = 'BUY'; entryPrice = c.close; anchor = rangeHigh
      } else if (c.low < rangeLow && c.close < rangeLow) {
        side = 'SELL'; entryPrice = c.close; anchor = rangeLow
      }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [anchor + rangeSize * cfg.tp1Mult, anchor + rangeSize * cfg.tp2Mult, anchor + rangeSize * cfg.tp3Mult]
        : [anchor - rangeSize * cfg.tp1Mult, anchor - rangeSize * cfg.tp2Mult, anchor - rangeSize * cfg.tp3Mult]
      const tp1Overshoot = side === 'BUY' ? entryPrice >= tpLadder[0] : entryPrice <= tpLadder[0]
      if (tp1Overshoot) continue
      sigs.push({
        side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout',
        entryIdx: startIdx + i,
      })
      triggered = true
    }
  }
  return sigs
}

/**
 * Scan forward from primary entry: find first bar where price touched
 * mid(entry, TP1) — т.е. прошла 50% пути к TP1 в ПЛЮС. Return candle/index or null.
 *
 * Останавливаем поиск если до этого:
 *  - SL hit (низ свечи <= SL для BUY) — сделка уже мертва, scale-in бессмыслен
 *  - TP1 hit (high >= TP1 для BUY) — переcкочили mid-точку, не успели поставить
 *  - End of m5 array
 *
 * Важно: интрабар sequence неизвестен. Если бар одновременно достиг midTP1 wickом
 * и закрылся выше TP1 — мы не знаем, был ли touch midTP1 ДО TP1 hit. Используем
 * close-based для midTP1: бар должен ЗАКРЫТЬСЯ выше midTP1 (не просто wick).
 * Это консервативно — пропускаем некоторые быстрые движения mid→TP1 без отката.
 */
function findScaleInTrigger(
  m5: OHLCV[],
  primaryEntryIdx: number,
  side: 'BUY' | 'SELL',
  entryPrice: number,
  sl: number,
  tp1: number,
): { idx: number; price: number } | null {
  const isLong = side === 'BUY'
  const midTP1 = (entryPrice + tp1) / 2  // 50% way к TP1 (в плюсе)
  for (let i = primaryEntryIdx + 1; i < m5.length; i++) {
    const c = m5[i]
    // SL hit на этом баре до midTP1 close — сделка умерла
    const slHit = isLong ? c.low <= sl : c.high >= sl
    if (slHit) return null
    // TP1 hit без подтверждённого midTP1 close ранее — пропустили момент scale-in
    const tp1Hit = isLong ? c.high >= tp1 : c.low <= tp1
    if (tp1Hit) return null
    // midTP1 trigger: бар ЗАКРЫЛСЯ за midTP1 (для LONG close >= midTP1).
    // Используем close (не wick) чтобы избежать ложного scale-in от wick'а с откатом.
    const midClose = isLong ? c.close >= midTP1 : c.close <= midTP1
    if (midClose) {
      // Entry для scale-in = midTP1 (как pre-placed limit, который сработал на пути
      // вверх когда бар проходил через эту цену).
      return { idx: i, price: midTP1 }
    }
  }
  return null
}

/**
 * Carousel ladder backtester — proven baseline. Возвращает trades в том же формате
 * как в AB-script.
 */
function runLadderBaseline(
  m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number,
): { trades: LadderTrade[]; primarySigs: PrimarySignal[]; periodCandles: OHLCV[] } {
  const sigs = generateBreakoutSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
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
  return { trades, primarySigs: sigs, periodCandles }
}

/**
 * Generate scale-in trades by scanning forward from each primary signal's entry,
 * looking for mid-SL touch. Каждый scale-in запускается через отдельный isolated
 * ladderBacktester run, чтобы получить fills/exit как для обычной сделки.
 *
 * SL для scale-in = SL первичной (тот же rangeEdge).
 * TP для scale-in = тот же TP ladder (anchored на rangeEdge).
 * Splits 50/30/20. Trailing full.
 */
function generateScaleInTrades(
  m5: OHLCV[],
  primarySigs: PrimarySignal[],
): LadderTrade[] {
  const scaleInTrades: LadderTrade[] = []
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: 0, slippagePerSide: 0,
    maxHoldBars: 2304,
  }
  for (const sig of primarySigs) {
    const trigger = findScaleInTrigger(m5, sig.entryIdx, sig.side, sig.entryPrice, sig.sl, sig.tpLadder[0])
    if (!trigger) continue
    // Build scale-in signal: entry on trigger bar at midSL price, same SL/TP as primary.
    const scaleInSig: LadderSignal = {
      side: sig.side,
      entryTime: m5[trigger.idx].time,
      entryPrice: trigger.price,
      sl: sig.sl,
      tpLadder: sig.tpLadder,
      reason: 'scale_in',
    }
    // Slice m5 starting one bar before trigger (so trigger candle is at slice index 1, ladder opens position there)
    const sliceStart = Math.max(0, trigger.idx - 1)
    const slice = m5.slice(sliceStart)
    const sigSliceIdx = trigger.idx - sliceStart
    const r = runLadderBacktest(slice, (i) => (i === sigSliceIdx ? scaleInSig : null), ladderCfg)
    if (r.trades.length > 0) scaleInTrades.push(r.trades[0])
  }
  return scaleInTrades
}

// ============================================================================
// Portfolio model
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
  isScaleIn: boolean
}

function toPortfolioTrade(symbol: string, t: LadderTrade, isScaleIn: boolean): PortfolioTrade {
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
    isScaleIn,
  }
}

// ============================================================================
// Portfolio simulator — copy from AB, with scale-in sizing override
// ============================================================================

interface SimResult {
  mode: Mode
  startingDeposit: number
  signalsTotal: number
  primaryCount: number
  scaleInCount: number
  scaleInWins: number
  scaleInNet: number
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
  tp1Hits: number
  tp2Hits: number
  tp3Hits: number
  slHits: number
  expiredHits: number
  totalFeesUsd: number
  totalSlipUsd: number
}

function simulate(allTrades: PortfolioTrade[], mode: Mode, btc: BtcRegime): SimResult {
  // Sort by entryTime — scale-in trades will naturally fall AFTER their primary
  // since findScaleInTrigger scans forward.
  const sorted = [...allTrades].sort((a, b) => {
    if (a.entryTime !== b.entryTime) return a.entryTime - b.entryTime
    return (a.isScaleIn ? 1 : 0) - (b.isScaleIn ? 1 : 0)
  })
  let currentDeposit = VARIANT_A.startingDeposit
  let peak = VARIANT_A.startingDeposit
  let trough = VARIANT_A.startingDeposit
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
    /** Primary key for matching scale-in to its primary (sym|date). For primary, this is its key. */
    primaryKey: string
    /** Position units of the primary trade (used to size scale-in as 50% of primary). */
    primaryPositionUnits: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let primaryCount = 0, scaleInCount = 0
  let scaleInWins = 0, scaleInNet = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0
  let tp1Hits = 0, tp2Hits = 0, tp3Hits = 0, slHits = 0, expiredHits = 0
  const primaryTaken = new Set<string>()  // (sym|date) → primary opened
  // For scale-in sizing we look up primary's positionUnits via this map.
  const primaryUnitsByKey = new Map<string, number>()

  function applyDD() {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
  }

  function realizeFillsUntil(t: number) {
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.fills.length && a.pt.fills[a.fillsApplied].time <= t) {
        const f = a.pt.fills[a.fillsApplied]
        a.fillsApplied++
        const isMaker = f.reason === 'TP1' || f.reason === 'TP2' || f.reason === 'TP3'
        const isLong = a.pt.side === 'BUY'
        let exitPrice: number
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
        if (f.reason === 'TP1') { a.statusKey = 'TP1_HIT'; tp1Hits++ }
        else if (f.reason === 'TP2') { a.statusKey = 'TP2_HIT'; tp2Hits++ }
        else if (f.reason === 'TP3') tp3Hits++
        else if (f.reason === 'SL') slHits++
        else if (f.reason === 'EXPIRED') expiredHits++
        applyDD()
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        if (a.pt.isScaleIn) {
          scaleInCount++
          if (a.pnlUsd > 0) scaleInWins++
          scaleInNet += a.pnlUsd
        } else {
          primaryCount++
        }
        fullyClosed.push(a.pt)
        active.splice(ai, 1)
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.entryTime)

    if (!btc.isTrending(pt.entryTime)) { skippedBtcAdx++; continue }
    if (active.some(a => a.pt.symbol === pt.symbol && a.pt.utcDate !== pt.utcDate)) {
      skippedCarryOver++; continue
    }
    const key = `${pt.symbol}|${pt.utcDate}`

    if (pt.isScaleIn) {
      if (mode === 'baseline') { skippedSameDay++; continue }
      // Scale-in нужен только если primary был открыт (иначе не на что доливать)
      if (!primaryTaken.has(key)) { skippedSameDay++; continue }
    } else {
      if (primaryTaken.has(key)) { skippedSameDay++; continue }
    }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= VARIANT_A.maxConcurrent) { skippedConcurrent++; continue }

    const isLong = pt.side === 'BUY'
    const effectiveEntry = isLong ? pt.entryPrice * (1 + TAKER_SLIP) : pt.entryPrice * (1 - TAKER_SLIP)

    // Sizing:
    //  - primary: standard 2% risk
    //  - scale-in: 50% of primary's positionUnits (NOT recompute risk — иначе будет много units из-за более близкого SL)
    let sizing: ReturnType<typeof computeSizing>
    let scaleInUnits = 0
    if (pt.isScaleIn) {
      const primaryUnits = primaryUnitsByKey.get(key) ?? 0
      if (primaryUnits <= 0) { skippedMargin++; continue }
      scaleInUnits = primaryUnits * SCALE_IN_FRAC
      // Synthesize sizing struct manually (positionUnits = 50% of primary)
      const positionSizeUsd = scaleInUnits * effectiveEntry
      const marginUsd = positionSizeUsd / Math.max(1, Math.floor(positionSizeUsd / (currentDeposit * VARIANT_A.targetMarginPct / 100)))
      sizing = {
        positionSizeUsd, positionUnits: scaleInUnits,
        marginUsd, leverage: Math.max(1, Math.round(positionSizeUsd / marginUsd)),
        riskUsd: scaleInUnits * slDist,
        cappedByMaxLeverage: false,
      } as any
    } else {
      sizing = computeSizing({
        symbol: pt.symbol, deposit: currentDeposit,
        riskPct: RISK_PCT, targetMarginPct: VARIANT_A.targetMarginPct,
        entry: effectiveEntry, sl: pt.sl,
      })
      if (!sizing) { skippedMargin++; continue }
    }
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
    const entryFee = entryNotional * TAKER_FEE
    currentDeposit -= entryFee
    totalFees += entryFee
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.entryPrice)
    totalSlip += entrySlip
    applyDD()

    if (pt.isScaleIn) {
      // no-op: primaryTaken already set
    } else {
      primaryTaken.add(key)
      primaryUnitsByKey.set(key, sizing.positionUnits)
    }
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
      primaryKey: key,
      primaryPositionUnits: pt.isScaleIn ? (primaryUnitsByKey.get(key) ?? 0) : sizing.positionUnits,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    if (a.pt.isScaleIn) {
      scaleInCount++
      if (a.pnlUsd > 0) scaleInWins++
      scaleInNet += a.pnlUsd
    } else {
      primaryCount++
    }
    fullyClosed.push(a.pt)
  }

  return {
    mode, startingDeposit: VARIANT_A.startingDeposit,
    signalsTotal: allTrades.length,
    primaryCount, scaleInCount, scaleInWins, scaleInNet,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    tp1Hits, tp2Hits, tp3Hits, slHits, expiredHits,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
  }
}

// ============================================================================
// Output
// ============================================================================

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} [${r.mode}] ($${r.startingDeposit} start) ---`)
  console.log(
    `signals=${r.signalsTotal} (primary=${r.primaryCount} scaleIn=${r.scaleInCount}) | ` +
    `skip btcAdx=${r.skippedBtcAdx} carry=${r.skippedCarryOver} sameDay=${r.skippedSameDay} ` +
    `conc=${r.skippedConcurrent} margin=${r.skippedMargin} | opened=${r.opened}`
  )
  console.log(
    `totalR=${fmtR(r.totalR)} R/tr=${fmtR(r.rPerTr)} WR=${r.winRate.toFixed(0)}% | ` +
    `final=$${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) ` +
    `peak=$${r.peakDeposit.toFixed(0)} min=$${r.minDeposit.toFixed(0)} DD=${r.maxDD.toFixed(1)}%`
  )
  console.log(
    `TP1=${r.tp1Hits} TP2=${r.tp2Hits} TP3=${r.tp3Hits} SL=${r.slHits} EXPIRED=${r.expiredHits}`
  )
  if (r.scaleInCount > 0) {
    const swr = (r.scaleInWins / r.scaleInCount) * 100
    console.log(`scaleIn: ${r.scaleInCount} trades, WR ${swr.toFixed(0)}%, net ${fmtUsd(r.scaleInNet)}`)
  }
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)}`)
}

async function main() {
  console.log('Daily Breakout — Variant B: baseline vs scale-in UP (pyramiding @ 50% to TP1)')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`Variant B: $320 / 20 conc / 5% margin / 2% risk / taker entry`)
  console.log(`BTC ADX>${BTC_ADX_THRESHOLD} | TP ${TP_MULTS.join('/')}R splits ${SPLITS.join('/')}`)
  console.log(`Period: 365d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log()
  console.log('SCALE-IN UP LOGIC (pyramiding):')
  console.log('  - Trigger: бар ЗАКРЫЛСЯ за mid(entry, TP1) — цена прошла 50% к TP1 (в плюсе)')
  console.log('  - Размер: +50% от первичного position units')
  console.log('  - Entry: mid(entry, TP1) — limit fill на этой цене')
  console.log('  - SL: тот же rangeEdge что у первичной (НЕ подтягиваем)')
  console.log('  - TP ladder: тот же')
  console.log('  - Trailing: full (TP1→BE, TP2→TP1, TP3→TP2)')
  console.log('  - Если SL hit ДО midTP1 close → scale-in не выставляется')
  console.log('  - Если TP1 hit ДО midTP1 close → пропустили момент, scale-in skip')
  console.log('  - Selection bias POSITIVE: scale-in активируется на winning сделках')
  console.log('    с подтверждённым momentum (close beyond midpoint)')
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

  const cfg: BreakoutCfg = {
    rangeBars: RANGE_BARS, volMultiplier: VOL_MULT,
    tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2],
  }

  type Pool = { primary: PortfolioTrade[]; scaleIn: PortfolioTrade[] }
  type Pools = { full: Pool; train: Pool; test: Pool }
  const pools: Pools = {
    full: { primary: [], scaleIn: [] },
    train: { primary: [], scaleIn: [] },
    test: { primary: [], scaleIn: [] },
  }
  for (const [sym, m5] of m5BySymbol.entries()) {
    for (const [periodKey, from, to] of [
      ['full', fullStart, now],
      ['train', fullStart, trainEnd],
      ['test', trainEnd, now],
    ] as const) {
      const { trades, primarySigs } = runLadderBaseline(m5, cfg, from, to)
      trades.forEach(t => pools[periodKey].primary.push(toPortfolioTrade(sym, t, false)))
      const scaleInTrades = generateScaleInTrades(m5, primarySigs)
      // scale-in trades may have entryTime outside [from, to] only if primary entry was near
      // the period boundary — отфильтруем чтобы scale-in вошёл в тот же период что и primary
      scaleInTrades
        .filter(t => t.entryTime >= from && t.entryTime <= to)
        .forEach(t => pools[periodKey].scaleIn.push(toPortfolioTrade(sym, t, true)))
    }
  }

  console.log('================== Pool sizes ==================')
  console.log(`primary: FULL ${pools.full.primary.length} | TRAIN ${pools.train.primary.length} | TEST ${pools.test.primary.length}`)
  console.log(`scaleIn: FULL ${pools.full.scaleIn.length} | TRAIN ${pools.train.scaleIn.length} | TEST ${pools.test.scaleIn.length}`)
  console.log(`scale-in conversion ratio (FULL): ${(pools.full.scaleIn.length / Math.max(1, pools.full.primary.length) * 100).toFixed(0)}% of primary trades trigger scale-in`)
  console.log()

  // Baseline validation
  const validate = simulate(pools.full.primary, 'baseline', btc)
  console.log(`Baseline check (must be ≈$329-$333 from AB-script for B): final=$${validate.finalDeposit.toFixed(2)}`)
  console.log()

  for (const [periodName, periodKey] of [['FULL (365d)', 'full'], ['TRAIN (60%, ~219d)', 'train'], ['TEST (40%, ~146d)', 'test']] as const) {
    console.log(`================== ${periodName} ==================`)
    const baselineRes = simulate(pools[periodKey].primary, 'baseline', btc)
    const allTrades = [...pools[periodKey].primary, ...pools[periodKey].scaleIn]
    const scaleInRes = simulate(allTrades, 'scaleInUp', btc)
    printResult(periodName, baselineRes); console.log()
    printResult(periodName, scaleInRes); console.log()
    const retB = ((baselineRes.finalDeposit / baselineRes.startingDeposit - 1) * 100)
    const retS = ((scaleInRes.finalDeposit / scaleInRes.startingDeposit - 1) * 100)
    console.log(
      `Δ: Δret=${(retS - retB) >= 0 ? '+' : ''}${(retS - retB).toFixed(0)}pp | ` +
      `Δr/tr=${fmtR(scaleInRes.rPerTr - baselineRes.rPerTr)} | ` +
      `ΔWR=${(scaleInRes.winRate - baselineRes.winRate) >= 0 ? '+' : ''}${(scaleInRes.winRate - baselineRes.winRate).toFixed(0)}pp | ` +
      `ΔDD=${(scaleInRes.maxDD - baselineRes.maxDD) >= 0 ? '+' : ''}${(scaleInRes.maxDD - baselineRes.maxDD).toFixed(0)}pp | ` +
      `Δopened=+${scaleInRes.opened - baselineRes.opened}`
    )
    console.log()
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
