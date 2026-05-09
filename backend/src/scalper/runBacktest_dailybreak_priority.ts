/**
 * Daily Breakout — portfolio simulator with margin downsize + priority sort (Variant B′).
 *
 * Compares 4 modes on identical FULL/TRAIN/TEST trade pools:
 *   A. baseline     — current prod: target margin 10%/trade, skip on insufficient free margin
 *   B. downsize     — when target doesn't fit, open at free margin (lev bumped, capped at maxLev,
 *                      free >= $10). FCFS sort. NEW: matches the auto-flow change in paper trader.
 *   C. priority     — current skip-on-insufficient logic, but signals competing for capacity are
 *                      sorted by Variant B′:
 *                        Group 1: symbols with < 3 terminal trades  → FCFS (gather sample)
 *                        Group 2: symbols with ≥ 3 terminal trades  → cumulative pnl desc
 *                      Within an event tick, when multiple opens compete, B′ chooses order.
 *   D. both         — downsize + priority B′ (the proposed prod state).
 *
 * Methodology notes:
 *   - Trade pool generated identically to runBacktest_dailybreak_margin (same RANGE_BARS,
 *     VOL_MULT, splits, fees, slippage). Reusing same generator => same sigs => differences
 *     come only from sim policy.
 *   - Priority sort effect is visible only when 2+ signals compete for capacity at the same
 *     event tick. In 5m-bucketed historical data this is rare but not impossible.
 *   - Trades are bucketed by ceil(entryTime / 5min) to detect simultaneous arrivals.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_priority.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade } from './ladderBacktester'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade, getMaxLeverage } from '../services/marginGuard'

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

const HISTORY_MIN_TRADES = 3       // priority group threshold
const MIN_FREE_FOR_DOWNSIZE = 10   // matches paper trader

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  // Original 11
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
  // Universe expansion 21
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
      // Match prod min SL distance guard (0.4%)
      const slDistPct = (Math.abs(entryPrice - sl) / entryPrice) * 100
      if (slDistPct < 0.4) continue
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * cfg.tp1Mult, entryPrice + rangeSize * cfg.tp2Mult, entryPrice + rangeSize * cfg.tp3Mult]
        : [entryPrice - rangeSize * cfg.tp1Mult, entryPrice - rangeSize * cfg.tp2Mult, entryPrice - rangeSize * cfg.tp3Mult]
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

function runOne(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): LadderTrade[] {
  const sigs = generateBreakoutSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick',
    splits: SPLITS,
    trailing: true,
    feesRoundTrip: FEES_RT,
    slippagePerSide: SLIPPAGE,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
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
}

function toPortfolioTrade(symbol: string, t: LadderTrade): PortfolioTrade {
  const fillCount = (t.fills ?? []).length
  const fills: PortfolioTrade['fills'] = (t.fills ?? []).map((f, i) => {
    const frac = fillCount > 1 ? (i + 1) / fillCount : 1
    const time = t.entryTime + (t.exitTime - t.entryTime) * frac
    let reason: string
    if (f.idx >= 0) reason = `TP${f.idx + 1}`
    else if (t.exitReason === 'EOD') reason = 'EXPIRED'
    else if (t.exitReason === 'MAX_HOLD') reason = 'EXPIRED'
    else reason = 'SL'
    return { time, pricePnlR: f.rContrib, percent: f.frac * 100, reason }
  })
  return {
    symbol, entryTime: t.entryTime, closeTime: t.exitTime, side: t.side,
    entryPrice: t.entryPrice, sl: t.initialSL, pnlR: t.pnlR, fills,
  }
}

type Mode = 'baseline' | 'downsize' | 'priority' | 'both'

interface SimResult {
  mode: Mode
  trades: number              // fully realised
  opened: number
  skipped: number
  downsized: number           // opened with reduced margin (only for downsize/both modes)
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  maxDD: number
  winRate: number
  // Diagnostic: how often did priority sort actually change FCFS?
  priorityActivations: number
}

function simulate(allTrades: PortfolioTrade[], mode: Mode, deposit: number): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)

  let currentDeposit = deposit
  let peak = deposit
  let maxDD = 0
  const useDownsize = mode === 'downsize' || mode === 'both'
  const usePriority = mode === 'priority' || mode === 'both'

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
  // Per-symbol terminal-trade history (live aggregate as sim progresses).
  // Used by priority sort: trades count + cumulative netR.
  const histBySymbol = new Map<string, { trades: number; pnlR: number }>()

  let nextId = 1
  let opened = 0, skipped = 0, downsized = 0, priorityActivations = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0

  function applyEvent() {
    if (currentDeposit > peak) peak = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
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
        // Update history for the symbol
        const h = histBySymbol.get(a.pt.symbol) ?? { trades: 0, pnlR: 0 }
        h.trades += 1
        h.pnlR += a.realizedR
        histBySymbol.set(a.pt.symbol, h)
        active.splice(ai, 1)
      }
    }
  }

  // Try to open one signal. Returns true if opened, false if skipped.
  // Encapsulates baseline + downsize logic. Used by both FCFS and priority paths.
  function tryOpen(pt: PortfolioTrade, time: number): boolean {
    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skipped++; return false }
    if (active.length >= MAX_CONCURRENT) { skipped++; return false }

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: TARGET_MARGIN_PCT,
      entry: pt.entryPrice, sl: pt.sl,
    })
    if (!sizing) { skipped++; return false }

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
      // Doesn't fit at target margin. Try guard's auto-close path is ignored here
      // (no auto-close in this comparison; it's a separate axis).
      const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing,
        sizing.positionSizeUsd, pt.symbol)
      if (guard.toClose.length > 0) {
        // Auto-close not enabled in this comparison. Treat as inability to free.
        if (!useDownsize) { skipped++; return false }
        // For downsize mode, fall through and try downsize on current free.
      }
      if (!useDownsize) {
        // baseline / priority-only: skip
        skipped++; return false
      }
      // downsize / both: try opening on free margin if it meets thresholds
      if (free < MIN_FREE_FOR_DOWNSIZE) { skipped++; return false }
      const reqLev = sizing.positionSizeUsd / free
      const maxLev = getMaxLeverage(pt.symbol)
      if (reqLev > maxLev) { skipped++; return false }
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
    return true
  }

  // Bucket by 5-min boundary so simultaneous (or near-simultaneous within 5m) signals
  // arrive as a group — that's where priority sort can change order.
  const FIVE_MIN = 5 * 60_000
  const buckets = new Map<number, PortfolioTrade[]>()
  for (const pt of sorted) {
    const b = Math.floor(pt.entryTime / FIVE_MIN) * FIVE_MIN
    const list = buckets.get(b) ?? []
    list.push(pt); buckets.set(b, list)
  }
  const bucketTimes = [...buckets.keys()].sort((a, b) => a - b)

  for (const bt of bucketTimes) {
    realizeFillsUntil(bt)
    const group = buckets.get(bt)!
    let toProcess: PortfolioTrade[]
    if (usePriority && group.length > 1) {
      // Apply Variant B′: group 1 = trades < 3 (FCFS by entryTime), group 2 = trades >= 3 (pnl desc)
      const fcfs = [...group].sort((a, b) => a.entryTime - b.entryTime)
      const reordered = [...group].sort((a, b) => {
        const ha = histBySymbol.get(a.symbol)
        const hb = histBySymbol.get(b.symbol)
        const aGr = !ha || ha.trades < HISTORY_MIN_TRADES ? 0 : 1
        const bGr = !hb || hb.trades < HISTORY_MIN_TRADES ? 0 : 1
        if (aGr !== bGr) return aGr - bGr
        if (aGr === 0) return a.entryTime - b.entryTime
        const d = (hb?.pnlR ?? 0) - (ha?.pnlR ?? 0)
        if (d !== 0) return d
        return a.entryTime - b.entryTime
      })
      // Detect priority impact: did any signal move from its FCFS slot?
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i] !== fcfs[i]) { priorityActivations++; break }
      }
      toProcess = reordered
    } else {
      toProcess = group
    }
    for (const pt of toProcess) {
      tryOpen(pt, bt)
    }
  }

  realizeFillsUntil(Number.MAX_SAFE_INTEGER)
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    mode, trades: fullyClosed.length, opened, skipped, downsized,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    priorityActivations,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }

async function main() {
  console.log('Daily Breakout — margin downsize + priority sort verification')
  console.log(`Symbols: ${PROD_SYMBOLS.length} | Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | Target margin ${TARGET_MARGIN_PCT}%`)
  console.log(`Priority threshold: ${HISTORY_MIN_TRADES} trades | Min free for downsize: $${MIN_FREE_FOR_DOWNSIZE}`)
  console.log()

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
    runOne(m5, cfg, fullStart, now).forEach(t => allFull.push(toPortfolioTrade(sym, t)))
    runOne(m5, cfg, fullStart, trainEnd).forEach(t => allTrain.push(toPortfolioTrade(sym, t)))
    runOne(m5, cfg, trainEnd, now).forEach(t => allTest.push(toPortfolioTrade(sym, t)))
  }

  console.log(`Trade pool: FULL ${allFull.length} | TRAIN ${allTrain.length} | TEST ${allTest.length}`)
  console.log()

  for (const [label, pool] of [['FULL', allFull], ['TRAIN', allTrain], ['TEST', allTest]] as const) {
    console.log(`=== ${label} ===`)
    console.log('Mode      | trades | opened | skipped | downsized | priorAct | totalR  | R/tr  | finalDepo | peak    | maxDD  | WR')
    console.log('-'.repeat(125))
    for (const mode of ['baseline', 'downsize', 'priority', 'both'] as const) {
      const r = simulate(pool, mode, STARTING_DEPOSIT)
      console.log(`${mode.padEnd(9)} | ${r.trades.toString().padStart(6)} | ${r.opened.toString().padStart(6)} | ${r.skipped.toString().padStart(7)} | ${r.downsized.toString().padStart(9)} | ${r.priorityActivations.toString().padStart(8)} | ${fmtR(r.totalR).padStart(7)} | ${fmtR(r.rPerTr).padStart(5)} | $${r.finalDeposit.toFixed(0).padStart(8)} | $${r.peakDeposit.toFixed(0).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)}% | ${r.winRate.toFixed(0)}%`)
    }
    console.log()
  }

  console.log('=== Done ===')
  console.log()
  console.log('Legend:')
  console.log('  baseline  = current prod (skip on insufficient margin)')
  console.log('  downsize  = open at free margin if target doesn\'t fit (lev bumped, capped at maxLev)')
  console.log('  priority  = baseline + Variant B′ sort within 5min buckets')
  console.log('  both      = downsize + priority B′  (proposed prod state)')
  console.log('  priorAct  = ticks where priority sort changed FCFS order')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
