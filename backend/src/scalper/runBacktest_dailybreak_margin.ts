/**
 * Daily Breakout — portfolio simulator with margin guard verification.
 *
 * Сравнивает 3 sizing-режима на одном trade-pool'е (FULL / TRAIN / TEST):
 *   A. Baseline       — risk 2%, no margin guard, leverage = positionSize/deposit (current prod)
 *   B. Margin guard   — target margin 10%/trade, lev = min(positionSize/targetMargin, maxLev),
 *                       skip new если sumMargin > deposit (no auto-close)
 *   C. Margin + auto  — same as B, но при недостатке margin закрываем плюсовые позиции
 *                       (TP2_HIT > TP1_HIT > OPEN with unrealizedR>=0)
 *
 * Цель: проверить что margin guard НЕ убивает edge стратегии.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_margin.ts
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

const PROD_SYMBOLS = [
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
]

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

type Mode = 'baseline' | 'guard' | 'guardAuto'

interface SimResult {
  mode: Mode
  trades: number
  opened: number
  skipped: number
  autoClosed: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  maxDD: number
  winRate: number
}

function simulate(allTrades: PortfolioTrade[], mode: Mode, deposit: number): SimResult {
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
  let opened = 0, skipped = 0, autoClosed = 0, fullyClosed: PortfolioTrade[] = []
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

  function getMaxLeverageMode(): number {
    return mode === 'baseline' ? 100 : 75 // not used for baseline; baseline uses size/deposit
  }

  for (const ev of eventQueue) {
    realizeFillsUntil(ev.time)
    if (ev.type !== 'open') continue
    const pt = sorted[ev.tradeIdx!]
    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skipped++; continue }

    if (mode === 'baseline') {
      // Risk 2%, position computed risk/sl-dist; leverage so margin = full deposit
      // (matches current prod pre-fix). Don't track margin constraints — every trade opens.
      const riskUsd = (currentDeposit * RISK_PCT) / 100
      const positionUnits = riskUsd / slDist
      const positionSizeUsd = pt.entryPrice * positionUnits
      const leverage = Math.max(1, Math.min(100, positionSizeUsd / Math.max(currentDeposit, 1e-9)))
      active.push({
        pt, id: nextId++, positionSizeUsd, leverage, marginUsd: positionSizeUsd / leverage,
        fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0, riskUsd,
      })
      opened++
    } else {
      const sizing = computeSizing({
        symbol: pt.symbol, deposit: currentDeposit,
        riskPct: RISK_PCT, targetMarginPct: TARGET_MARGIN_PCT,
        entry: pt.entryPrice, sl: pt.sl,
      })
      if (!sizing) { skipped++; continue }

      // Build ExistingTrade list from active
      const existing: ExistingTrade[] = active.map(a => ({
        id: a.id, symbol: a.pt.symbol, status: a.statusKey,
        positionSizeUsd: a.positionSizeUsd,
        closedFrac: a.closedFracPct / 100,
        leverage: a.leverage,
        unrealizedR: a.realizedR, // approximation — at open-event time we don't have intraday MTM
        hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
        hasTP2: a.statusKey === 'TP2_HIT',
      }))

      const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)

      if (!guard.canOpen) {
        skipped++
        continue
      }

      if (guard.toClose.length > 0) {
        if (mode === 'guard') { skipped++; continue } // no auto-close in this mode
        // mode === 'guardAuto': close listed trades at current entry's time as proxy market price
        // We don't have intraday MTM so we just realize remaining R as if closed at last known fill (worst case = 0R for OPEN).
        // For TP1_HIT/TP2_HIT trades, SL trail means remaining is at BE/TP1, so closing realizes ~0 / +1R respectively.
        for (const tid of guard.toClose) {
          const idx = active.findIndex(a => a.id === tid)
          if (idx < 0) continue
          const a = active[idx]
          // Estimate close R: if status TP2_HIT, assume close at TP1 (=+1R remaining); if TP1_HIT, assume BE (0R remaining); else 0R.
          const remainFrac = (100 - a.closedFracPct) / 100
          let closeR = 0
          if (a.statusKey === 'TP2_HIT') closeR = 1.0 * remainFrac
          else if (a.statusKey === 'TP1_HIT') closeR = 0
          else closeR = 0 // OPEN with unrealized>=0 — we conservatively assume 0R
          const pnlUsd = closeR * a.riskUsd
          currentDeposit += pnlUsd
          a.realizedR += closeR
          a.closedFracPct = 100
          if (a.realizedR > 0) wins++
          totalR += a.realizedR
          fullyClosed.push(a.pt)
          active.splice(idx, 1)
          autoClosed++
          applyEvent(ev.time)
        }
      }

      active.push({
        pt, id: nextId++,
        positionSizeUsd: sizing.positionSizeUsd,
        leverage: sizing.leverage,
        marginUsd: sizing.marginUsd,
        fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
        riskUsd: sizing.riskUsd,
      })
      opened++
    }
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
    mode, trades: fullyClosed.length, opened, skipped, autoClosed,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtPct(p: number): string { return (p >= 0 ? '+' : '') + p.toFixed(1) + '%' }

async function main() {
  console.log('Daily Breakout — margin guard verification (portfolio simulator)')
  console.log(`Symbols: ${PROD_SYMBOLS.length} | Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | Target margin ${TARGET_MARGIN_PCT}%`)
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
    console.log('Mode        | trades | opened | skipped | auto-closed | totalR  | R/tr  | finalDepo | peak    | maxDD  | WR')
    console.log('-'.repeat(115))
    for (const mode of ['baseline', 'guard', 'guardAuto'] as const) {
      const r = simulate(pool, mode, STARTING_DEPOSIT)
      console.log(`${mode.padEnd(11)} | ${r.trades.toString().padStart(6)} | ${r.opened.toString().padStart(6)} | ${r.skipped.toString().padStart(7)} | ${r.autoClosed.toString().padStart(11)} | ${fmtR(r.totalR).padStart(7)} | ${fmtR(r.rPerTr).padStart(5)} | $${r.finalDeposit.toFixed(0).padStart(8)} | $${r.peakDeposit.toFixed(0).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)}% | ${r.winRate.toFixed(0)}%`)
    }
    console.log()
  }

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
