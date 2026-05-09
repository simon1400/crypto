/**
 * Daily Breakout — slippage stress test for A vs B configurations.
 *
 * Sweep slippage per side ∈ [0.05%, 0.08%, 0.10%, 0.12%, 0.15%, 0.20%]
 * for both A (10 conc, 10% margin) and B (20 conc, 5% margin) on the
 * refreshed 23-symbol universe.
 *
 * Run: npx tsx src/scalper/runBacktest_dailybreak_slippage.ts
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

const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const FEES_RT = 0.0008

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

interface Scenario {
  name: string
  maxConcurrent: number
  targetMarginPct: number
}

const SCENARIOS: Scenario[] = [
  { name: 'A: 10 conc 10%', maxConcurrent: 10, targetMarginPct: 10 },
  { name: 'B: 20 conc  5%', maxConcurrent: 20, targetMarginPct: 5 },
]

const SLIPPAGE_SWEEP = [0.0005, 0.0008, 0.0010, 0.0012, 0.0015, 0.0020]

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
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize * cfg.tp1Mult, entryPrice + rangeSize * cfg.tp2Mult, entryPrice + rangeSize * cfg.tp3Mult]
        : [entryPrice - rangeSize * cfg.tp1Mult, entryPrice - rangeSize * cfg.tp2Mult, entryPrice - rangeSize * cfg.tp3Mult]
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

function runOne(m5: OHLCV[], cfg: BreakoutCfg, periodFrom: number, periodTo: number, slippage: number): LadderTrade[] {
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
    slippagePerSide: slippage,
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
    else if (t.exitReason === 'EOD' || t.exitReason === 'MAX_HOLD') reason = 'EXPIRED'
    else reason = 'SL'
    return { time, pricePnlR: f.rContrib, percent: f.frac * 100, reason }
  })
  return {
    symbol,
    entryTime: t.entryTime,
    closeTime: t.exitTime,
    side: t.side,
    entryPrice: t.entryPrice,
    sl: t.initialSL,
    pnlR: t.pnlR,
    fills,
  }
}

interface SimResult {
  scenario: string
  slippage: number
  trades: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
}

function simulate(allTrades: PortfolioTrade[], scenario: Scenario, deposit: number): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = deposit
  let peak = deposit
  let minDeposit = deposit
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
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0

  function applyEvent() {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < minDeposit) minDeposit = currentDeposit
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
        active.splice(ai, 1)
      }
    }
  }

  for (const ev of [...sorted.entries()].map(([i, p]) => ({ time: p.entryTime, idx: i }))) {
    realizeFillsUntil(ev.time)
    const pt = sorted[ev.idx]
    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) continue
    if (active.length >= scenario.maxConcurrent) continue

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: scenario.targetMarginPct,
      entry: pt.entryPrice, sl: pt.sl,
    })
    if (!sizing) continue

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
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
    })
    applyEvent()
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    scenario: scenario.name,
    slippage: 0,  // filled by caller
    trades: fullyClosed.length,
    totalR,
    rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit,
    peakDeposit: peak,
    minDeposit,
    maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length) }
function rpad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s }

async function main() {
  console.log('Daily Breakout — slippage stress test (A vs B, 23 symbols, 365d)')
  console.log(`Symbols (${SYMBOLS.length}): ${SYMBOLS.join(', ')}`)
  console.log(`Slippage sweep: ${SLIPPAGE_SWEEP.map(s => (s * 100).toFixed(2) + '%').join(', ')}`)
  console.log(`Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | fees 0.08% RT`)
  console.log()

  // Load all symbols once
  const symbolData: Map<string, OHLCV[]> = new Map()
  for (const sym of SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    symbolData.set(sym, m5)
  }
  console.log(`Loaded ${symbolData.size} symbols`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const now = Date.now()
  const cfg: BreakoutCfg = {
    rangeBars: RANGE_BARS, volMultiplier: VOL_MULT,
    tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2],
  }

  // Re-generate trade pool for each slippage value (slippage affects per-trade R)
  const allRows: SimResult[] = []

  for (const slip of SLIPPAGE_SWEEP) {
    const allTrades: PortfolioTrade[] = []
    for (const [sym, m5] of symbolData) {
      runOne(m5, cfg, fullStart, now, slip).forEach(t => allTrades.push(toPortfolioTrade(sym, t)))
    }

    for (const sc of SCENARIOS) {
      const r = simulate(allTrades, sc, STARTING_DEPOSIT)
      r.slippage = slip
      allRows.push(r)
    }
  }

  // Print table grouped by scenario
  console.log('=== Stress test results ===')
  console.log()
  for (const sc of SCENARIOS) {
    console.log(`--- ${sc.name} ---`)
    console.log(pad('Slippage', 10) + ' | ' + pad('Trades', 7) + ' | ' + pad('totalR', 8) + ' | ' + pad('R/tr', 7) + ' | ' + pad('Final $', 10) + ' | ' + pad('Min $', 8) + ' | ' + pad('Peak $', 9) + ' | ' + pad('MaxDD', 7) + ' | ' + 'WR')
    console.log('-'.repeat(95))
    for (const row of allRows.filter(r => r.scenario === sc.name)) {
      console.log(
        pad((row.slippage * 100).toFixed(2) + '%', 10) + ' | ' +
        rpad(row.trades.toString(), 7) + ' | ' +
        rpad(fmtR(row.totalR), 8) + ' | ' +
        rpad(fmtR(row.rPerTr), 7) + ' | ' +
        rpad('$' + row.finalDeposit.toFixed(0), 10) + ' | ' +
        rpad('$' + row.minDeposit.toFixed(0), 8) + ' | ' +
        rpad('$' + row.peakDeposit.toFixed(0), 9) + ' | ' +
        rpad(row.maxDD.toFixed(1) + '%', 7) + ' | ' +
        row.winRate.toFixed(0) + '%'
      )
    }
    console.log()
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
