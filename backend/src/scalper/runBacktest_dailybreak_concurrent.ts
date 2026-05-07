/**
 * Daily Breakout — maxConcurrentPositions sweep (guard mode only).
 *
 * Текущий prod: hardcoded skip когда openTrades.length >= 10.
 * Вопрос: убрать numeric cap и оставить ТОЛЬКО margin guard как ограничитель — лучше или хуже?
 *
 * Тестим maxConcurrent ∈ [5, 10, 15, 20, 30, 999] (999 ≈ unlimited, only margin guard).
 * Sizing: guard skip-only (как в prod после margin guard внедрения).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_concurrent.ts
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
const TARGET_MARGIN_PCT = 10
const FEES_RT = 0.0008
const SLIPPAGE = 0.0005

const RANGE_BARS = 36
const VOL_MULT = 2.0
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

// Match DEFAULT_BREAKOUT_SETUPS in dailyBreakoutLiveScanner.ts (32 symbols).
const PROD_SYMBOLS = [
  // Original 11
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
  // Universe expansion 21 ACCEPT (sorted by TEST R/tr desc)
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'SANDUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT',
  'TRUMPUSDT', 'STRKUSDT', 'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT',
  'AEROUSDT', 'ETCUSDT', 'IOUSDT', 'POLUSDT', 'TSTBSCUSDT', 'VVVUSDT',
]
const MAX_CONCURRENT_SWEEP = [5, 10, 15, 20, 30, 999]  // 999 ≈ unlimited (only margin guard)

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
  closeTime: number       // last fill time (or entryTime if SL on entry candle)
  side: 'BUY' | 'SELL'
  entryPrice: number
  sl: number
  pnlR: number            // R-units (post-fees, post-slippage)
  fills: { time: number; pricePnlR: number; percent: number; reason: string }[]
}

function toPortfolioTrade(symbol: string, t: LadderTrade): PortfolioTrade {
  // LadderTrade.fills: { idx, price, frac, rContrib }
  // idx >= 0 → TP at that ladder slot (0 = TP1, 1 = TP2, ...). idx < 0 → SL/EOD exit.
  // We don't have intraday timestamps for individual fills — approximate by linearly
  // interpolating between entryTime and exitTime so margin sim sees fills in order.
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
  maxConcurrent: number
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
}

function simulate(allTrades: PortfolioTrade[], maxConcurrent: number, deposit: number): SimResult {
  // Sort all trades by entry time
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)

  let currentDeposit = deposit
  let peak = deposit
  let maxDD = 0

  // Active positions: track entry margin and P&L unrealized
  interface Active {
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    leverage: number
    marginUsd: number
    fillsApplied: number  // count of fills already realised
    closedFracPct: number // 0..100
    statusKey: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
    realizedR: number
    riskUsd: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0, skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0

  const eventQueue: { time: number; type: 'fill' | 'open'; tradeIdx?: number; activeId?: number; fillIdx?: number }[] = []

  // Build event queue: opens + fills in time order
  for (let i = 0; i < sorted.length; i++) {
    eventQueue.push({ time: sorted[i].entryTime, type: 'open', tradeIdx: i })
  }
  // Fills will be added when trades open

  eventQueue.sort((a, b) => a.time - b.time)

  // Helper to update DD based on unrealized
  function applyEvent(time: number) {
    if (currentDeposit > peak) peak = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
  }

  function realizeFillsUntil(t: number) {
    // For each active, drain fills with time <= t
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.fills.length && a.pt.fills[a.fillsApplied].time <= t) {
        const f = a.pt.fills[a.fillsApplied]
        a.fillsApplied++
        // Apply pnl in R, scale to USD via riskUsd
        const pnlUsd = f.pricePnlR * a.riskUsd
        currentDeposit += pnlUsd
        a.realizedR += f.pricePnlR
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        applyEvent(f.time)
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        // Trade fully closed
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        active.splice(ai, 1)
      }
    }
  }

  for (const ev of eventQueue) {
    realizeFillsUntil(ev.time)
    if (ev.type !== 'open') continue
    const pt = sorted[ev.tradeIdx!]
    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }

    // Numeric concurrent cap (parameterised; 999 ≈ unlimited)
    if (active.length >= maxConcurrent) { skippedConcurrent++; continue }

    // Always guard mode: skip-only on margin deficit
    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: TARGET_MARGIN_PCT,
      entry: pt.entryPrice, sl: pt.sl,
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
    // skip-only mode: if guard wants to close anything, skip new trade instead
    if (guard.toClose.length > 0) { skippedMargin++; continue }

    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
    })
    opened++
    applyEvent(ev.time)
  }

  // Drain remaining active at end
  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    maxConcurrent, trades: fullyClosed.length, opened, skippedConcurrent, skippedMargin,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtPct(p: number): string { return (p >= 0 ? '+' : '') + p.toFixed(1) + '%' }

async function main() {
  console.log('Daily Breakout — maxConcurrentPositions sweep (guard skip-only mode)')
  console.log(`Symbols: ${PROD_SYMBOLS.length} | Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | Target margin ${TARGET_MARGIN_PCT}%`)
  console.log(`Sweep: ${MAX_CONCURRENT_SWEEP.join(', ')} (999 ≈ unlimited, only margin guard limits)`)
  console.log()

  // Load all trades for prod symbols
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
    console.log('maxConc | trades | opened | skipConc | skipMarg | totalR  | R/tr  | finalDepo | peak    | maxDD  | WR')
    console.log('-'.repeat(110))
    for (const mc of MAX_CONCURRENT_SWEEP) {
      const r = simulate(pool, mc, STARTING_DEPOSIT)
      const mcLabel = mc >= 999 ? '∞' : mc.toString()
      console.log(`${mcLabel.padEnd(7)} | ${r.trades.toString().padStart(6)} | ${r.opened.toString().padStart(6)} | ${r.skippedConcurrent.toString().padStart(8)} | ${r.skippedMargin.toString().padStart(8)} | ${fmtR(r.totalR).padStart(7)} | ${fmtR(r.rPerTr).padStart(5)} | $${r.finalDeposit.toFixed(0).padStart(8)} | $${r.peakDeposit.toFixed(0).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)}% | ${r.winRate.toFixed(0)}%`)
    }
    console.log()
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
