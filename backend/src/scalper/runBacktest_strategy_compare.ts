/**
 * Strategy comparison backtest:
 *
 * Сравниваем 5 стратегий на одинаковых условиях:
 *   - Депо $500, риск 2% per trade, max 10 concurrent positions
 *   - Walk-forward: FULL (365d) / TRAIN (60% = 219d) / TEST (40% = 146d)
 *   - 15 монет, каждая стратегия тестит BUY+SELL раздельно
 *
 * Стратегии:
 *   1. LEVELS v2 (текущая prod, для baseline)
 *   2. Daily Breakout (open + first 4h range, breakout + reversal SL)
 *   3. RSI 4h Mean Reversion (RSI<25 → LONG, RSI>75 → SHORT)
 *   4. EMA Pullback (D1 trend > EMA200 → LONG на pullback к H1 EMA20)
 *   5. Funding Rate Divergence (funding extreme → trade в направлении больного majority)
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_strategy_compare.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { ema, rsi } from '../services/indicators'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import { loadFundingHistory, fundingAt, FundingPoint } from './fundingLoader'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const MAX_CONCURRENT = 10
const FEES_RT = 0.0008
const SPLITS = [0.5, 0.3, 0.2]

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT',
  'ARBUSDT', 'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT',
  'WIFUSDT', 'SEIUSDT', 'STRKUSDT', 'BLURUSDT', 'CRVUSDT',
]

// Levels v2 has explicit per-symbol direction in production. For fair comparison
// we keep that (Levels = current prod), other strategies test BUY+SELL on ALL symbols.
const LEVELS_PROD_SIDES: Record<string, 'BUY' | 'SELL' | 'BOTH'> = {
  BTCUSDT: 'BOTH',
  XRPUSDT: 'SELL', SEIUSDT: 'SELL', WIFUSDT: 'SELL',
  SOLUSDT: 'SELL', ARBUSDT: 'SELL', AVAXUSDT: 'SELL',
  '1000PEPEUSDT': 'SELL', ETHUSDT: 'SELL',
  HYPEUSDT: 'BUY', ENAUSDT: 'BOTH',
  AAVEUSDT: 'SELL', STRKUSDT: 'SELL', BLURUSDT: 'SELL', CRVUSDT: 'SELL',
}
const LEVELS_PROD_TPMINATR: Record<string, number> = {
  BTCUSDT: 1.5, XRPUSDT: 1.0, WIFUSDT: 2.0, SOLUSDT: 1.0,
  AVAXUSDT: 1.0, HYPEUSDT: 0.5, ENAUSDT: 1.5, AAVEUSDT: 1.5, CRVUSDT: 0.5,
}

interface LoadedData {
  symbol: string
  m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[]; h4: OHLCV[]
  funding: FundingPoint[]
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregateH1ToH4(h1: OHLCV[]): OHLCV[] {
  if (h1.length === 0) return []
  let startIdx = 0
  for (let i = 0; i < h1.length; i++) {
    const h = new Date(h1[i].time).getUTCHours()
    if (h % 4 === 0) { startIdx = i; break }
  }
  const out: OHLCV[] = []
  for (let i = startIdx; i + 4 <= h1.length; i += 4) {
    const slice = h1.slice(i, i + 4)
    out.push({
      time: slice[0].time, open: slice[0].open,
      high: Math.max(...slice.map(c => c.high)),
      low: Math.min(...slice.map(c => c.low)),
      close: slice[3].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5 = await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1 = await loadHistorical(symbol, '1h', MONTHS_BACK, 'bybit', 'linear')
    const d1 = await loadHistorical(symbol, '1d', MONTHS_BACK, 'bybit', 'linear')
    const h4 = aggregateH1ToH4(h1)
    let funding: FundingPoint[] = []
    try { funding = await loadFundingHistory(symbol, DAYS_BACK + BUFFER_DAYS) }
    catch (e: any) { console.warn(`  ${symbol}: funding load failed: ${e.message}`) }
    return { symbol, m5, m15, h1, d1, h4, funding }
  } catch { return null }
}

// =====================================================================
// Сигнал — общий формат для всех стратегий
// =====================================================================

interface Sig {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
  source: string  // strategy name + setup info
}

// =====================================================================
// ATR helper для SL/TP (используется во всех strategy generators)
// =====================================================================

function atr14(candles: OHLCV[], idx: number): number {
  if (idx < 14) return 0
  let sum = 0
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i], p = candles[i - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    sum += tr
  }
  return sum / 14
}

// =====================================================================
// СТРАТЕГИЯ 1: LEVELS v2 (baseline — текущая prod)
// =====================================================================

function generateSignalsLevels(data: LoadedData): Sig[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const setupSide = LEVELS_PROD_SIDES[data.symbol]
  if (!setupSide) return []
  const tpMinAtr = LEVELS_PROD_TPMINATR[data.symbol] ?? 0
  const cfg: LevelsV2Config = {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter', fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr, minRR: 0, maxRR: 8, excludeKillzones: ['NY_PM'],
  }
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (setupSide !== 'BOTH' && s.side !== setupSide) continue
    sigs.push({
      symbol: data.symbol, side: s.side, entryTime: s.entryTime,
      entryPrice: s.entryPrice, sl: s.slPrice, tpLadder: s.tpLadder,
      source: 'levels',
    })
  }
  return sigs
}

// =====================================================================
// СТРАТЕГИЯ 2: Daily Breakout
// Логика: первые 4 часа дня (00:00-04:00 UTC) формируют range. После закрытия
// 4-й свечи (04:00 UTC) ставим breakout-сигнал:
//   - Если цена > range_high → LONG
//   - Если цена < range_low → SHORT
//   - Срабатывает первый breakout в течение остатка дня (04:00-23:55 UTC)
//   - SL = противоположный край range
//   - TP ladder = [+1×range, +2×range, +3×range] от entry
// Volume filter: текущая 5m volume > 1.5× среднего по последним 24 свечам
// =====================================================================

function generateSignalsDailyBreakout(data: LoadedData): Sig[] {
  const m5 = sliceLastDays(data.m5, DAYS_BACK)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []

  // Group 5m candles by day (UTC)
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    const d = new Date(c.time).toISOString().slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }

  for (const [day, candles] of byDay) {
    if (candles.length === 0) continue
    if (candles[0].time < cutoff) continue
    // Range = first 4h = first 48 5m candles
    const rangeBars = candles.slice(0, 48)
    if (rangeBars.length < 48) continue
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue

    // Now scan rest of the day for breakout
    let triggered = false
    for (let i = 48; i < candles.length && !triggered; i++) {
      const c = candles[i]
      // Volume filter: avg of prev 24 bars
      const start = Math.max(0, i - 24)
      const avgVol = candles.slice(start, i).reduce((s, x) => s + x.volume, 0) / Math.max(1, i - start)
      if (c.volume < avgVol * 1.5) continue

      let side: 'BUY' | 'SELL' | null = null
      let entryPrice = 0
      if (c.high > rangeHigh && c.close > rangeHigh) { side = 'BUY'; entryPrice = rangeHigh }
      else if (c.low < rangeLow && c.close < rangeLow) { side = 'SELL'; entryPrice = rangeLow }
      if (!side) continue

      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * 1.0, entryPrice + rangeSize * 2.0, entryPrice + rangeSize * 3.0]
        : [entryPrice - rangeSize * 1.0, entryPrice - rangeSize * 2.0, entryPrice - rangeSize * 3.0]

      sigs.push({
        symbol: data.symbol, side, entryTime: c.time, entryPrice, sl, tpLadder,
        source: `dailyBreakout_${day}`,
      })
      triggered = true
    }
  }
  return sigs
}

// =====================================================================
// СТРАТЕГИЯ 3: RSI 4h Mean Reversion
// Логика: на закрытии 4h свечи проверяем RSI(14):
//   - RSI < 25 → LONG (oversold reversal)
//   - RSI > 75 → SHORT (overbought reversal)
//   - SL = 1.5× ATR(14) на 4h
//   - TP ladder = entry + 1×ATR, 2×ATR, 3×ATR
// Cooldown: после signal — следующий не раньше 24 часов на том же символе
// =====================================================================

function generateSignalsRsiMR(data: LoadedData): Sig[] {
  const h4 = sliceLastDays(data.h4, DAYS_BACK)
  if (h4.length < 50) return []
  const closes = h4.map(c => c.close)
  const rsiArr = rsi14Arr(closes)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []
  let lastSigTime = 0
  const COOLDOWN_MS = 24 * 60 * 60_000

  for (let i = 14; i < h4.length; i++) {
    const c = h4[i]
    if (c.time < cutoff) continue
    if (c.time - lastSigTime < COOLDOWN_MS) continue
    const r = rsiArr[i]
    if (r == null) continue

    let side: 'BUY' | 'SELL' | null = null
    if (r < 25) side = 'BUY'
    else if (r > 75) side = 'SELL'
    if (!side) continue

    const a = atr14(h4, i)
    if (a <= 0) continue
    const entryPrice = c.close
    const sl = side === 'BUY' ? entryPrice - a * 1.5 : entryPrice + a * 1.5
    const tpLadder = side === 'BUY'
      ? [entryPrice + a * 1.0, entryPrice + a * 2.0, entryPrice + a * 3.0]
      : [entryPrice - a * 1.0, entryPrice - a * 2.0, entryPrice - a * 3.0]

    sigs.push({ symbol: data.symbol, side, entryTime: c.time, entryPrice, sl, tpLadder, source: `rsiMR_${r.toFixed(0)}` })
    lastSigTime = c.time
  }
  return sigs
}

function rsi14Arr(closes: number[]): (number | null)[] {
  // Wilder RSI
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < 15) return out
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= 14; avgLoss /= 14
  out[14] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * 13 + gain) / 14
    avgLoss = (avgLoss * 13 + loss) / 14
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
  }
  return out
}

// =====================================================================
// СТРАТЕГИЯ 4: EMA Pullback
// Логика:
//   D1 trend filter: цена > EMA200 D1 = bullish (только LONG), < = bearish (только SHORT)
//   На H1 закрытии: если цена касается EMA20 H1 (low ≤ EMA20 ≤ high) → entry в направлении тренда
//   - LONG entry: close, SL = swing low за последние 10 H1, TP = entry + 2×(entry - SL)
//   - SHORT mirror
// Cooldown: 8h после signal
// =====================================================================

function generateSignalsEmaPullback(data: LoadedData): Sig[] {
  const h1 = sliceLastDays(data.h1, DAYS_BACK)
  const d1 = sliceLastDays(data.d1, DAYS_BACK)
  if (h1.length < 200 || d1.length < 200) return []

  const d1EMA200 = ema(d1.map(c => c.close), 200)
  const h1EMA20 = ema(h1.map(c => c.close), 20)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []
  let lastSigTime = 0
  const COOLDOWN_MS = 8 * 60 * 60_000

  function trendAt(unixMs: number): 'bullish' | 'bearish' | null {
    let lo = 0, hi = d1.length - 1, idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (d1[mid].time <= unixMs) { idx = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    if (idx < 0 || idx < 200) return null
    const e = d1EMA200[idx]
    const c = d1[idx].close
    return c > e * 1.005 ? 'bullish' : c < e * 0.995 ? 'bearish' : null  // ±0.5% deadzone
  }

  for (let i = 50; i < h1.length; i++) {
    const c = h1[i]
    if (c.time < cutoff) continue
    if (c.time - lastSigTime < COOLDOWN_MS) continue
    const trend = trendAt(c.time)
    if (!trend) continue

    const e20 = h1EMA20[i]
    // Touch: low <= ema20 <= high
    if (e20 < c.low || e20 > c.high) continue

    let side: 'BUY' | 'SELL' | null = null
    if (trend === 'bullish' && c.close > e20) side = 'BUY'
    else if (trend === 'bearish' && c.close < e20) side = 'SELL'
    if (!side) continue

    // Swing low/high last 10 H1 bars
    const start = Math.max(0, i - 10)
    let swingLow = h1[start].low, swingHigh = h1[start].high
    for (let j = start + 1; j <= i; j++) {
      if (h1[j].low < swingLow) swingLow = h1[j].low
      if (h1[j].high > swingHigh) swingHigh = h1[j].high
    }
    const entryPrice = c.close
    const sl = side === 'BUY' ? swingLow : swingHigh
    const risk = Math.abs(entryPrice - sl)
    if (risk <= 0) continue
    const tpLadder = side === 'BUY'
      ? [entryPrice + risk * 1.5, entryPrice + risk * 2.5, entryPrice + risk * 4.0]
      : [entryPrice - risk * 1.5, entryPrice - risk * 2.5, entryPrice - risk * 4.0]

    sigs.push({ symbol: data.symbol, side, entryTime: c.time, entryPrice, sl, tpLadder, source: `emaPullback_${trend}` })
    lastSigTime = c.time
  }
  return sigs
}

// =====================================================================
// СТРАТЕГИЯ 5: Funding Rate Divergence
// Логика: на каждом 8h funding event:
//   - Если funding > +0.1% (longs heavily paying) → SHORT (контр-консенсус)
//   - Если funding < -0.05% (shorts paying — bearish exhausted) → LONG
//   - Entry @ close первой H1 свечи после funding event
//   - SL = 2% от entry (фиксированный на чрезмерно бычьих/медвежьих)
//   - TP ladder = entry ± 1.5%, 3%, 5%
// =====================================================================

function generateSignalsFundingDiv(data: LoadedData): Sig[] {
  if (data.funding.length === 0) return []
  const h1 = sliceLastDays(data.h1, DAYS_BACK)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []

  for (const fp of data.funding) {
    if (fp.time < cutoff) continue
    let side: 'BUY' | 'SELL' | null = null
    if (fp.rate > 0.001) side = 'SELL'      // longs heavily paying → fade longs
    else if (fp.rate < -0.0005) side = 'BUY' // shorts paying (rare — usually +) → bullish reversal
    if (!side) continue

    // Find first H1 candle after funding event
    const candle = h1.find(c => c.time >= fp.time)
    if (!candle) continue

    const entryPrice = candle.close
    const sl = side === 'BUY' ? entryPrice * 0.98 : entryPrice * 1.02
    const tpLadder = side === 'BUY'
      ? [entryPrice * 1.015, entryPrice * 1.03, entryPrice * 1.05]
      : [entryPrice * 0.985, entryPrice * 0.97, entryPrice * 0.95]

    sigs.push({
      symbol: data.symbol, side, entryTime: candle.time, entryPrice, sl, tpLadder,
      source: `fundingDiv_${(fp.rate * 100).toFixed(3)}%`,
    })
  }
  return sigs
}

// =====================================================================
// Portfolio simulator (как в runBacktest_max_concurrent)
// =====================================================================

interface OpenPos {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  fillPrice: number
  initialSL: number
  trailingSL: number
  riskUsd: number
  positionSizeUsd: number
  riskPerUnit: number
  nextTpIdx: number
  remainingFrac: number
  splits: number[]
  tps: number[]
  fills: Array<{ tpIdx: number; price: number; frac: number; rContrib: number; pnlUsd: number }>
  reachedTp1: boolean
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
  source: string
}

interface ClosedTrade {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  exitTime: number
  pnlR: number
  pnlUsd: number
  exitReason: 'SL' | 'LADDER_DONE' | 'EOD'
  source: string
}

interface SimResult {
  strategyName: string
  startingDeposit: number
  finalDeposit: number
  trades: ClosedTrade[]
  signalsAttempted: number
  signalsOpened: number
  signalsSkippedConcurrent: number
  signalsBlockedSamePos: number
  peakEquity: number
  maxEquityDD: number
}

function alignSplits(ladderLen: number): number[] {
  if (ladderLen <= 0) return []
  const out = SPLITS.slice(0, ladderLen)
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[out.length - 1] = Math.max(0, 1 - used)
  return out
}

function simulatePortfolio(
  strategyName: string,
  candleData: Map<string, OHLCV[]>,
  signals: Sig[],
  range?: { from: number; to: number },
): SimResult {
  // Filter signals to range
  const filteredSigs = range
    ? signals.filter(s => s.entryTime >= range.from && s.entryTime <= range.to)
    : signals.slice()

  // Build candle lookup
  const candleLookup = new Map<string, Map<number, OHLCV>>()
  for (const [sym, candles] of candleData) {
    const m = new Map<number, OHLCV>()
    for (const c of candles) {
      if (range && (c.time < range.from || c.time > range.to)) continue
      m.set(c.time, c)
    }
    candleLookup.set(sym, m)
  }

  // Build sorted timeline (union of all symbol timestamps)
  const allTimes = new Set<number>()
  for (const m of candleLookup.values()) for (const t of m.keys()) allTimes.add(t)
  const sortedTimes = [...allTimes].sort((a, b) => a - b)

  // Sigs by time
  const sigByTime = new Map<number, Sig[]>()
  for (const s of filteredSigs) {
    if (!sigByTime.has(s.entryTime)) sigByTime.set(s.entryTime, [])
    sigByTime.get(s.entryTime)!.push(s)
  }

  let deposit = STARTING_DEPOSIT
  let peakEquity = STARTING_DEPOSIT
  let maxEquityDD = 0
  const openPositions: OpenPos[] = []
  const trades: ClosedTrade[] = []
  let signalsAttempted = 0, signalsOpened = 0, signalsSkippedConcurrent = 0, signalsBlockedSamePos = 0

  function finalizeTrade(pos: OpenPos, exitTime: number, reason: ClosedTrade['exitReason']): void {
    const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
    const grossUsd = pos.fills.reduce((s, f) => s + f.pnlUsd, 0)
    const feeR = (pos.fillPrice * FEES_RT) / pos.riskPerUnit
    const feeUsd = pos.positionSizeUsd * FEES_RT
    deposit += grossUsd - feeUsd
    trades.push({
      symbol: pos.symbol, side: pos.side, entryTime: pos.entryTime, exitTime,
      pnlR: Math.round((grossR - feeR) * 10000) / 10000,
      pnlUsd: Math.round((grossUsd - feeUsd) * 100) / 100,
      exitReason: reason, source: pos.source,
    })
    const idx = openPositions.indexOf(pos)
    if (idx >= 0) openPositions.splice(idx, 1)
  }

  function processBar(pos: OpenPos, c: OHLCV): void {
    const isLong = pos.side === 'BUY'
    const slHit = isLong ? c.low <= pos.trailingSL : c.high >= pos.trailingSL
    if (slHit) {
      const exitFill = pos.trailingSL
      const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.riskPerUnit
      const pnlUsd = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
      pos.fills.push({ tpIdx: -1, price: exitFill, frac: pos.remainingFrac, rContrib, pnlUsd })
      pos.remainingFrac = 0
      finalizeTrade(pos, c.time, 'SL')
      return
    }
    while (pos.nextTpIdx < pos.splits.length && pos.remainingFrac > 1e-9) {
      const tpIdx = pos.nextTpIdx
      const tp = pos.tps[tpIdx]
      const wickReached = isLong ? c.high >= tp : c.low <= tp
      if (!wickReached) break
      const isLastTp = tpIdx === pos.splits.length - 1
      const closeBeyond = isLong ? c.close > tp : c.close < tp
      const fill = !closeBeyond || isLastTp
      if (!fill) { pos.nextTpIdx++; continue }
      const frac = pos.splits[tpIdx] ?? 0
      if (frac > 0) {
        const rContrib = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * frac) / pos.riskPerUnit
        const pnlUsd = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * pos.positionSizeUsd / pos.fillPrice) * frac
        pos.fills.push({ tpIdx, price: tp, frac, rContrib, pnlUsd })
        pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)
        if (tpIdx === 0) { pos.reachedTp1 = true; pos.trailingSL = pos.fillPrice; pos.status = 'TP1_HIT' }
        else if (tpIdx === 1) { pos.trailingSL = pos.tps[0]; pos.status = 'TP2_HIT' }
        else pos.trailingSL = pos.tps[tpIdx - 1]
      }
      pos.nextTpIdx++
      if (pos.remainingFrac <= 1e-9) { finalizeTrade(pos, c.time, 'LADDER_DONE'); return }
    }
  }

  for (const t of sortedTimes) {
    for (const pos of [...openPositions]) {
      const c = candleLookup.get(pos.symbol)?.get(t)
      if (c) processBar(pos, c)
    }

    // Equity DD
    let unrealized = 0
    for (const pos of openPositions) {
      const c = candleLookup.get(pos.symbol)?.get(t)
      if (!c) continue
      const isLong = pos.side === 'BUY'
      unrealized += ((isLong ? c.close - pos.fillPrice : pos.fillPrice - c.close) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
    }
    const eq = deposit + unrealized
    if (eq > peakEquity) peakEquity = eq
    const eqDD = ((peakEquity - eq) / peakEquity) * 100
    if (eqDD > maxEquityDD) maxEquityDD = eqDD

    const sigs = sigByTime.get(t)
    if (!sigs) continue
    for (const sig of sigs) {
      signalsAttempted++
      const samePos = openPositions.find(p => p.symbol === sig.symbol && p.side === sig.side)
      if (samePos) { signalsBlockedSamePos++; continue }
      if (openPositions.length >= MAX_CONCURRENT) { signalsSkippedConcurrent++; continue }

      const isLong = sig.side === 'BUY'
      const entryFill = sig.entryPrice
      const riskPerUnit = Math.abs(entryFill - sig.sl)
      if (riskPerUnit <= 0) continue
      if (isLong && sig.sl >= entryFill) continue
      if (!isLong && sig.sl <= entryFill) continue
      if (!sig.tpLadder.every(p => isLong ? p > entryFill : p < entryFill)) continue

      const riskUsd = deposit * (RISK_PCT / 100)
      const positionUnits = riskUsd / riskPerUnit
      const positionSizeUsd = entryFill * positionUnits

      openPositions.push({
        symbol: sig.symbol, side: sig.side, entryTime: t,
        fillPrice: entryFill, initialSL: sig.sl, trailingSL: sig.sl,
        riskUsd, positionSizeUsd, riskPerUnit,
        nextTpIdx: 0, remainingFrac: 1,
        splits: alignSplits(sig.tpLadder.length), tps: sig.tpLadder,
        fills: [], reachedTp1: false, status: 'OPEN', source: sig.source,
      })
      signalsOpened++
    }
  }

  // Close remaining EOD
  for (const pos of [...openPositions]) {
    const lastTime = sortedTimes[sortedTimes.length - 1]
    const c = candleLookup.get(pos.symbol)?.get(lastTime)
    if (!c) {
      const idx = openPositions.indexOf(pos)
      if (idx >= 0) openPositions.splice(idx, 1)
      continue
    }
    const isLong = pos.side === 'BUY'
    const exitPrice = c.close
    const rContrib = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.remainingFrac) / pos.riskPerUnit
    const pnlUsd = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
    pos.fills.push({ tpIdx: -1, price: exitPrice, frac: pos.remainingFrac, rContrib, pnlUsd })
    pos.remainingFrac = 0
    finalizeTrade(pos, c.time, 'EOD')
  }

  return {
    strategyName, startingDeposit: STARTING_DEPOSIT, finalDeposit: deposit,
    trades, signalsAttempted, signalsOpened, signalsSkippedConcurrent,
    signalsBlockedSamePos, peakEquity, maxEquityDD,
  }
}

// =====================================================================
// Main
// =====================================================================

interface StrategyDef {
  name: string
  generator: (data: LoadedData) => Sig[]
}

const STRATEGIES: StrategyDef[] = [
  { name: 'Levels v2',       generator: generateSignalsLevels },
  { name: 'Daily Breakout',  generator: generateSignalsDailyBreakout },
  { name: 'RSI 4h MR',       generator: generateSignalsRsiMR },
  { name: 'EMA Pullback',    generator: generateSignalsEmaPullback },
  { name: 'Funding Diverg.', generator: generateSignalsFundingDiv },
]

function fmtSimRow(r: SimResult, periodLabel: string): string {
  const n = r.trades.length
  const ret = ((r.finalDeposit - r.startingDeposit) / r.startingDeposit) * 100
  const wins = r.trades.filter(t => t.pnlUsd > 0).length
  const wr = n > 0 ? (wins / n) * 100 : 0
  const totalR = r.trades.reduce((s, t) => s + t.pnlR, 0)
  const rPerTr = n > 0 ? totalR / n : 0
  return `${periodLabel.padEnd(7)} | $${r.finalDeposit.toFixed(0).padStart(5)} (${(ret >= 0 ? '+' : '') + ret.toFixed(0).padStart(4)}%) | DD${r.maxEquityDD.toFixed(0).padStart(2)}% | N=${n.toString().padStart(4)} R/tr=${(rPerTr >= 0 ? '+' : '') + rPerTr.toFixed(2)} WR=${wr.toFixed(0)}% | sigs=${r.signalsAttempted}`
}

async function main() {
  console.log(`Strategy comparison — Депо $${STARTING_DEPOSIT}, риск ${RISK_PCT}%, max ${MAX_CONCURRENT} concurrent`)
  console.log(`15 монет, walk-forward TRAIN(60%)/TEST(40%), 365d`)
  console.log()

  console.log('Loading data...')
  const dataMap = new Map<string, LoadedData>()
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym.padEnd(15)} `)
    const data = await loadAll(sym)
    if (!data) { console.log('FAIL'); continue }
    console.log(`OK (m5=${data.m5.length}, h4=${data.h4.length}, h1=${data.h1.length}, d1=${data.d1.length}, funding=${data.funding.length})`)
    dataMap.set(sym, data)
  }
  console.log()

  // Build candle lookup for portfolio sim (m5 для всех — базовый таймфрейм для exit detection)
  const candleData = new Map<string, OHLCV[]>()
  for (const [sym, data] of dataMap) {
    candleData.set(sym, sliceLastDays(data.m5, DAYS_BACK))
  }

  const now = Date.now()
  const fullStart = now - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = now - Math.round(DAYS_BACK * 0.4) * 24 * 60 * 60_000

  // Generate signals once per strategy
  const sigCache = new Map<string, Sig[]>()
  for (const strat of STRATEGIES) {
    console.log(`Generating signals: ${strat.name}...`)
    const allSigs: Sig[] = []
    for (const [, data] of dataMap) {
      const sigs = strat.generator(data)
      allSigs.push(...sigs)
    }
    console.log(`  → ${allSigs.length} signals`)
    sigCache.set(strat.name, allSigs)
  }
  console.log()

  // Run portfolio sim per strategy × 3 periods
  type Row = { strat: string; full: SimResult; train: SimResult; test: SimResult }
  const rows: Row[] = []

  for (const strat of STRATEGIES) {
    const sigs = sigCache.get(strat.name)!
    console.log(`\n=== ${strat.name} ===`)
    const full = simulatePortfolio(strat.name, candleData, sigs, { from: fullStart, to: now })
    console.log(fmtSimRow(full, 'FULL'))
    const train = simulatePortfolio(strat.name, candleData, sigs, { from: fullStart, to: trainEnd })
    console.log(fmtSimRow(train, 'TRAIN'))
    const test = simulatePortfolio(strat.name, candleData, sigs, { from: trainEnd, to: now })
    console.log(fmtSimRow(test, 'TEST'))
    rows.push({ strat: strat.name, full, train, test })
  }

  console.log('\n\n========== SUMMARY ==========')
  console.log('Strategy            | FULL              | TRAIN             | TEST              | TEST stable?')
  console.log('-'.repeat(115))
  for (const r of rows) {
    function cell(s: SimResult): string {
      const ret = ((s.finalDeposit - s.startingDeposit) / s.startingDeposit) * 100
      return `$${s.finalDeposit.toFixed(0).padStart(5)} (${(ret >= 0 ? '+' : '') + ret.toFixed(0)}%) DD${s.maxEquityDD.toFixed(0)}%`
    }
    const trainRet = ((r.train.finalDeposit - r.train.startingDeposit) / r.train.startingDeposit) * 100
    const testRet = ((r.test.finalDeposit - r.test.startingDeposit) / r.test.startingDeposit) * 100
    const stable = trainRet > 0 && testRet > 0 ? '✅' : trainRet > 0 && testRet > -10 ? '⚠️' : '❌'
    console.log(`${r.strat.padEnd(20)}| ${cell(r.full).padEnd(18)} | ${cell(r.train).padEnd(18)} | ${cell(r.test).padEnd(18)} | ${stable}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
