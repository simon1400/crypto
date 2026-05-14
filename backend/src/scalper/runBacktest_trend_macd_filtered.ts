/**
 * MACD + EMA200 strategy with WALK-FORWARD universe selection.
 *
 * Critical: чтобы избежать selection bias (выбор символов на FULL = peeking at TEST),
 * выбираем universe на TRAIN-only R > 0, потом тестируем на TEST.
 *
 * Steps:
 *   1. Run MACD strategy на всех top-10 за TRAIN (первые 60% периода)
 *   2. Выбрать symbols где TRAIN totalR > 0
 *   3. Запустить ту же стратегию на выбранных symbols за TEST (последние 40%)
 *   4. Сравнить: универсальный TRAIN+TEST на full universe vs filtered
 *
 * Если filtered TEST положительный → есть persistent edge на этих монетах.
 * Если нет → TRAIN selection не предсказывает TEST (просто данные шумят).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_trend_macd_filtered.ts
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
const MAX_HOLD_BARS = 42

const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
const EMA_TREND = 200
const ATR_PERIOD = 14
const SL_ATR_MULT = 2.0
const TP1_ATR_MULT = 2.0
const TP2_ATR_MULT = 4.0

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

function atrSeries(candles: OHLCV[]): number[] {
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  return ema(tr, ATR_PERIOD)
}

function macd(closes: number[]) {
  const emaFast = ema(closes, MACD_FAST)
  const emaSlow = ema(closes, MACD_SLOW)
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i])
  const sigLine = ema(macdLine, MACD_SIGNAL)
  return { macdLine, sigLine }
}

interface MacdSignal {
  symbol: string; side: 'BUY' | 'SELL'
  entryTime: number; entryIdx: number; entryPrice: number
  sl: number; tp1: number; tp2: number; atr: number
}

function generateSignals(
  candles4h: OHLCV[], symbol: string, periodFrom: number, periodTo: number,
): MacdSignal[] {
  const closes = candles4h.map(c => c.close)
  const { macdLine, sigLine } = macd(closes)
  const trendEma = ema(closes, EMA_TREND)
  const atr = atrSeries(candles4h)
  const sigs: MacdSignal[] = []
  const minBars = Math.max(EMA_TREND, MACD_SLOW + MACD_SIGNAL) + 1
  for (let i = minBars; i < candles4h.length; i++) {
    const c = candles4h[i]
    if (c.time < periodFrom || c.time > periodTo) continue
    if (!isFinite(atr[i]) || atr[i] <= 0 || !isFinite(trendEma[i])) continue
    const crossUp = macdLine[i - 1] <= sigLine[i - 1] && macdLine[i] > sigLine[i]
    const crossDown = macdLine[i - 1] >= sigLine[i - 1] && macdLine[i] < sigLine[i]
    if (!crossUp && !crossDown) continue
    const uptrend = c.close > trendEma[i]
    const downtrend = c.close < trendEma[i]
    let side: 'BUY' | 'SELL' | null = null
    if (crossUp && uptrend) side = 'BUY'
    else if (crossDown && downtrend) side = 'SELL'
    if (!side) continue
    const entry = c.close
    const a = atr[i]
    const sl = side === 'BUY' ? entry - SL_ATR_MULT * a : entry + SL_ATR_MULT * a
    sigs.push({
      symbol, side,
      entryTime: c.time, entryIdx: i, entryPrice: entry,
      sl,
      tp1: side === 'BUY' ? entry + TP1_ATR_MULT * a : entry - TP1_ATR_MULT * a,
      tp2: side === 'BUY' ? entry + TP2_ATR_MULT * a : entry - TP2_ATR_MULT * a,
      atr: a,
    })
  }
  return sigs
}

interface ExitFill {
  time: number; price: number; percent: number
  reason: 'TP1' | 'TP2' | 'SL' | 'TRAIL_SL' | 'MACD_REVERSE' | 'MAX_HOLD'
  isMaker: boolean
}
interface ExitResult { fills: ExitFill[]; closeTime: number }

function simulateExit(
  candles4h: OHLCV[], signal: MacdSignal,
  macdLine: number[], sigLine: number[],
): ExitResult {
  const isLong = signal.side === 'BUY'
  let currentSL = signal.sl
  let tp1Hit = false, tp2Hit = false
  let remainingPct = 100
  const exitFills: ExitFill[] = []
  for (let i = signal.entryIdx + 1; i < Math.min(candles4h.length, signal.entryIdx + 1 + MAX_HOLD_BARS); i++) {
    const c = candles4h[i]
    const slHit = isLong ? c.low <= currentSL : c.high >= currentSL
    if (slHit) {
      exitFills.push({ time: c.time, price: currentSL, percent: remainingPct, reason: tp1Hit ? 'TRAIL_SL' : 'SL', isMaker: false })
      return { fills: exitFills, closeTime: c.time }
    }
    if (!tp1Hit) {
      const r = isLong ? c.high >= signal.tp1 : c.low <= signal.tp1
      if (r) {
        exitFills.push({ time: c.time, price: signal.tp1, percent: 50, reason: 'TP1', isMaker: true })
        remainingPct -= 50; tp1Hit = true; currentSL = signal.entryPrice
      }
    }
    if (tp1Hit && !tp2Hit) {
      const r = isLong ? c.high >= signal.tp2 : c.low <= signal.tp2
      if (r) {
        exitFills.push({ time: c.time, price: signal.tp2, percent: remainingPct, reason: 'TP2', isMaker: true })
        remainingPct = 0
        return { fills: exitFills, closeTime: c.time }
      }
    }
    const reverseExit = isLong ? macdLine[i] < sigLine[i] : macdLine[i] > sigLine[i]
    if (reverseExit && remainingPct > 0) {
      exitFills.push({ time: c.time, price: c.close, percent: remainingPct, reason: 'MACD_REVERSE', isMaker: false })
      return { fills: exitFills, closeTime: c.time }
    }
  }
  const lastIdx = Math.min(candles4h.length - 1, signal.entryIdx + MAX_HOLD_BARS)
  if (remainingPct > 0 && lastIdx > signal.entryIdx) {
    const lb = candles4h[lastIdx]
    exitFills.push({ time: lb.time, price: lb.close, percent: remainingPct, reason: 'MAX_HOLD', isMaker: false })
    return { fills: exitFills, closeTime: lb.time }
  }
  return { fills: exitFills, closeTime: exitFills[exitFills.length - 1]?.time ?? signal.entryTime }
}

interface PortfolioTrade { signal: MacdSignal; exit: ExitResult }

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
  totalFeesUsd: number
  totalSlipUsd: number
}

function simulate(allTrades: PortfolioTrade[]): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.signal.entryTime - b.signal.entryTime)
  let currentDeposit = VARIANT_D.startingDeposit
  let peak = VARIANT_D.startingDeposit
  let trough = VARIANT_D.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0

  interface Active {
    pt: PortfolioTrade; id: number; positionSizeUsd: number; positionUnits: number
    leverage: number; marginUsd: number; realizedR: number; effectiveEntryPrice: number
    riskUsd: number; closedFracPct: number; fillsApplied: number
    statusKey: 'OPEN' | 'TP1_HIT'
  }
  const active: Active[] = []
  let nextId = 1, opened = 0
  let wins = 0, totalR = 0
  const fullyClosed: PortfolioTrade[] = []

  function applyDD() {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
  }

  function realizeFillsUntil(t: number) {
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.exit.fills.length && a.pt.exit.fills[a.fillsApplied].time <= t) {
        const f = a.pt.exit.fills[a.fillsApplied]
        a.fillsApplied++
        const isLong = a.pt.signal.side === 'BUY'
        const exitPrice = f.isMaker ? f.price : (isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP))
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeUsd = fillNotional * (f.isMaker ? MAKER_FEE : TAKER_FEE)
        const slipUsd = f.isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        currentDeposit += grossPnl - feeUsd
        totalFees += feeUsd
        totalSlip += slipUsd
        const slDist = Math.abs(a.pt.signal.entryPrice - a.pt.signal.sl)
        a.realizedR += ((isLong ? f.price - a.pt.signal.entryPrice : a.pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        applyDD()
      }
      if (a.fillsApplied >= a.pt.exit.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        active.splice(ai, 1)
      }
    }
  }

  const takenSet = new Set<string>()
  for (const pt of sorted) {
    realizeFillsUntil(pt.signal.entryTime)
    if (active.some(a => a.pt.signal.symbol === pt.signal.symbol)) continue
    const key = `${pt.signal.symbol}|${pt.signal.entryTime}`
    if (takenSet.has(key)) continue
    if (active.length >= VARIANT_D.maxConcurrent) continue
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    if (slDist <= 0 || currentDeposit <= 0) continue
    const isLong = pt.signal.side === 'BUY'
    const effectiveEntry = isLong ? pt.signal.entryPrice * (1 + TAKER_SLIP) : pt.signal.entryPrice * (1 - TAKER_SLIP)
    const sizing = computeSizing({
      symbol: pt.signal.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_D.targetMarginPct,
      entry: effectiveEntry, sl: pt.signal.sl,
    })
    if (!sizing) continue
    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.signal.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd, closedFrac: a.closedFracPct / 100,
      leverage: a.leverage, unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT', hasTP2: false,
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) continue
    if (guard.toClose.length > 0) continue

    const entryFee = sizing.positionUnits * effectiveEntry * TAKER_FEE
    const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.signal.entryPrice)
    currentDeposit -= entryFee
    totalFees += entryFee
    totalSlip += entrySlip
    applyDD()
    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd, positionUnits: sizing.positionUnits,
      leverage: sizing.leverage, marginUsd: sizing.marginUsd,
      realizedR: 0, effectiveEntryPrice: effectiveEntry,
      riskUsd: sizing.riskUsd, closedFracPct: 0, fillsApplied: 0, statusKey: 'OPEN',
    })
    opened++
  }
  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }
  const tc = fullyClosed.length
  return {
    startingDeposit: VARIANT_D.startingDeposit, signalsTotal: allTrades.length,
    opened, trades: tc, totalR, rPerTr: tc > 0 ? totalR / tc : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: tc > 0 ? (wins / tc) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
  }
}

// Per-symbol R computation (для selection)
function computePerSymbolR(trades: PortfolioTrade[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const pt of trades) {
    const sym = pt.signal.symbol
    let r = 0
    const slDist = Math.abs(pt.signal.entryPrice - pt.signal.sl)
    const isLong = pt.signal.side === 'BUY'
    for (const f of pt.exit.fills) {
      r += ((isLong ? f.price - pt.signal.entryPrice : pt.signal.entryPrice - f.price) / slDist) * (f.percent / 100)
    }
    result.set(sym, (result.get(sym) ?? 0) + r)
  }
  return result
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} ---`)
  console.log(
    `signals=${r.signalsTotal} opened=${r.opened} trades=${r.trades} | ` +
    `WR=${r.winRate.toFixed(0)}% R/tr=${fmtR(r.rPerTr)} totalR=${fmtR(r.totalR)} | ` +
    `final $${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%) peak $${r.peakDeposit.toFixed(0)} min $${r.minDeposit.toFixed(0)} DD ${r.maxDD.toFixed(1)}% | ` +
    `fees $${r.totalFeesUsd.toFixed(0)} slip $${r.totalSlipUsd.toFixed(0)}`,
  )
}

async function main() {
  console.log('MACD + EMA200 walk-forward universe selection')
  console.log(`Method: 1) Run on full top-10 на TRAIN. 2) Select symbols with TRAIN totalR > 0. 3) Test selection на TEST.`)
  console.log(`Period: 365d | TRAIN ${TRAIN_PCT * 100}% / TEST ${(1 - TRAIN_PCT) * 100}%\n`)

  console.log('Loading m5 → 4h...')
  const candles4hBySymbol = new Map<string, OHLCV[]>()
  const macdBySymbol = new Map<string, { macdLine: number[]; sigLine: number[] }>()
  for (const sym of UNIVERSE_TOP10) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) continue
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) continue
    const c4h = aggregate5mTo4h(m5)
    candles4hBySymbol.set(sym, c4h)
    macdBySymbol.set(sym, macd(c4h.map(c => c.close)))
  }
  console.log(`Loaded ${candles4hBySymbol.size}\n`)

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  function buildSignals(symbols: string[], from: number, to: number): MacdSignal[] {
    const all: MacdSignal[] = []
    for (const sym of symbols) {
      const c = candles4hBySymbol.get(sym)
      if (!c) continue
      all.push(...generateSignals(c, sym, from, to))
    }
    return all
  }
  function buildTrades(sigs: MacdSignal[]): PortfolioTrade[] {
    return sigs.map(s => {
      const m = macdBySymbol.get(s.symbol)!
      return { signal: s, exit: simulateExit(candles4hBySymbol.get(s.symbol)!, s, m.macdLine, m.sigLine) }
    })
  }

  // Step 1: per-symbol на TRAIN
  console.log('=== Step 1: Per-symbol R on TRAIN ===')
  const trainSigs = buildSignals(UNIVERSE_TOP10, fullStart, trainEnd)
  const trainTrades = buildTrades(trainSigs)
  const trainPerSymbol = computePerSymbolR(trainTrades)
  for (const [sym, r] of [...trainPerSymbol.entries()].sort((a, b) => b[1] - a[1])) {
    const verdict = r > 0 ? '✓ KEEP' : '✗ DROP'
    console.log(`  ${sym.padEnd(10)} | TRAIN totalR=${fmtR(r).padStart(7)}  ${verdict}`)
  }
  const selectedUniverse = [...trainPerSymbol.entries()].filter(([, r]) => r > 0).map(([s]) => s)
  console.log(`\nSelected universe: ${selectedUniverse.join(', ')} (${selectedUniverse.length}/${UNIVERSE_TOP10.length} symbols)\n`)

  // Step 2: симулировать full TRAIN на selected universe
  console.log('=== Step 2: TRAIN on selected universe ===')
  const trainSelSigs = buildSignals(selectedUniverse, fullStart, trainEnd)
  const trainSelTrades = buildTrades(trainSelSigs)
  const trainSelResult = simulate(trainSelTrades)
  printResult('TRAIN (selected universe)', trainSelResult)

  // Step 3: TEST на selected universe (out-of-sample!)
  console.log('\n=== Step 3: TEST on selected universe (out-of-sample) ===')
  const testSelSigs = buildSignals(selectedUniverse, trainEnd, now)
  const testSelTrades = buildTrades(testSelSigs)
  const testSelResult = simulate(testSelTrades)
  printResult('TEST (selected universe)', testSelResult)

  // Step 4: per-symbol на TEST (для проверки персистентности)
  console.log('\n=== Step 4: Per-symbol R on TEST (selected universe) ===')
  const testPerSymbol = computePerSymbolR(testSelTrades)
  for (const sym of selectedUniverse) {
    const trainR = trainPerSymbol.get(sym) ?? 0
    const testR = testPerSymbol.get(sym) ?? 0
    const persistent = testR > 0
    console.log(`  ${sym.padEnd(10)} | TRAIN R=${fmtR(trainR).padStart(7)} | TEST R=${fmtR(testR).padStart(7)} ${persistent ? '✓ persists' : '✗ flipped'}`)
  }

  // Step 5: FULL на selected universe
  console.log('\n=== Step 5: FULL period on selected universe ===')
  const fullSelSigs = buildSignals(selectedUniverse, fullStart, now)
  const fullSelTrades = buildTrades(fullSelSigs)
  const fullSelResult = simulate(fullSelTrades)
  printResult('FULL (selected universe)', fullSelResult)

  // Verdict
  const testRet = (testSelResult.finalDeposit / testSelResult.startingDeposit - 1) * 100
  const trainRet = (trainSelResult.finalDeposit / trainSelResult.startingDeposit - 1) * 100
  console.log('\n=== Verdict ===')
  console.log(`TRAIN selected: ${trainRet >= 0 ? '+' : ''}${trainRet.toFixed(0)}% | TEST selected: ${testRet >= 0 ? '+' : ''}${testRet.toFixed(0)}%`)
  if (trainRet > 0 && testRet > 0) {
    console.log(`✓ ROBUST: walk-forward universe selection works!`)
  } else if (testRet > 0) {
    console.log(`~ PARTIAL: TEST positive, TRAIN на selected mixed result`)
  } else {
    console.log(`✗ NOT ROBUST: TRAIN selection не предсказывает TEST — selection bias confirmed`)
  }

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `trend_macd_filtered_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'MACD+EMA200 walk-forward universe',
    selectedUniverse,
    trainPerSymbol: Object.fromEntries(trainPerSymbol),
    testPerSymbol: Object.fromEntries(testPerSymbol),
    trainResult: trainSelResult,
    testResult: testSelResult,
    fullResult: fullSelResult,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
