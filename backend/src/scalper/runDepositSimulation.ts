/**
 * Deposit simulation for the Levels strategy.
 *
 * Replays real backtest trades chronologically with:
 *   - configurable starting deposit
 *   - configurable risk per trade (% of CURRENT deposit, compounding)
 *   - daily / weekly loss circuit breakers
 *   - max concurrent open positions
 *   - max positions per instrument
 *
 * Output: equity curve, monthly P&L, max drawdown, days-to-2x, days-to-ruin.
 */

import * as fs from 'fs'
import * as path from 'path'
import 'dotenv/config'
import { loadForexHistorical } from './forexLoader'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const RESULTS_DIR = path.join(__dirname, '../../data/backtest')
const DAYS_BACK = 90 // 3 months
interface SetupConfig {
  symbol: string
  market: 'FOREX' | 'CRYPTO'
  side: 'BUY' | 'SELL' | 'BOTH'
}
// === New production setups (post-diagnostics 2026-05-05) ===
// Removed: GBPUSD (-6R), ETH SHORT (-58R), SOL SHORT (-54R) — regime change
const PROD_SETUPS: SetupConfig[] = [
  { symbol: 'XAUUSD',  market: 'FOREX',  side: 'BUY' },
  { symbol: 'EURUSD',  market: 'FOREX',  side: 'BUY' },
  { symbol: 'BTCUSDT', market: 'CRYPTO', side: 'BOTH' },
]

function sliceLastDays<T extends { time: number }>(arr: T[], days: number, bufferDays = 60): T[] {
  const cutoff = Date.now() - (days + bufferDays) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function buildCfg(): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
  }
}

interface ExecutedTrade {
  symbol: string
  market: 'FOREX' | 'CRYPTO'
  entryTime: number
  exitTime: number
  side: 'BUY' | 'SELL'
  pnlR: number
}

async function collectTradesForSymbol(setup: SetupConfig): Promise<ExecutedTrade[]> {
  const m5  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '5m', 4) : loadHistorical(setup.symbol, '5m', 4, 'bybit', 'linear'))
  const m15 = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '15m', 4) : loadHistorical(setup.symbol, '15m', 4, 'bybit', 'linear'))
  const h1  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '1h', 4) : loadHistorical(setup.symbol, '1h', 4, 'bybit', 'linear'))
  const d1  = await (setup.market === 'FOREX' ? loadForexHistorical(setup.symbol, '1d', 4) : loadHistorical(setup.symbol, '1d', 4, 'bybit', 'linear'))

  const ltf = sliceLastDays(m5, DAYS_BACK, 60)
  const mtf = sliceLastDays(m15, DAYS_BACK, 60)
  const htf = sliceLastDays(h1, DAYS_BACK, 60)
  const dly = sliceLastDays(d1, DAYS_BACK, 60)
  const w1 = aggregateDailyToWeekly(dly)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const cfg = buildCfg()
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()

  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (setup.side !== 'BOTH' && s.side !== setup.side) continue
    sigByIdx.set(i, {
      side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
    })
  }

  // Production exit: read from environment variable EXIT_MODE
  // EXIT_MODE=TP1: 100% on TP1
  // EXIT_MODE=TP2: 100% on TP2 (default)
  // EXIT_MODE=LADDER: original 50/30/20 + trailing
  const exitMode = process.env.EXIT_MODE ?? 'TP2'
  let ladderCfg: LadderConfig
  if (exitMode === 'TP1') {
    ladderCfg = { ...DEFAULT_LADDER, exitMode: 'wick', singleTpIdx: 0, splits: [1.0, 0, 0], trailing: false,
      feesRoundTrip: setup.market === 'FOREX' ? 0.0004 : 0.0008 }
  } else if (exitMode === 'LADDER') {
    ladderCfg = { ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2], trailing: true,
      feesRoundTrip: setup.market === 'FOREX' ? 0.0004 : 0.0008 }
  } else {
    ladderCfg = { ...DEFAULT_LADDER, exitMode: 'wick', singleTpIdx: 1, splits: [0, 1.0, 0], trailing: false,
      feesRoundTrip: setup.market === 'FOREX' ? 0.0004 : 0.0008 }
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)

  return r.trades.map<ExecutedTrade>((t: LadderTrade) => ({
    symbol: setup.symbol,
    market: setup.market,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    side: t.side,
    pnlR: t.pnlR,
  }))
}

interface SimConfig {
  startingDeposit: number
  riskPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  dailyLossPct: number       // pause for the day if hit
  weeklyLossPct: number      // pause for the week
  pauseAfterConsecSL: number // pause N hours after this many losses in a row
  pauseHours: number
}

interface SimResult {
  config: SimConfig
  finalDeposit: number
  totalTrades: number
  acceptedTrades: number
  skippedTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnL: number
  totalPnLPct: number
  maxDrawdownAbs: number
  maxDrawdownPct: number
  daysToDouble: number | null
  daysToHalf: number | null
  monthlyReturns: { month: string; pnl: number; trades: number; depositAtEnd: number }[]
  reachedDouble: boolean
  reachedRuin: boolean
  equityCurve: { time: number; equity: number }[]
}

function runSim(allTrades: ExecutedTrade[], cfg: SimConfig): SimResult {
  // Order trades by entry time
  const trades = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)

  let deposit = cfg.startingDeposit
  let peak = deposit
  let maxDDAbs = 0
  let maxDDPct = 0
  let acceptedTrades = 0
  let wins = 0, losses = 0
  let totalPnL = 0
  const equityCurve: { time: number; equity: number }[] = [{ time: trades[0]?.entryTime ?? Date.now(), equity: deposit }]
  const monthlyMap = new Map<string, { pnl: number; trades: number }>()
  const startTime = trades[0]?.entryTime ?? Date.now()
  let daysToDouble: number | null = null
  let daysToHalf: number | null = null
  let reachedDouble = false
  let reachedRuin = false

  // Open position tracking
  type OpenPos = { exitTime: number; symbol: string; pnlR: number }
  let openPositions: OpenPos[] = []

  // Circuit breakers
  let dailyLossDate = ''
  let dailyLossDeposit = deposit
  let weeklyLossWeek = ''
  let weeklyLossDeposit = deposit
  let dailyPaused = false
  let weeklyPaused = false
  let pauseUntilTime = 0
  let consecLosses = 0

  function dateKey(t: number): string {
    return new Date(t).toISOString().slice(0, 10)
  }
  function weekKey(t: number): string {
    const d = new Date(t)
    const dow = d.getUTCDay()
    const monMs = d.getTime() - ((dow + 6) % 7) * 86400_000
    return new Date(monMs).toISOString().slice(0, 10)
  }
  function monthKey(t: number): string {
    return new Date(t).toISOString().slice(0, 7)
  }

  let skippedReasons: Record<string, number> = {}

  for (const trade of trades) {
    if (deposit <= cfg.startingDeposit * 0.05) {
      reachedRuin = true
      break // stop-out — depo dead
    }

    // Close out finished positions
    openPositions = openPositions.filter((p) => p.exitTime > trade.entryTime)

    // Daily reset
    const today = dateKey(trade.entryTime)
    if (today !== dailyLossDate) {
      dailyLossDate = today
      dailyLossDeposit = deposit
      dailyPaused = false
    }
    const week = weekKey(trade.entryTime)
    if (week !== weeklyLossWeek) {
      weeklyLossWeek = week
      weeklyLossDeposit = deposit
      weeklyPaused = false
    }

    // Skip checks
    if (dailyPaused) { skippedReasons.daily = (skippedReasons.daily ?? 0) + 1; continue }
    if (weeklyPaused) { skippedReasons.weekly = (skippedReasons.weekly ?? 0) + 1; continue }
    if (trade.entryTime < pauseUntilTime) { skippedReasons.consecPause = (skippedReasons.consecPause ?? 0) + 1; continue }
    if (openPositions.length >= cfg.maxConcurrentPositions) {
      skippedReasons.maxConcurrent = (skippedReasons.maxConcurrent ?? 0) + 1
      continue
    }
    const samSymOpen = openPositions.filter((p) => p.symbol === trade.symbol).length
    if (samSymOpen >= cfg.maxPositionsPerSymbol) {
      skippedReasons.maxPerSymbol = (skippedReasons.maxPerSymbol ?? 0) + 1
      continue
    }

    // Take the trade
    const riskAmount = deposit * (cfg.riskPct / 100)
    const dollarPnL = riskAmount * trade.pnlR
    deposit += dollarPnL
    totalPnL += dollarPnL
    acceptedTrades++
    if (trade.pnlR > 0) { wins++; consecLosses = 0 }
    else if (trade.pnlR < 0) { losses++; consecLosses++ }

    // Track for daily/weekly stop
    const dayLossPct = ((deposit - dailyLossDeposit) / dailyLossDeposit) * 100
    if (dayLossPct < -cfg.dailyLossPct) dailyPaused = true
    const weekLossPct = ((deposit - weeklyLossDeposit) / weeklyLossDeposit) * 100
    if (weekLossPct < -cfg.weeklyLossPct) weeklyPaused = true

    if (consecLosses >= cfg.pauseAfterConsecSL) {
      pauseUntilTime = trade.entryTime + cfg.pauseHours * 3600_000
      consecLosses = 0
    }

    // Equity & DD
    if (deposit > peak) peak = deposit
    const ddAbs = peak - deposit
    const ddPct = (ddAbs / peak) * 100
    if (ddAbs > maxDDAbs) maxDDAbs = ddAbs
    if (ddPct > maxDDPct) maxDDPct = ddPct

    equityCurve.push({ time: trade.exitTime, equity: deposit })

    // Track open position
    openPositions.push({ exitTime: trade.exitTime, symbol: trade.symbol, pnlR: trade.pnlR })

    // Monthly bucket
    const mk = monthKey(trade.entryTime)
    const m = monthlyMap.get(mk) ?? { pnl: 0, trades: 0 }
    m.pnl += dollarPnL
    m.trades++
    monthlyMap.set(mk, m)

    // 2x and 0.5x marks
    if (!reachedDouble && deposit >= cfg.startingDeposit * 2) {
      reachedDouble = true
      daysToDouble = (trade.entryTime - startTime) / 86400_000
    }
    if (daysToHalf === null && deposit <= cfg.startingDeposit * 0.5) {
      daysToHalf = (trade.entryTime - startTime) / 86400_000
    }
  }

  const monthlyReturns: SimResult['monthlyReturns'] = []
  let runningDeposit = cfg.startingDeposit
  for (const [mk, v] of [...monthlyMap.entries()].sort()) {
    runningDeposit += v.pnl
    monthlyReturns.push({ month: mk, pnl: v.pnl, trades: v.trades, depositAtEnd: runningDeposit })
  }

  return {
    config: cfg,
    finalDeposit: deposit,
    totalTrades: trades.length,
    acceptedTrades,
    skippedTrades: trades.length - acceptedTrades,
    wins, losses,
    winRate: acceptedTrades > 0 ? wins / acceptedTrades : 0,
    totalPnL,
    totalPnLPct: ((deposit - cfg.startingDeposit) / cfg.startingDeposit) * 100,
    maxDrawdownAbs: maxDDAbs,
    maxDrawdownPct: maxDDPct,
    daysToDouble, daysToHalf,
    monthlyReturns,
    reachedDouble, reachedRuin,
    equityCurve,
  }
}

async function main() {
  console.log(`\n=== Collecting trades for last ${DAYS_BACK} days ===\n`)
  const allTrades: ExecutedTrade[] = []
  for (const setup of PROD_SETUPS) {
    try {
      const t = await collectTradesForSymbol(setup)
      console.log(`${setup.symbol}: ${t.length} trades`)
      allTrades.push(...t)
    } catch (e: any) {
      console.warn(`${setup.symbol} failed: ${e.message}`)
    }
  }
  console.log(`\nTotal trades pool: ${allTrades.length}`)
  if (allTrades.length === 0) {
    console.error('No trades — aborting')
    return
  }

  // === Sweep risk profiles for $500 deposit ===
  const profiles: SimConfig[] = [
    { startingDeposit: 500, riskPct: 0.5, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 1.0, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 1.5, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 2.0, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 2.5, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 3.0, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 5.0, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
    { startingDeposit: 500, riskPct: 10.0, maxConcurrentPositions: 2, maxPositionsPerSymbol: 1, dailyLossPct: 5, weeklyLossPct: 15, pauseAfterConsecSL: 3, pauseHours: 4 },
  ]

  console.log(`\n=== Simulating $500 deposit, ${DAYS_BACK} days, with circuit breakers ===\n`)
  const results = profiles.map((p) => runSim(allTrades, p))

  console.log(`\n=== RESULTS ===\n`)
  console.log(`Risk%   Final$  Return%  MaxDD%  Wins/Loss  WR    Trades  2x?     Ruin?`)
  console.log(`────────────────────────────────────────────────────────────────────────`)
  for (const r of results) {
    const arrow = r.reachedDouble ? '✓' : r.reachedRuin ? '💀' : '·'
    console.log(
      `${r.config.riskPct.toString().padStart(5)}%  ` +
      `$${r.finalDeposit.toFixed(0).padStart(5)}  ` +
      `${(r.totalPnLPct >= 0 ? '+' : '')}${r.totalPnLPct.toFixed(0).padStart(5)}%  ` +
      `${r.maxDrawdownPct.toFixed(1).padStart(5)}%  ` +
      `${r.wins.toString().padStart(3)}/${r.losses.toString().padEnd(3)}  ` +
      `${(r.winRate * 100).toFixed(0).padStart(3)}%  ` +
      `${r.acceptedTrades.toString().padStart(4)}    ` +
      `${arrow} ${r.daysToDouble !== null ? r.daysToDouble.toFixed(0) + 'd' : '—'.padStart(4)}  ` +
      `${r.reachedRuin ? 'YES' : '—'}`
    )
  }

  console.log(`\n=== MONTHLY BREAKDOWN (best risk profile) ===\n`)
  // Pick best non-ruin result by final deposit
  const best = [...results].filter((r) => !r.reachedRuin).sort((a, b) => b.finalDeposit - a.finalDeposit)[0]
  if (best) {
    console.log(`Profile: ${best.config.riskPct}% risk, depo $${best.config.startingDeposit} → $${best.finalDeposit.toFixed(0)}\n`)
    for (const m of best.monthlyReturns) {
      const sign = m.pnl >= 0 ? '+' : ''
      console.log(`${m.month}: ${sign}$${m.pnl.toFixed(0).padStart(5)} (${m.trades} trades)  → depo end $${m.depositAtEnd.toFixed(0)}`)
    }
  }

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const outFile = path.join(RESULTS_DIR, `deposit_simulation_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ daysBack: DAYS_BACK, results: results.map((r) => ({ ...r, equityCurve: undefined })) }, null, 2))
  console.log(`\nResults saved → ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
