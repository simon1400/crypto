/**
 * Daily Breakout — EOD policy comparison (uses production runLadderBacktest engine).
 *
 * Compares 3 expiry policies on the same signal generator (23 prod symbols, 365d):
 *
 *   1. EOD-ALL    : close every open trade at 23:55 UTC of signal day  (current LIVE)
 *   2. EOD-NO-TP1 : close at 23:55 UTC ONLY if TP1 not yet hit          (user idea)
 *   3. EOD-NEVER  : never close on EOD, let SL/TP3 decide               (current BACKTEST)
 *
 * Implementation: re-uses runLadderBacktest from existing scripts. Policy is applied
 * by feeding the engine a SLICED candle stream:
 *   - ALL/NO_TP1: pass candles only up to 23:55 UTC of signal day; engine closes
 *                 at end of stream with reason='EOD'
 *   - NO_TP1 with TP1 reached: re-run with full stream (let runner play out)
 *   - NEVER: full stream (matches runBacktest_dailybreak_compare.ts behaviour)
 *
 * Per-symbol cap: enforced by "block any signal whose entry < previous trade exit".
 * Same trick as in compare-script's natural single-position invariant.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_eodpolicy.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade } from './ladderBacktester'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from '../services/marginGuard'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const FEES_RT = 0.0008
const SLIPPAGE = 0.0005

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

type EodPolicy = 'ALL' | 'NO_TP1' | 'NEVER'

interface Sizing {
  name: string
  maxConcurrent: number
  targetMarginPct: number
}

const SIZING_A: Sizing = { name: 'A (10 conc, 10%)', maxConcurrent: 10, targetMarginPct: 10 }
const SIZING_B: Sizing = { name: 'B (20 conc,  5%)', maxConcurrent: 20, targetMarginPct: 5 }

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

interface RawSignal extends LadderSignal {
  utcDate: string
  eodCutoff: number  // unix ms of 23:55 UTC of signal day
}

function generateRawSignals(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number): RawSignal[] {
  const sigs: RawSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = new Date(c.time).toISOString().slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }
  for (const [utcDate, candles] of byDay) {
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
      const eodCutoff = new Date(`${utcDate}T23:55:00.000Z`).getTime()
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout', utcDate, eodCutoff })
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
  entryPrice: number       // signal entryPrice (slip-adjusted is in fills via grossR)
  initialSL: number
  reachedTp1: boolean
  closeReason: string      // 'SL' | 'LADDER_DONE' | 'EOD' | 'MAX_HOLD'
  // synthesized fills with absolute time + R contribution + percent
  fills: { time: number; pricePnlR: number; percent: number; reason: string }[]
  ladderTrade: LadderTrade // raw engine output for diagnostics
}

/**
 * Run engine on a sliced candle stream and synthesize fills.
 *
 * For ALL/NO_TP1 we slice [entryIdx .. lastIdxAtOrBefore_eod].
 * For NO_TP1 + reachedTp1 → re-run with full stream (let runner play).
 * For NEVER we use full stream.
 */
function simulateOne(
  symbol: string, candles: OHLCV[], sig: RawSignal,
  policy: EodPolicy, sigCandleIdx: number,
): PortfolioTrade | null {
  // Determine candle slice for the FIRST pass
  let endIdx = candles.length - 1
  if (policy !== 'NEVER') {
    // Find last candle <= eodCutoff (23:55 UTC)
    for (let i = sigCandleIdx + 1; i < candles.length; i++) {
      if (candles[i].time > sig.eodCutoff) { endIdx = i - 1; break }
    }
  }
  const slice1 = candles.slice(sigCandleIdx, endIdx + 1)

  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick',
    splits: SPLITS,
    trailing: true,
    feesRoundTrip: FEES_RT,
    slippagePerSide: SLIPPAGE,
  }

  // Engine generator: emit our signal at idx 0 only
  let emitted = false
  const gen = (i: number): LadderSignal | null => {
    if (i === 1 && !emitted) {
      // engine signal comparator: it gen()s starting from i=1; signal triggers entry on i=1's bar
      // but we pass sig.entryTime = slice1[0].time; engine opens at sig and walks from i=2.
      // To match: rewrite sig.entryTime to slice1[1].time? No — sig.entryTime stays as the trigger,
      // and sig.entryPrice is what gets used. Engine doesn't actually look at entryTime for matching.
      emitted = true
      return sig
    }
    return null
  }
  // Re-emitter so each call returns sig only once
  let emit = false
  const emitOnce: (i: number) => LadderSignal | null = (i) => {
    if (i === 0 || emit) return null
    emit = true
    return sig
  }

  const result = runLadderBacktest(slice1, emitOnce, ladderCfg)
  if (result.trades.length === 0) return null
  let trade = result.trades[0]

  // For NO_TP1 + reached TP1 → re-run on full stream after entry
  if (policy === 'NO_TP1' && trade.exitReason === 'EOD') {
    const reachedTp1 = trade.fills.some(f => f.idx === 0)
    if (reachedTp1) {
      // re-run on full stream (sigCandleIdx .. end)
      const fullSlice = candles.slice(sigCandleIdx)
      let emit2 = false
      const emitOnce2: (i: number) => LadderSignal | null = (i) => {
        if (i === 0 || emit2) return null
        emit2 = true
        return sig
      }
      const fullResult = runLadderBacktest(fullSlice, emitOnce2, ladderCfg)
      if (fullResult.trades.length > 0) trade = fullResult.trades[0]
    }
  }

  // Synthesize fills with absolute times and explicit reasons
  const fillCount = trade.fills.length
  const fills: PortfolioTrade['fills'] = trade.fills.map((f, i) => {
    const frac = fillCount > 1 ? (i + 1) / fillCount : 1
    const time = trade.entryTime + (trade.exitTime - trade.entryTime) * frac
    let reason: string
    if (f.idx >= 0) reason = `TP${f.idx + 1}`
    else if (trade.exitReason === 'EOD' || trade.exitReason === 'MAX_HOLD') reason = 'EOD'
    else reason = 'SL'
    return { time, pricePnlR: f.rContrib, percent: f.frac * 100, reason }
  })

  const reachedTp1 = trade.fills.some(f => f.idx === 0)

  return {
    symbol, entryTime: trade.entryTime, closeTime: trade.exitTime, side: trade.side,
    entryPrice: trade.entryPrice, initialSL: trade.initialSL,
    reachedTp1, closeReason: trade.exitReason,
    fills, ladderTrade: trade,
  }
}

function buildSymbolTrades(
  symbol: string, m5: OHLCV[], cfg: BreakoutCfg,
  periodFrom: number, periodTo: number, policy: EodPolicy,
): PortfolioTrade[] {
  const sigs = generateRawSignals(m5, cfg, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const trades: PortfolioTrade[] = []
  let blockedUntilTime = 0

  for (const sig of sigs) {
    if (sig.entryTime <= blockedUntilTime) continue   // overlap with previous trade — drop
    let sigIdx = -1
    for (let i = 0; i < periodCandles.length; i++) {
      if (periodCandles[i].time === sig.entryTime) { sigIdx = i; break }
      if (periodCandles[i].time > sig.entryTime) break
    }
    if (sigIdx < 0) continue
    const trade = simulateOne(symbol, periodCandles, sig, policy, sigIdx)
    if (!trade) continue
    trades.push(trade)
    blockedUntilTime = trade.closeTime
  }
  return trades
}

interface SimResult {
  label: string
  trades: number
  opened: number
  skippedConcurrent: number
  skippedMargin: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  maxDD: number
  winRate: number
  reachedTp1: number
  closeReasons: Record<string, number>
}

function simulate(allTrades: PortfolioTrade[], sizing: Sizing, deposit: number, label: string): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
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
  let opened = 0, skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0, reachedTp1Count = 0
  const closeReasons: Record<string, number> = {}

  function applyDDCheck() {
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
        applyDDCheck()
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        if (a.pt.reachedTp1) reachedTp1Count++
        closeReasons[a.pt.closeReason] = (closeReasons[a.pt.closeReason] ?? 0) + 1
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        active.splice(ai, 1)
      }
    }
  }

  for (const pt of sorted) {
    realizeFillsUntil(pt.entryTime)
    const slDist = Math.abs(pt.entryPrice - pt.initialSL)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= sizing.maxConcurrent) { skippedConcurrent++; continue }

    const sizingResult = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: sizing.targetMarginPct,
      entry: pt.entryPrice, sl: pt.initialSL,
    })
    if (!sizingResult) { skippedMargin++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
      hasTP2: a.statusKey === 'TP2_HIT',
    }))

    const guard = evaluateOpenWithGuard(currentDeposit, sizingResult.marginUsd, existing)
    if (!guard.canOpen) { skippedMargin++; continue }
    if (guard.toClose.length > 0) { skippedMargin++; continue }

    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizingResult.positionSizeUsd,
      leverage: sizingResult.leverage,
      marginUsd: sizingResult.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizingResult.riskUsd,
    })
    opened++
    applyDDCheck()
  }

  realizeFillsUntil(Number.MAX_SAFE_INTEGER)
  for (const a of active) {
    if (a.realizedR > 0) wins++
    if (a.pt.reachedTp1) reachedTp1Count++
    closeReasons[a.pt.closeReason] = (closeReasons[a.pt.closeReason] ?? 0) + 1
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    label,
    trades: fullyClosed.length, opened, skippedConcurrent, skippedMargin,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    reachedTp1: reachedTp1Count,
    closeReasons,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmt$(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e4) return `$${(v / 1e3).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

interface SymbolData {
  symbol: string
  m5: OHLCV[]
}

async function main() {
  console.log('Daily Breakout — EOD policy comparison (engine: runLadderBacktest)')
  console.log(`Symbols: ${PROD_SYMBOLS.length} | Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | 365d`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const symbols: SymbolData[] = []
  for (const sym of PROD_SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    symbols.push({ symbol: sym, m5 })
  }
  console.log(`Loaded ${symbols.length} symbols\n`)

  const cfg: BreakoutCfg = {
    rangeBars: RANGE_BARS, volMultiplier: VOL_MULT,
    tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2],
  }

  const policies: { key: EodPolicy; label: string }[] = [
    { key: 'ALL',    label: 'EOD-ALL    (current LIVE)' },
    { key: 'NO_TP1', label: 'EOD-NO-TP1 (user idea)' },
    { key: 'NEVER',  label: 'EOD-NEVER  (let runners run)' },
  ]

  for (const [periodLabel, periodFrom, periodTo] of [
    ['FULL',  fullStart, now],
    ['TRAIN', fullStart, trainEnd],
    ['TEST',  trainEnd,  now],
  ] as [string, number, number][]) {
    console.log(`============================ ${periodLabel} ============================`)

    const pools = new Map<EodPolicy, PortfolioTrade[]>()
    for (const p of policies) {
      const pool: PortfolioTrade[] = []
      for (const { symbol, m5 } of symbols) {
        pool.push(...buildSymbolTrades(symbol, m5, cfg, periodFrom, periodTo, p.key))
      }
      pools.set(p.key, pool)
    }

    const counts = policies.map(p => `${p.key}:${pools.get(p.key)!.length}`).join(' ')
    console.log(`Trade pool sizes: ${counts}\n`)

    for (const sizing of [SIZING_A, SIZING_B]) {
      console.log(`--- Sizing ${sizing.name} ---`)
      console.log('policy                           | trades | totalR  | R/tr  | finalDepo | peak    | maxDD  | WR  | TP1+ | reasons')
      console.log('-'.repeat(150))
      for (const p of policies) {
        const pool = pools.get(p.key)!
        const r = simulate(pool, sizing, STARTING_DEPOSIT, p.label)
        const reasonsStr = Object.entries(r.closeReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')
        console.log(`${p.label.padEnd(32)} | ${r.trades.toString().padStart(6)} | ${fmtR(r.totalR).padStart(7)} | ${fmtR(r.rPerTr).padStart(5)} | ${fmt$(r.finalDeposit).padStart(9)} | ${fmt$(r.peakDeposit).padStart(7)} | ${r.maxDD.toFixed(1).padStart(5)}% | ${r.winRate.toFixed(0).padStart(2)}% | ${r.reachedTp1.toString().padStart(4)} | ${reasonsStr}`)
      }
      console.log()
    }
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
