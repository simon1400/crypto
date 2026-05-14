/**
 * Trend-Following Strategy #2: Donchian Channel Breakout (Classic Turtle) on 4h.
 *
 * Logic (Curtis Faith Turtle System #1):
 *   - Aggregate 5m → 4h
 *   - LONG entry: close above max(high[-20..-1])
 *   - SHORT entry: close below min(low[-20..-1])
 *   - Exit: opposite signal (close below 10-bar low for LONG, above 10-bar high for SHORT)
 *   - SL: entry - 2×ATR(14) for LONG (initial stop)
 *   - No fixed TP — trail with 10-bar low for LONG (or 10-bar high for SHORT)
 *   - Max hold: 60 4h bars (10 days)
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_trend_donchian.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
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
const TIMEFRAME_HOURS = 4
const MAX_HOLD_BARS = 60

const ENTRY_LOOKBACK = 20
const EXIT_LOOKBACK = 10
const ATR_PERIOD = 14
const SL_ATR_MULT = 2.0

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const UNIVERSE_TOP10 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'POLUSDT',
]

const VARIANT_D = { startingDeposit: 320, maxConcurrent: 20, targetMarginPct: 5 }

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mTo4h(m5: OHLCV[]): OHLCV[] {
  const bucketMs = TIMEFRAME_HOURS * 3600_000
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const b = Math.floor(c.time / bucketMs) * bucketMs
    const list = buckets.get(b) ?? []
    list.push(c); buckets.set(b, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t, open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function atrSeries(candles: OHLCV[], period = ATR_PERIOD): number[] {
  const n = candles.length
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  return ema(tr, period)
}

interface DonchianSignal {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryIdx: number
  entryPrice: number
  sl: number
  atr: number
}

function generateSignals(
  candles4h: OHLCV[], symbol: string, periodFrom: number, periodTo: number,
): DonchianSignal[] {
  const atr = atrSeries(candles4h, ATR_PERIOD)
  const signals: DonchianSignal[] = []
  const minBars = Math.max(ENTRY_LOOKBACK, ATR_PERIOD * 2) + 1
  for (let i = minBars; i < candles4h.length; i++) {
    const c = candles4h[i]
    if (c.time < periodFrom || c.time > periodTo) continue
    if (!isFinite(atr[i]) || atr[i] <= 0) continue

    // Donchian channels — exclude current bar
    const window = candles4h.slice(i - ENTRY_LOOKBACK, i)
    const upperBreak = Math.max(...window.map(x => x.high))
    const lowerBreak = Math.min(...window.map(x => x.low))

    let side: 'BUY' | 'SELL' | null = null
    if (c.close > upperBreak) side = 'BUY'
    else if (c.close < lowerBreak) side = 'SELL'
    if (!side) continue

    const atrValue = atr[i]
    const entryPrice = c.close
    const sl = side === 'BUY' ? entryPrice - SL_ATR_MULT * atrValue : entryPrice + SL_ATR_MULT * atrValue

    signals.push({ symbol, side, entryTime: c.time, entryIdx: i, entryPrice, sl, atr: atrValue })
  }
  return signals
}

interface ExitFill {
  time: number; price: number; percent: number
  reason: 'SL' | 'DONCHIAN_EXIT' | 'MAX_HOLD'
  isMaker: boolean
}

interface ExitResult { fills: ExitFill[]; closeTime: number }

function simulateExit(candles4h: OHLCV[], signal: DonchianSignal): ExitResult {
  const isLong = signal.side === 'BUY'
  const exitFills: ExitFill[] = []

  for (let i = signal.entryIdx + 1; i < Math.min(candles4h.length, signal.entryIdx + 1 + MAX_HOLD_BARS); i++) {
    const c = candles4h[i]
    // SL check first
    const slHit = isLong ? c.low <= signal.sl : c.high >= signal.sl
    if (slHit) {
      exitFills.push({ time: c.time, price: signal.sl, percent: 100, reason: 'SL', isMaker: false })
      return { fills: exitFills, closeTime: c.time }
    }
    // Donchian exit: close beyond EXIT_LOOKBACK opposite extreme
    if (i >= ENTRY_LOOKBACK + EXIT_LOOKBACK) {
      const exitWindow = candles4h.slice(i - EXIT_LOOKBACK, i)
      if (isLong) {
        const exitLow = Math.min(...exitWindow.map(x => x.low))
        if (c.close < exitLow) {
          exitFills.push({ time: c.time, price: c.close, percent: 100, reason: 'DONCHIAN_EXIT', isMaker: false })
          return { fills: exitFills, closeTime: c.time }
        }
      } else {
        const exitHigh = Math.max(...exitWindow.map(x => x.high))
        if (c.close > exitHigh) {
          exitFills.push({ time: c.time, price: c.close, percent: 100, reason: 'DONCHIAN_EXIT', isMaker: false })
          return { fills: exitFills, closeTime: c.time }
        }
      }
    }
  }
  // Max hold
  const lastIdx = Math.min(candles4h.length - 1, signal.entryIdx + MAX_HOLD_BARS)
  if (lastIdx > signal.entryIdx) {
    const lastBar = candles4h[lastIdx]
    exitFills.push({ time: lastBar.time, price: lastBar.close, percent: 100, reason: 'MAX_HOLD', isMaker: false })
    return { fills: exitFills, closeTime: lastBar.time }
  }
  return { fills: exitFills, closeTime: signal.entryTime }
}

interface PortfolioTrade { signal: DonchianSignal; exit: ExitResult }

interface SimResult {
  startingDeposit: number
  signalsTotal: number
  opened: number
  trades: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
  slRate: number
  donchianRate: number
  maxHoldRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(allTrades: PortfolioTrade[]): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.signal.entryTime - b.signal.entryTime)
  let currentDeposit = VARIANT_D.startingDeposit
  let peak = VARIANT_D.startingDeposit
  let trough = VARIANT_D.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0

  interface Active {
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    positionUnits: number
    leverage: number
    marginUsd: number
    realizedR: number
    effectiveEntryPrice: number
    riskUsd: number
    closedFracPct: number
    fillsApplied: number
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let wins = 0, slHits = 0, donchianHits = 0, maxHoldHits = 0, totalR = 0
  const fullyClosed: PortfolioTrade[] = []

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
      while (a.fillsApplied < a.pt.exit.fills.length && a.pt.exit.fills[a.fillsApplied].time <= t) {
        const f = a.pt.exit.fills[a.fillsApplied]
        a.fillsApplied++
        const isLong = a.pt.signal.side === 'BUY'
        const exitPrice = isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP)
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeUsd = fillNotional * TAKER_FEE
        const slipUsd = fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        totalFees += feeUsd
        totalSlip += slipUsd
        const slDist = Math.abs(a.pt.signal.entryPrice - a.pt.signal.sl)
        const rContrib = ((isLong ? f.price - a.pt.signal.entryPrice : a.pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
        a.realizedR += rContrib
        a.closedFracPct += f.percent
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        const lastReason = a.pt.exit.fills[a.pt.exit.fills.length - 1]?.reason
        if (lastReason === 'SL') slHits++
        else if (lastReason === 'DONCHIAN_EXIT') donchianHits++
        else if (lastReason === 'MAX_HOLD') maxHoldHits++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        addMonthly(a.pt.exit.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  const takenSet = new Set<string>()
  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.signal.entryTime)
    if (active.some(a => a.pt.signal.symbol === pt.signal.symbol)) continue
    const key = `${pt.signal.symbol}|${pt.signal.entryTime}`
    if (takenSet.has(key)) continue
    if (active.length >= VARIANT_D.maxConcurrent) continue
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    if (slDist <= 0 || currentDeposit <= 0) continue

    const isLong = pt.signal.side === 'BUY'
    const effectiveEntry = isLong
      ? pt.signal.entryPrice * (1 + TAKER_SLIP)
      : pt.signal.entryPrice * (1 - TAKER_SLIP)
    const sizing = computeSizing({
      symbol: pt.signal.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_D.targetMarginPct,
      entry: effectiveEntry, sl: pt.signal.sl,
    })
    if (!sizing) continue
    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.signal.symbol, status: 'OPEN',
      positionSizeUsd: a.positionSizeUsd, closedFrac: a.closedFracPct / 100,
      leverage: a.leverage, unrealizedR: a.realizedR, hasTP1: false, hasTP2: false,
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFee = entryNotional * TAKER_FEE
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.signal.entryPrice)
    currentDeposit -= entryFee
    totalFees += entryFee
    totalSlip += entrySlip
    applyDD(pt.signal.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd, positionUnits: sizing.positionUnits,
      leverage: sizing.leverage, marginUsd: sizing.marginUsd,
      realizedR: 0, effectiveEntryPrice: effectiveEntry,
      riskUsd: sizing.riskUsd, closedFracPct: 0, fillsApplied: 0,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  const tradeCount = fullyClosed.length
  return {
    startingDeposit: VARIANT_D.startingDeposit,
    signalsTotal: allTrades.length,
    opened, trades: tradeCount,
    totalR, rPerTr: tradeCount > 0 ? totalR / tradeCount : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
    slRate: tradeCount > 0 ? (slHits / tradeCount) * 100 : 0,
    donchianRate: tradeCount > 0 ? (donchianHits / tradeCount) * 100 : 0,
    maxHoldRate: tradeCount > 0 ? (maxHoldHits / tradeCount) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} ---`)
  console.log(
    `signals=${r.signalsTotal} opened=${r.opened} trades=${r.trades} | ` +
    `WR=${r.winRate.toFixed(0)}% SL=${r.slRate.toFixed(0)}% DON=${r.donchianRate.toFixed(0)}% MAX=${r.maxHoldRate.toFixed(0)}% | ` +
    `R/tr=${fmtR(r.rPerTr)} totalR=${fmtR(r.totalR)} | ` +
    `final $${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%) peak $${r.peakDeposit.toFixed(0)} min $${r.minDeposit.toFixed(0)} DD ${r.maxDD.toFixed(1)}% | ` +
    `fees $${r.totalFeesUsd.toFixed(0)} slip $${r.totalSlipUsd.toFixed(0)}`,
  )
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- ${label} monthly ---`)
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Trend Strategy #2: Donchian Channel Breakout (Classic Turtle) on 4h')
  console.log(`Params: entry ${ENTRY_LOOKBACK}-bar / exit ${EXIT_LOOKBACK}-bar | SL: ±${SL_ATR_MULT}×ATR(${ATR_PERIOD}) | max hold ${MAX_HOLD_BARS} bars (${MAX_HOLD_BARS * TIMEFRAME_HOURS}h)`)
  console.log(`Universe: top-10 majors`)
  console.log(`Variant D candidate: $${VARIANT_D.startingDeposit} | ${VARIANT_D.maxConcurrent} conc | ${VARIANT_D.targetMarginPct}% margin | ${RISK_PCT}% risk`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading m5 → aggregating to 4h...')
  const candles4hBySymbol = new Map<string, OHLCV[]>()
  for (const sym of UNIVERSE_TOP10) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    candles4hBySymbol.set(sym, aggregate5mTo4h(m5))
  }
  console.log(`Loaded ${candles4hBySymbol.size}\n`)

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  function buildSignals(from: number, to: number): DonchianSignal[] {
    const all: DonchianSignal[] = []
    for (const [sym, c] of candles4hBySymbol.entries()) all.push(...generateSignals(c, sym, from, to))
    return all
  }
  function buildTrades(sigs: DonchianSignal[]): PortfolioTrade[] {
    return sigs.map(s => ({ signal: s, exit: simulateExit(candles4hBySymbol.get(s.symbol)!, s) }))
  }

  const sFull = buildSignals(fullStart, now)
  const sTrain = buildSignals(fullStart, trainEnd)
  const sTest = buildSignals(trainEnd, now)
  console.log(`Signals: FULL ${sFull.length} | TRAIN ${sTrain.length} | TEST ${sTest.length}\n`)

  const fullR = simulate(buildTrades(sFull))
  const trainR = simulate(buildTrades(sTrain))
  const testR = simulate(buildTrades(sTest))

  printResult('FULL (365d)', fullR)
  printResult('TRAIN (60%)', trainR)
  printResult('TEST (40%)', testR)
  console.log()
  printMonthly('FULL', fullR)
  console.log()

  // Per-symbol
  const bySymbol = new Map<string, { signals: number; wins: number; losses: number; r: number }>()
  for (const pt of buildTrades(sFull)) {
    const sym = pt.signal.symbol
    if (!bySymbol.has(sym)) bySymbol.set(sym, { signals: 0, wins: 0, losses: 0, r: 0 })
    const e = bySymbol.get(sym)!
    e.signals++
    let r = 0
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    const isLong = pt.signal.side === 'BUY'
    for (const f of pt.exit.fills) {
      r += ((isLong ? f.price - pt.signal.entryPrice : pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
    }
    e.r += r
    if (r > 0) e.wins++
    else e.losses++
  }
  console.log('--- Per-symbol (FULL) ---')
  for (const [sym, e] of [...bySymbol.entries()].sort((a, b) => b[1].r - a[1].r)) {
    const wr = (e.signals > 0 ? (e.wins / (e.wins + e.losses)) * 100 : 0).toFixed(0)
    console.log(`  ${sym.padEnd(10)} | sig=${e.signals.toString().padStart(3)} W=${e.wins.toString().padStart(2)} L=${e.losses.toString().padStart(2)} WR=${wr}% | totalR=${fmtR(e.r)}`)
  }
  console.log()

  const trainRet = (trainR.finalDeposit / trainR.startingDeposit - 1) * 100
  const testRet = (testR.finalDeposit / testR.startingDeposit - 1) * 100
  console.log('=== Verdict ===')
  console.log(`TRAIN: ${trainRet >= 0 ? '+' : ''}${trainRet.toFixed(0)}% | TEST: ${testRet >= 0 ? '+' : ''}${testRet.toFixed(0)}%`)
  console.log(`Robust (both positive): ${trainRet > 0 && testRet > 0 ? '✓ YES' : '✗ NO'}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `trend_donchian_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'Donchian Turtle', params: { ENTRY_LOOKBACK, EXIT_LOOKBACK, ATR_PERIOD, SL_ATR_MULT, MAX_HOLD_BARS },
    universe: UNIVERSE_TOP10, variant: VARIANT_D,
    full: { ...fullR, monthly: Object.fromEntries(fullR.monthly) },
    train: { ...trainR, monthly: Object.fromEntries(trainR.monthly) },
    test: { ...testR, monthly: Object.fromEntries(testR.monthly) },
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
