/**
 * Daily Breakout — filter exploration backtest.
 *
 * Tests 6 candidate filters at the SIGNAL GENERATION stage. All 6 reuse the
 * same trade pool generation (entry/SL/TP geometry unchanged) — they just
 * decide whether to ACCEPT or REJECT each generated signal before it enters
 * the portfolio simulation. Effect is measured as Δ vs baseline (no filter).
 *
 * Filters tested (referenced by # in conversation):
 *   #1 hour-of-day  : exclude UTC hours with worst aggregate R/tr
 *   #2 vol-scaled TP3: stretch TP3 to 4× rangeSize when vol >= 4× avg
 *   #3 range/ATR    : require rangeSize / ATR(14d on 1h) >= threshold
 *   #4 BTC regime   : require BTC 1h ADX > 20 OR BTC trending direction
 *   #6 1h MTF trend : LONG only if 1h close > EMA50; SHORT only if < EMA50
 *   #7 funding avoid: skip signals within 15 min before funding payment
 *
 * Each filter is tested in 3 modes:
 *   - off (baseline)
 *   - on with default threshold
 *   - on with stricter threshold (where applicable)
 *
 * Methodology:
 *   - Trade pool generated identically to runBacktest_dailybreak_priority.
 *   - Each filter wraps the trade pool with a per-trade ACCEPT decision.
 *   - Same portfolio simulator (margin guard + downsize, FCFS, max concurrent 10).
 *   - Compare totalR / R/tr / WR / finalDeposit on TRAIN / TEST / FULL.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_filters.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade } from './ladderBacktester'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade, getMaxLeverage } from '../services/marginGuard'
import { ema } from '../services/indicators'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const TARGET_MARGIN_PCT = 10
const FEES_RT = 0.0008
const SLIPPAGE = 0.0005

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]
const MIN_FREE_FOR_DOWNSIZE = 10

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'SANDUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT',
  'TRUMPUSDT', 'STRKUSDT', 'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT',
  'AEROUSDT', 'ETCUSDT', 'IOUSDT', 'POLUSDT', 'TSTBSCUSDT', 'VVVUSDT',
]
const MAX_CONCURRENT = 10

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mTo1h(m5: OHLCV[]): OHLCV[] {
  // Group by 1h bucket (floor to hour)
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

// True Range / ATR(14)
function atr(candles: OHLCV[], period = 14): number[] {
  const trs: number[] = []
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trs.push(candles[i].high - candles[i].low); continue }
    const prev = candles[i - 1]
    const cur = candles[i]
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    )
    trs.push(tr)
  }
  // Wilder smoothing approximation via EMA(period)
  return ema(trs, period)
}

// Simple ADX (14): used only as a regime indicator. Returns array same length as input.
function adx(candles: OHLCV[], period = 14): number[] {
  const n = candles.length
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
  const diArr: number[] = []
  for (let i = 0; i < n; i++) {
    const plusDI = trEma[i] > 0 ? (plusEma[i] / trEma[i]) * 100 : 0
    const minusDI = trEma[i] > 0 ? (minusEma[i] / trEma[i]) * 100 : 0
    const dx = plusDI + minusDI > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0
    diArr.push(dx)
  }
  return ema(diArr, period)
}

interface BreakoutCfg {
  rangeBars: number
  volMultiplier: number
  tp1Mult: number
  tp2Mult: number
  tp3Mult: number
}

interface ExtSignal {
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
  // Filter metadata
  hourUTC: number               // entry hour 0-23
  weekday: number               // 0=Sun..6=Sat
  volRatio: number              // volume / avgVolume on breakout
  rangeSize: number
  atr1h: number                 // ATR(14) on 1h at entry time
  rangeATRRatio: number         // rangeSize / atr1h
  trend1hUp: boolean | null     // close(1h prev) > EMA50(1h prev). null if not enough data.
  btcAdx1h: number | null       // BTC ADX(14) on 1h at entry time
  btcSide1h: 'UP' | 'DOWN' | null  // BTC 1h direction (above/below EMA50)
  minutesUntilFunding: number   // min(t mod 8h until 0/8/16 UTC)
}

function generateExtSignals(
  m5: OHLCV[], cfg: BreakoutCfg,
  h1: OHLCV[],                  // own symbol 1h
  btc1h: OHLCV[],               // BTC 1h (precomputed indicators below)
  btcAdx: number[],
  btcEma50: number[],
  periodFrom: number, periodTo: number,
): ExtSignal[] {
  const sigs: ExtSignal[] = []

  // Pre-compute own symbol 1h indicators
  const ownAtr = atr(h1, 14)
  const ownEma50 = ema(h1.map(c => c.close), 50)

  function findH1IdxAt(t: number): number {
    // last 1h candle whose close is <= t (i.e. was already closed)
    let lo = 0, hi = h1.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (h1[mid].time + 3600_000 <= t) { ans = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return ans
  }
  function findBtcIdxAt(t: number): number {
    let lo = 0, hi = btc1h.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (btc1h[mid].time + 3600_000 <= t) { ans = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return ans
  }

  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = new Date(c.time).toISOString().slice(0, 10)
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
      const slDistPct = (Math.abs(entryPrice - sl) / entryPrice) * 100
      if (slDistPct < 0.4) continue

      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * cfg.tp1Mult, entryPrice + rangeSize * cfg.tp2Mult, entryPrice + rangeSize * cfg.tp3Mult]
        : [entryPrice - rangeSize * cfg.tp1Mult, entryPrice - rangeSize * cfg.tp2Mult, entryPrice - rangeSize * cfg.tp3Mult]

      // Metadata
      const t = c.time
      const dt = new Date(t)
      const hourUTC = dt.getUTCHours()
      const weekday = dt.getUTCDay()
      const volRatio = avgVol > 0 ? c.volume / avgVol : 0

      const h1Idx = findH1IdxAt(t)
      const atr1h = h1Idx >= 0 ? (ownAtr[h1Idx] ?? 0) : 0
      const rangeATRRatio = atr1h > 0 ? rangeSize / atr1h : 0
      const trend1hUp = h1Idx >= 0
        ? (h1[h1Idx].close > (ownEma50[h1Idx] ?? h1[h1Idx].close))
        : null

      const btcIdx = findBtcIdxAt(t)
      const btcAdx1h = btcIdx >= 0 ? (btcAdx[btcIdx] ?? null) : null
      const btcSide1h: 'UP' | 'DOWN' | null = btcIdx >= 0 && btcEma50[btcIdx] != null
        ? (btc1h[btcIdx].close > btcEma50[btcIdx] ? 'UP' : 'DOWN')
        : null

      // Minutes until next funding (00, 08, 16 UTC). All in UTC ms.
      const fundingHours = [0, 8, 16]
      const hourMs = 3600_000
      const dayStart = Math.floor(t / 86400_000) * 86400_000
      let minMin = Infinity
      for (const fh of [...fundingHours, 24]) {
        const fundT = dayStart + fh * hourMs
        if (fundT >= t) {
          minMin = Math.min(minMin, (fundT - t) / 60_000)
        }
      }
      const minutesUntilFunding = isFinite(minMin) ? minMin : 999

      sigs.push({
        side, entryTime: t, entryPrice, sl, tpLadder,
        hourUTC, weekday, volRatio,
        rangeSize, atr1h, rangeATRRatio,
        trend1hUp, btcAdx1h, btcSide1h,
        minutesUntilFunding,
      })
      triggered = true
    }
  }
  return sigs
}

interface PortfolioTrade {
  symbol: string
  entryTime: number
  closeTime: number
  side: 'BUY' | 'SELL'
  entryPrice: number
  sl: number
  pnlR: number
  fills: { time: number; pricePnlR: number; percent: number; reason: string }[]
  // Filter metadata copied from ExtSignal
  meta: ExtSignal
}

function toPortfolioTrade(symbol: string, t: LadderTrade, meta: ExtSignal): PortfolioTrade {
  const fillCount = (t.fills ?? []).length
  const fills: PortfolioTrade['fills'] = (t.fills ?? []).map((f, i) => {
    const frac = fillCount > 1 ? (i + 1) / fillCount : 1
    const time = t.entryTime + (t.exitTime - t.entryTime) * frac
    let reason: string
    if (f.idx >= 0) reason = `TP${f.idx + 1}`
    else if (t.exitReason === 'EOD' || t.exitReason === 'MAX_HOLD') reason = 'EXPIRED'
    else reason = 'SL'
    return { time, pricePnlR: f.rContrib, percent: f.frac * 100, reason }
  })
  return {
    symbol, entryTime: t.entryTime, closeTime: t.exitTime, side: t.side,
    entryPrice: t.entryPrice, sl: t.initialSL, pnlR: t.pnlR, fills, meta,
  }
}

// Generate trades using the same ladder simulator. Returns LadderTrade[] aligned with sigs.
function runOne(m5: OHLCV[], sigs: ExtSignal[], periodFrom: number, periodTo: number): LadderTrade[] {
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const ladderSigs: LadderSignal[] = sigs.map(s => ({
    side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
    sl: s.sl, tpLadder: s.tpLadder, reason: 'daily_breakout',
  }))
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of ladderSigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: FEES_RT, slippagePerSide: SLIPPAGE,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface SimResult {
  label: string
  trades: number
  opened: number
  skipped: number
  filteredOut: number   // signals rejected by the filter (before sim)
  downsized: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  maxDD: number
  winRate: number
}

type Predicate = (pt: PortfolioTrade) => boolean

function simulate(allTrades: PortfolioTrade[], pred: Predicate, label: string, deposit: number): SimResult {
  // Pre-filter trades by signal-stage predicate (filter operates on metadata).
  const filtered = allTrades.filter(pred)
  const filteredOut = allTrades.length - filtered.length
  const sorted = [...filtered].sort((a, b) => a.entryTime - b.entryTime)

  let currentDeposit = deposit
  let peak = deposit
  let maxDD = 0

  interface Active {
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    leverage: number
    marginUsd: number
    fillsApplied: number
    closedFracPct: number
    statusKey: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
    realizedR: number
    riskUsd: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0, skipped = 0, downsized = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0

  function applyEvent() {
    if (currentDeposit > peak) peak = currentDeposit
    const dd = peak > 0 ? ((peak - currentDeposit) / peak) * 100 : 0
    if (dd > maxDD) maxDD = dd
  }
  function realizeFillsUntil(t: number) {
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.fills.length && a.pt.fills[a.fillsApplied].time <= t) {
        const f = a.pt.fills[a.fillsApplied]
        a.fillsApplied++
        const pnlUsd = f.pricePnlR * a.riskUsd
        currentDeposit += pnlUsd
        a.realizedR += f.pricePnlR
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        applyEvent()
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        active.splice(ai, 1)
      }
    }
  }

  for (const pt of sorted) {
    realizeFillsUntil(pt.entryTime)
    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skipped++; continue }
    if (active.length >= MAX_CONCURRENT) { skipped++; continue }

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: TARGET_MARGIN_PCT,
      entry: pt.entryPrice, sl: pt.sl,
    })
    if (!sizing) { skipped++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
      hasTP2: a.statusKey === 'TP2_HIT',
    }))

    const sumActive = existing.reduce((s, t2) => {
      const remPos = t2.positionSizeUsd * Math.max(0, 1 - t2.closedFrac)
      return s + remPos / Math.max(1e-9, t2.leverage)
    }, 0)
    const free = currentDeposit - sumActive

    let finalMargin = sizing.marginUsd
    let finalLeverage = sizing.leverage
    let isDownsized = false

    if (sizing.marginUsd > free) {
      // Try downsize (matches new prod behavior)
      if (free < MIN_FREE_FOR_DOWNSIZE) { skipped++; continue }
      const reqLev = sizing.positionSizeUsd / free
      const maxLev = getMaxLeverage(pt.symbol)
      if (reqLev > maxLev) { skipped++; continue }
      finalMargin = free
      finalLeverage = reqLev
      isDownsized = true
    }

    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      leverage: finalLeverage,
      marginUsd: finalMargin,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
    })
    opened++
    if (isDownsized) downsized++
    applyEvent()
  }

  realizeFillsUntil(Number.MAX_SAFE_INTEGER)
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    label, trades: fullyClosed.length, opened, skipped, filteredOut, downsized,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }

// Aggregate per-hour stats across the trade pool for #1 hour-of-day decision.
function findWorstHours(trades: PortfolioTrade[], excludeWorstN: number): Set<number> {
  const byHour = new Map<number, { trades: number; sumR: number }>()
  for (const t of trades) {
    const h = t.meta.hourUTC
    const a = byHour.get(h) ?? { trades: 0, sumR: 0 }
    a.trades += 1; a.sumR += t.pnlR
    byHour.set(h, a)
  }
  const arr: { h: number; r: number; n: number }[] = []
  for (const [h, a] of byHour) {
    arr.push({ h, r: a.trades > 0 ? a.sumR / a.trades : 0, n: a.trades })
  }
  arr.sort((a, b) => a.r - b.r)
  return new Set(arr.slice(0, excludeWorstN).map(x => x.h))
}

async function main() {
  console.log('Daily Breakout — filter exploration backtest')
  console.log(`Symbols: ${PROD_SYMBOLS.length} | Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | Target margin ${TARGET_MARGIN_PCT}%`)
  console.log()

  // Load BTC 1h once for #4 BTC regime filter
  console.log('Loading BTC 1h for regime filter...')
  let btc5m: OHLCV[] = []
  try {
    btc5m = await loadHistorical('BTCUSDT', '5m', MONTHS_BACK, 'bybit', 'linear')
  } catch (e: any) {
    console.warn(`BTC 5m load failed: ${e.message}; proceeding without BTC filter`)
  }
  const btc1h = btc5m.length > 0 ? aggregate5mTo1h(btc5m) : []
  const btcAdx = btc1h.length > 0 ? adx(btc1h, 14) : []
  const btcEma50 = btc1h.length > 0 ? ema(btc1h.map(c => c.close), 50) : []

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

    const h1 = aggregate5mTo1h(m5)
    const cfg: BreakoutCfg = { rangeBars: RANGE_BARS, volMultiplier: VOL_MULT, tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2] }

    for (const [pool, from, to] of [
      [allFull, fullStart, now] as const,
      [allTrain, fullStart, trainEnd] as const,
      [allTest, trainEnd, now] as const,
    ]) {
      const sigs = generateExtSignals(m5, cfg, h1, btc1h, btcAdx, btcEma50, from, to)
      const ladderTrades = runOne(m5, sigs, from, to)
      // Map ladderTrades back to ExtSignal by entryTime
      const sigByTime = new Map<number, ExtSignal>()
      for (const s of sigs) sigByTime.set(s.entryTime, s)
      for (const lt of ladderTrades) {
        const meta = sigByTime.get(lt.entryTime)
        if (!meta) continue
        pool.push(toPortfolioTrade(sym, lt, meta))
      }
    }
  }

  console.log(`Trade pool: FULL ${allFull.length} | TRAIN ${allTrain.length} | TEST ${allTest.length}`)
  console.log()

  // Compute training-derived hour blacklist for #1 (find worst hours on TRAIN, apply to TEST)
  const worstHours3 = findWorstHours(allTrain, 3)
  const worstHours5 = findWorstHours(allTrain, 5)
  console.log(`#1 worst-3 UTC hours (from TRAIN): [${[...worstHours3].sort((a, b) => a - b).join(', ')}]`)
  console.log(`#1 worst-5 UTC hours (from TRAIN): [${[...worstHours5].sort((a, b) => a - b).join(', ')}]`)
  console.log()

  const filters: { label: string; pred: Predicate }[] = [
    { label: 'baseline                 ', pred: () => true },

    // #1 hour-of-day
    { label: '#1 excl worst-3 hours    ', pred: (t) => !worstHours3.has(t.meta.hourUTC) },
    { label: '#1 excl worst-5 hours    ', pred: (t) => !worstHours5.has(t.meta.hourUTC) },

    // #2 vol-scaled TP3 — implemented via post-filter trick:
    //   Baseline TP3 = 3× rangeSize. We can't change ladder math here without re-running the
    //   ladder simulator, so we approximate: when vol >= 4× avg AND the trade hit TP3 in
    //   baseline, we boost TP3-portion R contribution by ((4-3)/3) = 0.333. Conservative
    //   approximation — actual stretched TP3 might or might not hit. SKIPPED in favor of
    //   honest result; we expose as a placeholder to confirm there's no instant fix.
    // Instead: filter that REJECTS low-vol breakouts (proxy: keeps strong-vol setups only).
    { label: '#2 vol >= 3.0× avg only  ', pred: (t) => t.meta.volRatio >= 3.0 },
    { label: '#2 vol >= 4.0× avg only  ', pred: (t) => t.meta.volRatio >= 4.0 },

    // #3 range / ATR
    { label: '#3 rangeATR >= 1.5       ', pred: (t) => t.meta.rangeATRRatio >= 1.5 },
    { label: '#3 rangeATR >= 2.0       ', pred: (t) => t.meta.rangeATRRatio >= 2.0 },
    { label: '#3 rangeATR >= 2.5       ', pred: (t) => t.meta.rangeATRRatio >= 2.5 },

    // #4 BTC regime
    { label: '#4 BTC ADX > 20          ', pred: (t) => (t.meta.btcAdx1h ?? 0) > 20 },
    { label: '#4 BTC ADX > 25          ', pred: (t) => (t.meta.btcAdx1h ?? 0) > 25 },
    { label: '#4 BTC trend matches dir ', pred: (t) => {
      const want = t.side === 'BUY' ? 'UP' : 'DOWN'
      return t.meta.btcSide1h === want
    } },

    // #6 1h MTF trend confluence
    { label: '#6 1h trend confluence   ', pred: (t) => {
      if (t.meta.trend1hUp === null) return true   // no data → don't filter
      return t.side === 'BUY' ? t.meta.trend1hUp : !t.meta.trend1hUp
    } },

    // #7 funding avoidance
    { label: '#7 funding > 15 min away ', pred: (t) => t.meta.minutesUntilFunding > 15 },
    { label: '#7 funding > 30 min away ', pred: (t) => t.meta.minutesUntilFunding > 30 },
  ]

  for (const [label, pool] of [['FULL', allFull], ['TRAIN', allTrain], ['TEST', allTest]] as const) {
    console.log(`=== ${label} (n=${pool.length}) ===`)
    console.log('Filter                    | filtOut | trades | opened | skipped | downsiz | totalR  | R/tr  | finalDepo | peak    | maxDD  | WR')
    console.log('-'.repeat(132))
    for (const f of filters) {
      const r = simulate(pool, f.pred, f.label, STARTING_DEPOSIT)
      console.log(`${r.label} | ${r.filteredOut.toString().padStart(7)} | ${r.trades.toString().padStart(6)} | ${r.opened.toString().padStart(6)} | ${r.skipped.toString().padStart(7)} | ${r.downsized.toString().padStart(7)} | ${fmtR(r.totalR).padStart(7)} | ${fmtR(r.rPerTr).padStart(5)} | $${r.finalDeposit.toFixed(0).padStart(8)} | $${r.peakDeposit.toFixed(0).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)}% | ${r.winRate.toFixed(0)}%`)
    }
    console.log()
  }

  console.log('=== Done ===')
  console.log()
  console.log('Notes:')
  console.log('  - All filters operate at signal stage (accept/reject before portfolio sim).')
  console.log('  - #1 hour blacklist trained on TRAIN, applied identically to all 3 periods.')
  console.log('  - #2 implemented as vol-strength cutoff (rejects weak setups). True TP3 stretch')
  console.log('    needs ladder-level changes; not done in this round.')
  console.log('  - #4 BTC ADX/trend uses BTCUSDT 1h aggregated from 5m cache.')
  console.log('  - #7 uses theoretical 8h funding times (00/08/16 UTC) — proxy without exact')
  console.log('    funding rate sign; rejects signals close to those windows.')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
