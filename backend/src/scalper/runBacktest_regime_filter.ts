/**
 * Regime filter backtest (Идея 2):
 *
 * Гипотеза: фильтровать сигналы по тренду (цена vs EMA200). В bullish — только LONG,
 * в bearish — только SHORT, в узком канале (sideways) — ничего.
 *
 * Сравниваем 4 варианта:
 *   1. Baseline (без regime filter)
 *   2. BTC EMA200 D1 — глобальный режим: BTC > EMA200 D1 → bullish, < → bearish
 *   3. BTC EMA200 4h — глобальный режим, более быстрый
 *   4. Local EMA200 D1 — режим на самой монете
 *   5. Local EMA200 4h — режим на самой монете, более быстрый
 *
 * Канал sideways: ±0.5% и ±1% вокруг EMA200 — внутри = ничего не торгуем.
 *
 * Walk-forward: TRAIN (60% = 219d) + TEST (40% = 146d) раздельно.
 * Если edge только в TRAIN → overfitting, не внедряем.
 *
 * Также применяется уже внедрённый cross-side block для BOTH-сетапов (как в prod после 2026-05-07).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_regime_filter.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import { ema } from '../services/indicators'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6 // 60% TRAIN, 40% TEST

interface RunCase {
  symbol: string
  side: 'BUY' | 'SELL' | 'BOTH'
  tpMinAtr?: number
}

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT',  side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'ENAUSDT',  side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'AAVEUSDT', side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT',  side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'AVAXUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ETHUSDT',  side: 'SELL' },
  { symbol: 'SEIUSDT',  side: 'SELL' },
  { symbol: 'WIFUSDT',  side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'HYPEUSDT', side: 'BUY',  tpMinAtr: 0.5 },
]

// Channel widths to test (% around EMA200 = sideways → all blocked)
const CHANNEL_PCT_OPTIONS = [0.5, 1.0]

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
    minRR: 0, maxRR: 8,
    excludeKillzones: ['NY_PM'],
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[]; h4: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5 = await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1 = await loadHistorical(symbol, '1h', MONTHS_BACK, 'bybit', 'linear')
    const d1 = await loadHistorical(symbol, '1d', MONTHS_BACK, 'bybit', 'linear')
    // 4h синтезируем из 1h (4 свечи в 1)
    const h4 = aggregateH1ToH4(h1)
    return { m5, m15, h1, d1, h4 }
  } catch { return null }
}

function aggregateH1ToH4(h1: OHLCV[]): OHLCV[] {
  if (h1.length === 0) return []
  const out: OHLCV[] = []
  // Найдём первую свечу с границей 4h (UTC hour kratно 4)
  let startIdx = 0
  for (let i = 0; i < h1.length; i++) {
    const h = new Date(h1[i].time).getUTCHours()
    if (h % 4 === 0) { startIdx = i; break }
  }
  for (let i = startIdx; i + 4 <= h1.length; i += 4) {
    const slice = h1.slice(i, i + 4)
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[3].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}

// =====================================================================
// EMA200 lookup: для каждой 5m свечи возвращает (ema200, regime) на основе
// последней закрытой свечи указанного таймфрейма.
// Regime: 'bullish' (price > EMA200 + channel), 'bearish' (price < EMA200 - channel),
//         'sideways' (внутри канала)
// =====================================================================

type Regime = 'bullish' | 'bearish' | 'sideways'

function buildRegimeLookup(htfCandles: OHLCV[], channelPct: number): { time: number; ema: number; close: number; regime: Regime }[] {
  const closes = htfCandles.map((c) => c.close)
  const emaArr = ema(closes, 200)
  const out: { time: number; ema: number; close: number; regime: Regime }[] = []
  for (let i = 0; i < htfCandles.length; i++) {
    if (i < 200) {
      out.push({ time: htfCandles[i].time, ema: emaArr[i], close: closes[i], regime: 'sideways' })
      continue
    }
    const e = emaArr[i]
    const c = closes[i]
    const upperBand = e * (1 + channelPct / 100)
    const lowerBand = e * (1 - channelPct / 100)
    let regime: Regime = 'sideways'
    if (c > upperBand) regime = 'bullish'
    else if (c < lowerBand) regime = 'bearish'
    out.push({ time: htfCandles[i].time, ema: e, close: c, regime })
  }
  return out
}

/** Найти regime на момент unix-time (используя ПОСЛЕДНЮЮ ЗАКРЫТУЮ свечу) */
function regimeAt(lookup: { time: number; regime: Regime }[], unixMs: number): Regime {
  // Ищем последнюю свечу с time <= unixMs
  let lo = 0, hi = lookup.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lookup[mid].time <= unixMs) { idx = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  if (idx < 0) return 'sideways'
  return lookup[idx].regime
}

// =====================================================================
// Симулятор (упрощённая копия с Идея 1 cross-side block)
// =====================================================================

interface Sig {
  idx: number
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
}

interface SimTrade {
  side: 'BUY' | 'SELL'
  entryTime: number
  exitTime: number
  pnlR: number
  reachedTp1: boolean
}

const SPLITS = [0.5, 0.3, 0.2]
const FEES_RT = 0.0008

interface OpenPos {
  sig: Sig
  fillPrice: number
  initialSL: number
  trailingSL: number
  risk: number
  openIdx: number
  nextTpIdx: number
  remainingFrac: number
  splits: number[]
  fills: Array<{ tpIdx: number; price: number; frac: number; rContrib: number }>
  reachedTp1: boolean
}

function alignSplits(ladderLen: number): number[] {
  if (ladderLen <= 0) return []
  if (ladderLen >= SPLITS.length) {
    const out = [...SPLITS, ...new Array(ladderLen - SPLITS.length).fill(0)]
    const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
    out[out.length - 1] = Math.max(0, 1 - used)
    return out
  }
  const out = SPLITS.slice(0, ladderLen)
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[out.length - 1] = Math.max(0, 1 - used)
  return out
}

function closePos(pos: OpenPos, exitTime: number): SimTrade {
  const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
  const feeR = (pos.fillPrice * FEES_RT) / pos.risk
  return {
    side: pos.sig.side,
    entryTime: pos.sig.entryTime,
    exitTime,
    pnlR: Math.round((grossR - feeR) * 10000) / 10000,
    reachedTp1: pos.reachedTp1,
  }
}

function processBar(pos: OpenPos, c: OHLCV): SimTrade | null {
  const isLong = pos.sig.side === 'BUY'
  // SL
  const slHit = isLong ? c.low <= pos.trailingSL : c.high >= pos.trailingSL
  if (slHit) {
    const exitFill = pos.trailingSL
    const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.risk
    pos.fills.push({ tpIdx: -1, price: exitFill, frac: pos.remainingFrac, rContrib })
    pos.remainingFrac = 0
    return closePos(pos, c.time)
  }
  // TPs
  let progressed = true
  while (progressed && pos.nextTpIdx < pos.sig.tpLadder.length && pos.remainingFrac > 1e-9) {
    progressed = false
    const tpIdx = pos.nextTpIdx
    const tp = pos.sig.tpLadder[tpIdx]
    const wickReached = isLong ? c.high >= tp : c.low <= tp
    if (!wickReached) break
    const isLastTp = tpIdx === pos.sig.tpLadder.length - 1
    const closeBeyond = isLong ? c.close > tp : c.close < tp
    const fill = !closeBeyond || isLastTp
    if (fill) {
      const frac = pos.splits[tpIdx] ?? 0
      if (frac > 0) {
        const rContrib = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * frac) / pos.risk
        pos.fills.push({ tpIdx, price: tp, frac, rContrib })
        pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)
        if (tpIdx === 0) {
          pos.reachedTp1 = true
          pos.trailingSL = pos.fillPrice
        } else {
          pos.trailingSL = pos.sig.tpLadder[tpIdx - 1]
        }
      }
      pos.nextTpIdx++
      progressed = true
      if (pos.remainingFrac <= 1e-9) return closePos(pos, c.time)
    } else {
      pos.nextTpIdx++
      progressed = true
    }
  }
  return null
}

interface Filters {
  /** cross-side block для BOTH (всегда применяется как в prod) */
  applyCrossSide: boolean
  /** regime lookup — undefined значит без regime filter */
  regimeLookup?: { time: number; regime: Regime }[]
}

/**
 * Симулирует все сигналы с применением фильтров.
 * Возвращает все взятые трейды + кол-во заблокированных (cross-side / regime).
 */
function simulate(candles: OHLCV[], sigs: Sig[], setupSide: 'BUY' | 'SELL' | 'BOTH', filters: Filters): {
  trades: SimTrade[]
  blockedCrossSide: number
  blockedRegime: number
} {
  const trades: SimTrade[] = []
  let posBuy: OpenPos | null = null
  let posSell: OpenPos | null = null
  let blockedCrossSide = 0
  let blockedRegime = 0
  const sigByIdx = new Map<number, Sig[]>()
  for (const s of sigs) {
    if (!sigByIdx.has(s.idx)) sigByIdx.set(s.idx, [])
    sigByIdx.get(s.idx)!.push(s)
  }

  for (let i = 1; i < candles.length; i++) {
    if (posBuy) {
      const closed = processBar(posBuy, candles[i])
      if (closed) { trades.push(closed); posBuy = null }
    }
    if (posSell) {
      const closed = processBar(posSell, candles[i])
      if (closed) { trades.push(closed); posSell = null }
    }
    const newSigs = sigByIdx.get(i)
    if (!newSigs) continue
    for (const sig of newSigs) {
      const isLong = sig.side === 'BUY'
      const samePos = isLong ? posBuy : posSell
      const oppPos = isLong ? posSell : posBuy
      if (samePos) continue
      // Cross-side block (для BOTH) — как в prod после 2026-05-07
      if (filters.applyCrossSide && setupSide === 'BOTH' && oppPos && !oppPos.reachedTp1) {
        blockedCrossSide++
        continue
      }
      // Regime filter
      if (filters.regimeLookup) {
        const regime = regimeAt(filters.regimeLookup, sig.entryTime)
        // sideways → всё блокируется
        if (regime === 'sideways') { blockedRegime++; continue }
        // bullish → только BUY, bearish → только SELL
        if (regime === 'bullish' && sig.side === 'SELL') { blockedRegime++; continue }
        if (regime === 'bearish' && sig.side === 'BUY') { blockedRegime++; continue }
      }
      const entryFill = sig.entryPrice
      const risk = Math.abs(entryFill - sig.sl)
      if (risk <= 0) continue
      if (isLong && sig.sl >= entryFill) continue
      if (!isLong && sig.sl <= entryFill) continue
      const validLadder = sig.tpLadder.every((p) => isLong ? p > entryFill : p < entryFill)
      if (!validLadder) continue
      const newPos: OpenPos = {
        sig, fillPrice: entryFill, initialSL: sig.sl, trailingSL: sig.sl, risk,
        openIdx: i, nextTpIdx: 0, remainingFrac: 1,
        splits: alignSplits(sig.tpLadder.length), fills: [], reachedTp1: false,
      }
      if (isLong) posBuy = newPos
      else posSell = newPos
    }
  }
  // Closing
  for (const pos of [posBuy, posSell]) {
    if (!pos) continue
    const last = candles[candles.length - 1]
    const isLong = pos.sig.side === 'BUY'
    const exitFill = last.close
    const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.risk
    pos.fills.push({ tpIdx: -1, price: exitFill, frac: pos.remainingFrac, rContrib })
    trades.push(closePos(pos, last.time))
  }
  return { trades, blockedCrossSide, blockedRegime }
}

function generateSigsForCase(data: LoadedData, c: RunCase): Sig[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const sigs: Sig[] = []
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigs.push({
      idx: i, side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder,
    })
  }
  return sigs
}

interface Stat { n: number; totalR: number; rPerTr: number; wr: number }
function summarize(trades: SimTrade[]): Stat {
  if (trades.length === 0) return { n: 0, totalR: 0, rPerTr: 0, wr: 0 }
  let totalR = 0, wins = 0
  for (const t of trades) { totalR += t.pnlR; if (t.pnlR > 0) wins++ }
  return { n: trades.length, totalR, rPerTr: totalR / trades.length, wr: (wins / trades.length) * 100 }
}

function splitTrainTest(trades: SimTrade[], cutoffTime: number): { train: SimTrade[]; test: SimTrade[] } {
  const train: SimTrade[] = [], test: SimTrade[] = []
  for (const t of trades) {
    if (t.entryTime < cutoffTime) train.push(t)
    else test.push(t)
  }
  return { train, test }
}

function fmtStat(s: Stat): string {
  if (s.n === 0) return '       no trades       '
  return `N=${s.n.toString().padStart(3)} R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)} totR=${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(0)}`
}

interface VariantResult {
  label: string
  full: Stat
  train: Stat
  test: Stat
  blockedRegime: number
}

async function main() {
  console.log('Regime filter backtest — Идея 2')
  console.log(`Период: 365d, walk-forward: TRAIN ${(TRAIN_PCT * 100).toFixed(0)}% (${Math.round(DAYS_BACK * TRAIN_PCT)}d), TEST ${((1 - TRAIN_PCT) * 100).toFixed(0)}% (${Math.round(DAYS_BACK * (1 - TRAIN_PCT))}d)`)
  console.log(`Variants: Baseline | BTC-EMA200-D1 | BTC-EMA200-4h | Local-EMA200-D1 | Local-EMA200-4h`)
  console.log(`Канал sideways: ±0.5% и ±1% (тестируем оба)`)
  console.log(`Cross-side block для BOTH применяется во всех вариантах (как в prod)`)
  console.log()

  // Loading BTC отдельно для использования как глобальный proxy на всех символах
  console.log('Loading BTC for global regime lookup...')
  const btcData = await loadAll('BTCUSDT')
  if (!btcData) { console.log('BTC load failed, abort'); return }

  const btcD1Sliced = sliceLastDays(btcData.d1, DAYS_BACK + BUFFER_DAYS) // нужны 200+ свечей для EMA200
  const btcH4Sliced = sliceLastDays(btcData.h4, DAYS_BACK + BUFFER_DAYS)

  const trainCutoffTime = Date.now() - (DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000

  for (const channelPct of CHANNEL_PCT_OPTIONS) {
    console.log(`\n${'='.repeat(110)}`)
    console.log(`CHANNEL ±${channelPct}%`)
    console.log('='.repeat(110))

    const btcD1Lookup = buildRegimeLookup(btcD1Sliced, channelPct)
    const btcH4Lookup = buildRegimeLookup(btcH4Sliced, channelPct)

    // Portfolio aggregates per variant
    type VKey = 'baseline' | 'btcD1' | 'btcH4' | 'localD1' | 'localH4'
    const portfolio: Record<VKey, { trades: SimTrade[]; blocked: number }> = {
      baseline: { trades: [], blocked: 0 },
      btcD1:    { trades: [], blocked: 0 },
      btcH4:    { trades: [], blocked: 0 },
      localD1:  { trades: [], blocked: 0 },
      localH4:  { trades: [], blocked: 0 },
    }

    for (const c of CASES) {
      const data = c.symbol === 'BTCUSDT' ? btcData : await loadAll(c.symbol)
      if (!data) continue
      const sigs = generateSigsForCase(data, c)
      const ltf = sliceLastDays(data.m5, DAYS_BACK)
      const localD1 = sliceLastDays(data.d1, DAYS_BACK + BUFFER_DAYS)
      const localH4 = sliceLastDays(data.h4, DAYS_BACK + BUFFER_DAYS)
      const localD1Lookup = buildRegimeLookup(localD1, channelPct)
      const localH4Lookup = buildRegimeLookup(localH4, channelPct)

      const variants: { key: VKey; lookup?: typeof btcD1Lookup }[] = [
        { key: 'baseline', lookup: undefined },
        { key: 'btcD1',    lookup: btcD1Lookup },
        { key: 'btcH4',    lookup: btcH4Lookup },
        { key: 'localD1',  lookup: localD1Lookup },
        { key: 'localH4',  lookup: localH4Lookup },
      ]

      console.log(`\n${c.symbol} side=${c.side} (sigs=${sigs.length})`)
      console.log(`Variant            | FULL                       | TRAIN                      | TEST                       | blocked-regime`)
      console.log('-'.repeat(130))

      for (const v of variants) {
        const sim = simulate(ltf, sigs, c.side, { applyCrossSide: true, regimeLookup: v.lookup })
        const sFull = summarize(sim.trades)
        const split = splitTrainTest(sim.trades, trainCutoffTime)
        const sTrain = summarize(split.train)
        const sTest = summarize(split.test)
        portfolio[v.key].trades.push(...sim.trades)
        portfolio[v.key].blocked += sim.blockedRegime
        console.log(`${v.key.padEnd(18)} | ${fmtStat(sFull).padEnd(26)} | ${fmtStat(sTrain).padEnd(26)} | ${fmtStat(sTest).padEnd(26)} | ${sim.blockedRegime}`)
      }
    }

    console.log(`\n--- PORTFOLIO TOTALS (channel ±${channelPct}%) ---`)
    console.log(`Variant            | FULL                       | TRAIN                      | TEST                       | blocked-regime`)
    console.log('-'.repeat(130))
    for (const key of ['baseline', 'btcD1', 'btcH4', 'localD1', 'localH4'] as const) {
      const all = portfolio[key].trades
      const sFull = summarize(all)
      const split = splitTrainTest(all, trainCutoffTime)
      const sTrain = summarize(split.train)
      const sTest = summarize(split.test)
      console.log(`${key.padEnd(18)} | ${fmtStat(sFull).padEnd(26)} | ${fmtStat(sTrain).padEnd(26)} | ${fmtStat(sTest).padEnd(26)} | ${portfolio[key].blocked}`)
    }
  }

  console.log('\n\nЗаметки:')
  console.log('- Walk-forward: edge должен быть стабилен в TRAIN и TEST (или хотя бы не отрицательный в TEST)')
  console.log('- Если variant хорош в TRAIN но валится в TEST → overfitting, не внедряем')
  console.log('- BTC-D1: разворот режима раз в 2-3 месяца (медленный, но стабильный)')
  console.log('- BTC-4h: чаще меняется, может ловить rallies/dumps быстрее, но шумнее')
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
