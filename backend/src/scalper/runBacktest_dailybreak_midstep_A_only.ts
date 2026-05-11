/**
 * Daily Breakout — Variant A ONLY: full vs midStep trailing SL backtest.
 *
 * АРХИТЕКТУРА: ровно как AB-script (proven baseline), только меняем trailingMode.
 *   - generateBreakoutSignals: один сигнал в день per symbol (как в AB)
 *   - ladderBacktester carousel: одна позиция за раз, следующий сигнал ждёт закрытия (как в AB)
 *   - Portfolio simulator A: $500 / 10 conc / 10% target margin / 2% risk per trade
 *
 * Это даст бaseline ПОЛНОСТЬЮ совпадающий с AB-script: A FULL ≈ $2188 (+338%).
 *
 * Pool size в midStep будет БОЛЬШЕ чем в full (midStep сделки короткие → carousel
 * освобождается быстрее → больше сделок проходит). Это РЕАЛЬНЫЙ эффект который
 * случится в проде: midStep = больше торговли = больше fees.
 *
 * TRAILING MODES:
 *   full    — TP1→BE, TP2→TP1, TP3→TP2 (текущий PROD)
 *   midStep — mid(entry,TP1) close-reached → SL=BE
 *             TP1 hit                       → SL=mid(entry,TP1)
 *             mid(TP1,TP2) close-reached    → SL=TP1
 *             TP2 hit                       → SL=mid(TP1,TP2)
 *             mid(TP2,TP3) close-reached    → SL=TP2
 *             TP3 hit                       → SL=mid(TP2,TP3)
 *             Partials берутся ТОЛЬКО на TP1/TP2/TP3 (splits 50/30/20).
 *             Mid-точка триггерится по c.close (не wick), чтобы избежать
 *             ложного SL hit на том же баре от низа свечи.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_midstep_A_only.ts
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

type TrailMode = 'full' | 'midStep'

const VARIANT_A = {
  name: 'A' as const,
  startingDeposit: 500,
  maxConcurrent: 10,
  targetMarginPct: 10,
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
// Signal generation (verbatim from AB-script)
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
        ? [anchor + rangeSize * cfg.tp1Mult, anchor + rangeSize * cfg.tp2Mult, anchor + rangeSize * cfg.tp3Mult]
        : [anchor - rangeSize * cfg.tp1Mult, anchor - rangeSize * cfg.tp2Mult, anchor - rangeSize * cfg.tp3Mult]
      const tp1Overshoot = side === 'BUY' ? entryPrice >= tpLadder[0] : entryPrice <= tpLadder[0]
      if (tp1Overshoot) continue
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

/**
 * Carousel ladder backtester — точно как в AB-script.
 * Одна позиция за раз; следующий сигнал отбрасывается если ladder занят.
 */
function runLadderRaw(
  m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number,
  trailingMode: TrailMode,
): LadderTrade[] {
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
    trailingMode,
    feesRoundTrip: 0, slippagePerSide: 0,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

// ============================================================================
// PortfolioTrade
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
// Portfolio simulator (copy from AB-script)
// ============================================================================

interface SimResult {
  trailMode: TrailMode
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
  tp1Hits: number
  tp2Hits: number
  tp3Hits: number
  slHits: number
  expiredHits: number
  totalFeesUsd: number
  totalSlipUsd: number
}

function simulate(allTrades: PortfolioTrade[], trailMode: TrailMode, btc: BtcRegime): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
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
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0
  let tp1Hits = 0, tp2Hits = 0, tp3Hits = 0, slHits = 0, expiredHits = 0
  const takenSet = new Set<string>()

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
    if (takenSet.has(key)) { skippedSameDay++; continue }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= VARIANT_A.maxConcurrent) { skippedConcurrent++; continue }

    const isLong = pt.side === 'BUY'
    const effectiveEntry = isLong ? pt.entryPrice * (1 + TAKER_SLIP) : pt.entryPrice * (1 - TAKER_SLIP)

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_A.targetMarginPct,
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
    const entryFee = entryNotional * TAKER_FEE
    currentDeposit -= entryFee
    totalFees += entryFee
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.entryPrice)
    totalSlip += entrySlip
    applyDD()

    takenSet.add(`${pt.symbol}|${pt.utcDate}`)
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
    trailMode,
    startingDeposit: VARIANT_A.startingDeposit,
    signalsTotal: allTrades.length,
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

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} [${r.trailMode}] ($${r.startingDeposit} start) ---`)
  console.log(
    `signals=${r.signalsTotal} | ` +
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
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)}`)
}

async function main() {
  console.log('Daily Breakout — Variant A ONLY: full vs midStep trailing SL')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`Variant A: $500 / 10 conc / 10% margin / 2% risk / taker entry`)
  console.log(`BTC ADX>${BTC_ADX_THRESHOLD} | TP ${TP_MULTS.join('/')}R splits ${SPLITS.join('/')}`)
  console.log(`Period: 365d | Train ${TRAIN_PCT * 100}% / Test ${(1 - TRAIN_PCT) * 100}%`)
  console.log()
  console.log('full:    TP1→BE, TP2→TP1, TP3→TP2 (PROD now)')
  console.log('midStep: mid(entry,TP1) close → SL=BE, TP1 → SL=mid(entry,TP1),')
  console.log('         mid(TP1,TP2) close → SL=TP1, TP2 → SL=mid(TP1,TP2),')
  console.log('         mid(TP2,TP3) close → SL=TP2, TP3 → SL=mid(TP2,TP3).')
  console.log('         Partials TP1/TP2/TP3 как обычно (splits 50/30/20).')
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

  type ScenarioPool = { full: PortfolioTrade[]; train: PortfolioTrade[]; test: PortfolioTrade[] }
  const pools: Record<TrailMode, ScenarioPool> = {
    full: { full: [], train: [], test: [] },
    midStep: { full: [], train: [], test: [] },
  }
  for (const [sym, m5] of m5BySymbol.entries()) {
    for (const trailMode of ['full', 'midStep'] as const) {
      runLadderRaw(m5, cfg, fullStart, now, trailMode).forEach(t => pools[trailMode].full.push(toPortfolioTrade(sym, t)))
      runLadderRaw(m5, cfg, fullStart, trainEnd, trailMode).forEach(t => pools[trailMode].train.push(toPortfolioTrade(sym, t)))
      runLadderRaw(m5, cfg, trainEnd, now, trailMode).forEach(t => pools[trailMode].test.push(toPortfolioTrade(sym, t)))
    }
  }

  console.log('================== Pool sizes ==================')
  console.log(`full trail:    FULL ${pools.full.full.length} | TRAIN ${pools.full.train.length} | TEST ${pools.full.test.length}`)
  console.log(`midStep trail: FULL ${pools.midStep.full.length} | TRAIN ${pools.midStep.train.length} | TEST ${pools.midStep.test.length}`)
  console.log('(midStep pool обычно больше: короткие сделки → carousel освобождается → больше сигналов проходит)')
  console.log()

  // Validation: baseline должен совпадать с AB-script ($2188 (+338%))
  console.log('Validating baseline (must be close to AB-script FULL A = $2188 (+338%))...')
  const fullCheck = simulate(pools.full.full, 'full', btc)
  console.log(`baseline check: final=$${fullCheck.finalDeposit.toFixed(2)} (expected ≈$2188)`)
  if (Math.abs(fullCheck.finalDeposit - 2188) < 100) console.log('✓ baseline matches AB-script')
  else console.warn('⚠ baseline diverges from AB-script — investigate')
  console.log()

  for (const [periodName, periodKey] of [['FULL (365d)', 'full'], ['TRAIN (60%, ~219d)', 'train'], ['TEST (40%, ~146d)', 'test']] as const) {
    console.log(`================== ${periodName} ==================`)
    const fullRes = simulate(pools.full[periodKey], 'full', btc)
    const midStepRes = simulate(pools.midStep[periodKey], 'midStep', btc)
    printResult(periodName, fullRes); console.log()
    printResult(periodName, midStepRes); console.log()
    const retF = ((fullRes.finalDeposit / fullRes.startingDeposit - 1) * 100)
    const retM = ((midStepRes.finalDeposit / midStepRes.startingDeposit - 1) * 100)
    console.log(
      `Δ: Δret=${(retM - retF) >= 0 ? '+' : ''}${(retM - retF).toFixed(0)}pp | ` +
      `Δr/tr=${fmtR(midStepRes.rPerTr - fullRes.rPerTr)} | ` +
      `ΔWR=${(midStepRes.winRate - fullRes.winRate) >= 0 ? '+' : ''}${(midStepRes.winRate - fullRes.winRate).toFixed(0)}pp | ` +
      `ΔDD=${(midStepRes.maxDD - fullRes.maxDD) >= 0 ? '+' : ''}${(midStepRes.maxDD - fullRes.maxDD).toFixed(0)}pp | ` +
      `Δopened=${midStepRes.opened - fullRes.opened >= 0 ? '+' : ''}${midStepRes.opened - fullRes.opened}`
    )
    console.log(
      `Δ TP/SL: TP1 ${fullRes.tp1Hits}→${midStepRes.tp1Hits} (${midStepRes.tp1Hits - fullRes.tp1Hits >= 0 ? '+' : ''}${midStepRes.tp1Hits - fullRes.tp1Hits}) | ` +
      `TP2 ${fullRes.tp2Hits}→${midStepRes.tp2Hits} (${midStepRes.tp2Hits - fullRes.tp2Hits >= 0 ? '+' : ''}${midStepRes.tp2Hits - fullRes.tp2Hits}) | ` +
      `TP3 ${fullRes.tp3Hits}→${midStepRes.tp3Hits} (${midStepRes.tp3Hits - fullRes.tp3Hits >= 0 ? '+' : ''}${midStepRes.tp3Hits - fullRes.tp3Hits}) | ` +
      `SL ${fullRes.slHits}→${midStepRes.slHits} (${midStepRes.slHits - fullRes.slHits >= 0 ? '+' : ''}${midStepRes.slHits - fullRes.slHits}) | ` +
      `EXPIRED ${fullRes.expiredHits}→${midStepRes.expiredHits}`
    )
    console.log()
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
