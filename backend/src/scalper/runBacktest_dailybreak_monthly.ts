/**
 * Daily Breakout — month-by-month comparison: A (10 conc, 10% margin)
 * vs B (20 conc, 5% margin) on the refreshed 23-symbol clean universe.
 *
 * Run: npx tsx src/scalper/runBacktest_dailybreak_monthly.ts
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
const SLIPPAGE = 0.0005

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
  { name: 'A: 10 conc 10% margin', maxConcurrent: 10, targetMarginPct: 10 },
  { name: 'B: 20 conc 5% margin', maxConcurrent: 20, targetMarginPct: 5 },
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

interface MonthRow {
  ym: string                       // 'YYYY-MM' from entryTime
  trades: number                   // closed (entered) in this month
  totalR: number                   // sum of fill pnlR within this month
  pnlUsd: number                   // sum of fill pnlUsd within this month
  wins: number                     // trades whose realized R sum > 0
  startDepo: number                // deposit at start of month
  endDepo: number                  // deposit at end of month
  minDepoInMonth: number           // absolute lowest deposit value reached during month
  maxDDinMonth: number             // intra-month DD%
}

interface SimResult {
  scenario: string
  trades: number
  totalR: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number               // absolute lowest deposit value over entire run
  maxDD: number
  winRate: number
  monthly: MonthRow[]
}

function ymOf(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`
}

function simulate(allTrades: PortfolioTrade[], scenario: Scenario, deposit: number): SimResult {
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
    entryYm: string
  }
  const active: Active[] = []
  let nextId = 1
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0

  // Monthly aggregation: keyed by entryYm of the trade — credit P&L of the trade to its entry month.
  const monthMap = new Map<string, { trades: Set<number>; totalR: number; pnlUsd: number; winners: Set<number> }>()
  // Equity curve by month (deposit at end of month, max DD seen during month).
  const monthEquity = new Map<string, { startDepo: number; endDepo: number; minDepoInMonth: number; maxDDinMonth: number; peakSoFar: number }>()
  let lastKnownYm: string | null = null
  let minDeposit = currentDeposit

  function ensureMonth(ym: string) {
    if (!monthMap.has(ym)) monthMap.set(ym, { trades: new Set(), totalR: 0, pnlUsd: 0, winners: new Set() })
    if (!monthEquity.has(ym)) {
      const startDepo = lastKnownYm ? (monthEquity.get(lastKnownYm)!.endDepo) : currentDeposit
      monthEquity.set(ym, { startDepo, endDepo: startDepo, minDepoInMonth: startDepo, maxDDinMonth: 0, peakSoFar: peak })
    }
    lastKnownYm = ym
  }

  function applyEvent(time: number) {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < minDeposit) minDeposit = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
    const ym = ymOf(time)
    ensureMonth(ym)
    const me = monthEquity.get(ym)!
    me.endDepo = currentDeposit
    if (currentDeposit > me.peakSoFar) me.peakSoFar = currentDeposit
    if (currentDeposit < me.minDepoInMonth) me.minDepoInMonth = currentDeposit
    const ddInMonth = ((me.peakSoFar - currentDeposit) / me.peakSoFar) * 100
    if (ddInMonth > me.maxDDinMonth) me.maxDDinMonth = ddInMonth
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
        // Credit fill P&L to the trade's entry month
        const m = monthMap.get(a.entryYm)
        if (m) { m.totalR += f.pricePnlR; m.pnlUsd += pnlUsd }
        applyEvent(f.time)
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) {
          wins++
          const m = monthMap.get(a.entryYm)
          if (m) m.winners.add(a.id)
        }
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

    const ym = ymOf(pt.entryTime)
    ensureMonth(ym)
    const id = nextId++
    monthMap.get(ym)!.trades.add(id)
    active.push({
      pt, id,
      positionSizeUsd: sizing.positionSizeUsd,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      entryYm: ym,
    })
    applyEvent(ev.time)
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) {
      wins++
      const m = monthMap.get(a.entryYm)
      if (m) m.winners.add(a.id)
    }
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  // Build monthly breakdown sorted by ym
  const monthly: MonthRow[] = [...monthMap.keys()].sort().map(ym => {
    const m = monthMap.get(ym)!
    const eq = monthEquity.get(ym)!
    return {
      ym,
      trades: m.trades.size,
      totalR: m.totalR,
      pnlUsd: m.pnlUsd,
      wins: m.winners.size,
      startDepo: eq.startDepo,
      endDepo: eq.endDepo,
      minDepoInMonth: eq.minDepoInMonth,
      maxDDinMonth: eq.maxDDinMonth,
    }
  })

  return {
    scenario: scenario.name,
    trades: fullyClosed.length,
    totalR,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    monthly,
  }
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(u: number): string { return (u >= 0 ? '+$' : '-$') + Math.abs(u).toFixed(0) }
function fmtPct(p: number): string { return p.toFixed(1) + '%' }
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length) }
function rpad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s }

async function main() {
  console.log('Daily Breakout — monthly breakdown A vs B (refreshed 23-symbol universe, 365d)')
  console.log(`Symbols (${SYMBOLS.length}): ${SYMBOLS.join(', ')}`)
  console.log(`Deposit $${STARTING_DEPOSIT} | Risk ${RISK_PCT}% | fees 0.08% RT | slip 0.05%/side`)
  console.log()

  const allTrades: PortfolioTrade[] = []
  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const now = Date.now()

  for (const sym of SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    const cfg: BreakoutCfg = { rangeBars: RANGE_BARS, volMultiplier: VOL_MULT, tp1Mult: TP_MULTS[0], tp2Mult: TP_MULTS[1], tp3Mult: TP_MULTS[2] }
    runOne(m5, cfg, fullStart, now).forEach(t => allTrades.push(toPortfolioTrade(sym, t)))
  }

  console.log(`Trade pool: ${allTrades.length} signals`)
  console.log()

  const results: SimResult[] = SCENARIOS.map(sc => simulate(allTrades, sc, STARTING_DEPOSIT))

  // Print summary first
  console.log('=== Summary ===')
  console.log(pad('Scenario', 24) + ' | trades | totalR  | R/tr  | finalDepo | peak     | MIN_DEPO | maxDD  | WR')
  console.log('-'.repeat(108))
  for (const r of results) {
    console.log(
      pad(r.scenario, 24) + ' | ' +
      rpad(r.trades.toString(), 6) + ' | ' +
      rpad(fmtR(r.totalR), 7) + ' | ' +
      rpad(fmtR(r.totalR / Math.max(1, r.trades)), 5) + ' | $' +
      rpad(r.finalDeposit.toFixed(0), 8) + ' | $' +
      rpad(r.peakDeposit.toFixed(0), 7) + ' | $' +
      rpad(r.minDeposit.toFixed(0), 7) + ' | ' +
      rpad(r.maxDD.toFixed(1) + '%', 6) + ' | ' +
      r.winRate.toFixed(0) + '%'
    )
  }
  console.log()

  // Build a unified set of months from both runs
  const allMonths = new Set<string>()
  for (const r of results) for (const m of r.monthly) allMonths.add(m.ym)
  const months = [...allMonths].sort()

  // Side-by-side monthly table
  console.log('=== Monthly breakdown ===')
  console.log()
  console.log(
    pad('Month', 8) + ' | ' +
    pad('A.N', 5) + ' ' + pad('A.PnL$', 10) + ' ' + pad('A.endDepo', 11) + ' ' + pad('A.MIN', 10) + ' ' + pad('A.DDmth', 7) + ' || ' +
    pad('B.N', 5) + ' ' + pad('B.PnL$', 10) + ' ' + pad('B.endDepo', 11) + ' ' + pad('B.MIN', 10) + ' ' + pad('B.DDmth', 7)
  )
  console.log('-'.repeat(140))

  let aWinMonths = 0, bWinMonths = 0
  for (const ym of months) {
    const aRow = results[0].monthly.find(m => m.ym === ym)
    const bRow = results[1].monthly.find(m => m.ym === ym)
    const aN = aRow?.trades ?? 0
    const bN = bRow?.trades ?? 0
    const aRpt = aRow && aN > 0 ? aRow.totalR / aN : 0
    const bRpt = bRow && bN > 0 ? bRow.totalR / bN : 0
    const aP = aRow?.pnlUsd ?? 0
    const bP = bRow?.pnlUsd ?? 0
    if (aP > 0) aWinMonths++
    if (bP > 0) bWinMonths++
    const aWR = aRow && aN > 0 ? (aRow.wins / aN) * 100 : 0
    const bWR = bRow && bN > 0 ? (bRow.wins / bN) * 100 : 0
    console.log(
      pad(ym, 8) + ' | ' +
      pad(aN.toString(), 5) + ' ' + pad(fmtUsd(aP), 10) + ' ' + pad('$' + (aRow?.endDepo ?? 0).toFixed(0), 11) + ' ' + pad('$' + (aRow?.minDepoInMonth ?? 0).toFixed(0), 10) + ' ' + pad(fmtPct(aRow?.maxDDinMonth ?? 0), 7) + ' || ' +
      pad(bN.toString(), 5) + ' ' + pad(fmtUsd(bP), 10) + ' ' + pad('$' + (bRow?.endDepo ?? 0).toFixed(0), 11) + ' ' + pad('$' + (bRow?.minDepoInMonth ?? 0).toFixed(0), 10) + ' ' + pad(fmtPct(bRow?.maxDDinMonth ?? 0), 7)
    )
  }
  console.log('-'.repeat(140))
  console.log(`Profitable months: A = ${aWinMonths}/${months.length}  B = ${bWinMonths}/${months.length}`)
  console.log()
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
