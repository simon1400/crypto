/**
 * Phase 3: Walk-forward backtest of the Scanner module.
 *
 * Loop:
 *   for each timestamp T in [windowStart, windowEnd] step 12 minutes:
 *     1. Build BTC regime at T
 *     2. For each of 30 symbols: score → if signal, queue trade
 *     3. Dedupe: same (coin, type) within 2h is one trade (matches live alert TTL)
 *     4. Simulate each accepted trade against future 5m candles
 *
 * Outputs:
 *   - data/backtest/scanner_wf_<timestamp>.json — full trade list + metrics
 *   - console summary with breakdowns
 *
 * Usage:
 *   cd backend && npx tsx src/scalper/scannerBacktest/runWalkforward.ts [days]
 *   default days=365, default minScore=70 (matches autoScanner default)
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadHistorical } from '../historicalLoader'
import { loadFundingHistory, fundingAt, FundingPoint } from '../fundingLoader'
import {
  SymbolHistoricalData,
  buildBtcRegime,
  buildSnapshot,
  scoreSymbolAt,
} from './historicalScannerEngine'
import { TradeResult, simulateTrade } from './tradeSimulator'
import { EnrichedSignal } from '../../scanner/scoring/index'

const TOP30_FILE = path.join(__dirname, '../../../data/backtest/scanner_top30.json')
const OUT_DIR = path.join(__dirname, '../../../data/backtest')

const STEP_MINUTES = 12 // matches autoScanner default
const STEP_MS = STEP_MINUTES * 60_000
const DEDUPE_WINDOW_MS = 2 * 3600_000 // 2h — matches autoScanner ALERT_TTL_MS

interface SymbolEntry {
  symbol: string
  firstCandleDate: string
  candle4hCount: number
}

interface SymbolBundle {
  symbol: string
  data: SymbolHistoricalData
  fundingHistory: FundingPoint[]
}

async function loadAll(symbols: string[], days: number): Promise<Map<string, SymbolBundle>> {
  const months = Math.ceil(days / 30) + 2 // buffer for warm-up
  const bundles = new Map<string, SymbolBundle>()
  console.log(`[WF] Loading ${symbols.length} symbols × 4 TFs + funding...`)
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]
    process.stdout.write(`  [${i + 1}/${symbols.length}] ${sym}... `)
    const t0 = Date.now()
    const [c5, c15, c1h, c4h, funding] = await Promise.all([
      loadHistorical(sym, '5m', months, 'bybit', 'linear'),
      loadHistorical(sym, '15m', months, 'bybit', 'linear'),
      loadHistorical(sym, '1h', months, 'bybit', 'linear'),
      loadHistorical(sym, '4h', months, 'bybit', 'linear'),
      loadFundingHistory(sym, days + 30),
    ])
    bundles.set(sym, {
      symbol: sym,
      data: { candles5m: c5, candles15m: c15, candles1h: c1h, candles4h: c4h },
      fundingHistory: funding,
    })
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s — 5m=${c5.length}, 15m=${c15.length}, 1h=${c1h.length}, 4h=${c4h.length}, funding=${funding.length}`)
  }
  return bundles
}

interface WfMetrics {
  totalSignals: number
  totalTrades: number
  wins: number  // trades with realizedR > 0
  losses: number // trades with realizedR <= 0
  totalR: number
  avgR: number
  winRate: number
  byStrategy: Record<string, { trades: number; wins: number; totalR: number; avgR: number; winRate: number }>
  bySetupCategory: Record<string, { trades: number; wins: number; totalR: number; avgR: number; winRate: number }>
  byExecutionType: Record<string, { trades: number; wins: number; totalR: number; avgR: number; winRate: number }>
  byScoreBand: Record<string, { trades: number; wins: number; totalR: number; avgR: number; winRate: number }>
  byType: Record<string, { trades: number; wins: number; totalR: number; avgR: number; winRate: number }>
  byExitReason: Record<string, number>
}

function emptyBucket() { return { trades: 0, wins: 0, totalR: 0, avgR: 0, winRate: 0 } }

function scoreBand(score: number): string {
  if (score >= 80) return '80-100'
  if (score >= 70) return '70-79'
  if (score >= 60) return '60-69'
  return '<60'
}

function aggregate(trades: TradeResult[], totalSignals: number): WfMetrics {
  const m: WfMetrics = {
    totalSignals,
    totalTrades: trades.length,
    wins: 0, losses: 0, totalR: 0, avgR: 0, winRate: 0,
    byStrategy: {}, bySetupCategory: {}, byExecutionType: {},
    byScoreBand: {}, byType: {}, byExitReason: {},
  }
  for (const t of trades) {
    if (t.realizedR > 0) m.wins++; else m.losses++
    m.totalR += t.realizedR

    const buckets: [Record<string, ReturnType<typeof emptyBucket>>, string][] = [
      [m.byStrategy, t.strategy],
      [m.bySetupCategory, t.setupCategory],
      [m.byExecutionType, t.executionType],
      [m.byScoreBand, scoreBand(t.setupScore)],
      [m.byType, t.type],
    ]
    for (const [bucket, key] of buckets) {
      if (!bucket[key]) bucket[key] = emptyBucket()
      bucket[key].trades++
      bucket[key].totalR += t.realizedR
      if (t.realizedR > 0) bucket[key].wins++
    }
    m.byExitReason[t.exitReason] = (m.byExitReason[t.exitReason] || 0) + 1
  }
  m.avgR = m.totalTrades > 0 ? m.totalR / m.totalTrades : 0
  m.winRate = m.totalTrades > 0 ? m.wins / m.totalTrades : 0
  for (const bucket of [m.byStrategy, m.bySetupCategory, m.byExecutionType, m.byScoreBand, m.byType]) {
    for (const k of Object.keys(bucket)) {
      const b = bucket[k]
      b.avgR = b.trades > 0 ? b.totalR / b.trades : 0
      b.winRate = b.trades > 0 ? b.wins / b.trades : 0
    }
  }
  return m
}

function formatBucket(label: string, bucket: Record<string, ReturnType<typeof emptyBucket>>): void {
  console.log(`\n  By ${label}:`)
  const keys = Object.keys(bucket).sort((a, b) => bucket[b].totalR - bucket[a].totalR)
  for (const k of keys) {
    const b = bucket[k]
    console.log(`    ${k.padEnd(28)} trades=${String(b.trades).padStart(4)} WR=${(b.winRate * 100).toFixed(0).padStart(3)}% totalR=${b.totalR.toFixed(2).padStart(7)} avgR=${b.avgR.toFixed(3)}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const days = args[0] ? parseInt(args[0], 10) : 365
  const minScoreArg = args.find(a => a.startsWith('--minScore='))
  const minScore = minScoreArg ? parseInt(minScoreArg.split('=')[1], 10) : 70

  console.log(`[WF] Scanner walk-forward backtest`)
  console.log(`[WF] Period: last ${days} days`)
  console.log(`[WF] Step: ${STEP_MINUTES}min`)
  console.log(`[WF] Min score: ${minScore}`)
  console.log()

  if (!fs.existsSync(TOP30_FILE)) throw new Error(`Run selectTopSymbols.ts first`)
  const top30 = JSON.parse(fs.readFileSync(TOP30_FILE, 'utf-8'))
  const symbols: string[] = top30.symbols.map((s: SymbolEntry) => s.symbol)
  if (!symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT') // BTC needed for regime

  const bundles = await loadAll(symbols, days)
  console.log()

  const btcBundle = bundles.get('BTCUSDT')!

  // Window: from "now - days" to "now - 1h" (avoid incomplete current candles)
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - days * 24 * 3600_000

  console.log(`[WF] Window: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`)
  const totalSteps = Math.floor((windowEnd - windowStart) / STEP_MS)
  console.log(`[WF] Total steps: ${totalSteps}\n`)

  const trades: TradeResult[] = []
  let totalSignals = 0
  let stepsProcessed = 0
  let lastReportedPct = -1

  // Dedupe map: key = `${coin}|${type}`, value = entryTime
  const lastEntryByKey = new Map<string, number>()

  const t0 = Date.now()
  for (let T = windowStart; T <= windowEnd; T += STEP_MS) {
    stepsProcessed++

    // Progress reporting every ~5%
    const pct = Math.floor((stepsProcessed / totalSteps) * 100)
    if (pct >= lastReportedPct + 5) {
      const elapsed = (Date.now() - t0) / 1000
      const eta = elapsed / stepsProcessed * (totalSteps - stepsProcessed)
      console.log(
        `[WF] ${pct}% — step ${stepsProcessed}/${totalSteps}, ${trades.length} trades, ${totalSignals} signals — elapsed ${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s`,
      )
      lastReportedPct = pct
    }

    // Build BTC regime once per step
    const btcSnapshot = buildSnapshot(btcBundle.data, T)
    if (!btcSnapshot) continue
    const regime = buildBtcRegime(btcBundle.data, T)

    // Score every symbol
    for (const sym of symbols) {
      const bundle = bundles.get(sym)
      if (!bundle) continue
      const fundingFn = (timeMs: number) => fundingAt(bundle.fundingHistory, timeMs)

      let enriched: EnrichedSignal | null
      try {
        enriched = scoreSymbolAt(sym.replace(/USDT$/, ''), bundle.data, T, {
          regime,
          btcSnapshot,
          fundingAt: fundingFn,
        })
      } catch {
        continue
      }
      if (!enriched) continue
      if (!enriched.hard_filter.passed) continue
      if (enriched.category === 'IGNORE') continue
      if (enriched.setup_score < minScore) continue
      // Match live behavior: only ENTER_NOW signals are immediately tradeable in backtest
      // (LIMIT and WAIT_* require subsequent price action — out of scope for v1)
      if (enriched.execution_type !== 'ENTER_NOW_LONG' && enriched.execution_type !== 'ENTER_NOW_SHORT') continue

      totalSignals++

      // Dedupe: skip if same (coin,type) was opened within DEDUPE_WINDOW_MS
      const dedupKey = `${enriched.coin}|${enriched.type}`
      const lastEntry = lastEntryByKey.get(dedupKey)
      if (lastEntry !== undefined && T - lastEntry < DEDUPE_WINDOW_MS) continue
      lastEntryByKey.set(dedupKey, T)

      // Simulate
      // Future 5m candles starting at T
      const futureIdx = bundle.data.candles5m.findIndex(c => c.time >= T)
      if (futureIdx < 0) continue
      const future = bundle.data.candles5m.slice(futureIdx)
      const result = simulateTrade(enriched, future, T)
      trades.push(result)
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n[WF] Done in ${elapsed}s`)
  console.log(`[WF] Total signals: ${totalSignals}`)
  console.log(`[WF] Total trades (after dedupe): ${trades.length}`)

  const metrics = aggregate(trades, totalSignals)

  console.log(`\n[WF] === SUMMARY ===`)
  console.log(`  Trades:    ${metrics.totalTrades}`)
  console.log(`  Win rate:  ${(metrics.winRate * 100).toFixed(1)}%`)
  console.log(`  Total R:   ${metrics.totalR.toFixed(2)}`)
  console.log(`  Avg R/tr:  ${metrics.avgR.toFixed(3)}`)

  formatBucket('Strategy', metrics.byStrategy)
  formatBucket('Setup Category', metrics.bySetupCategory)
  formatBucket('Execution Type', metrics.byExecutionType)
  formatBucket('Score Band', metrics.byScoreBand)
  formatBucket('Type (LONG/SHORT)', metrics.byType)
  console.log(`\n  By Exit Reason:`)
  for (const [k, v] of Object.entries(metrics.byExitReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${v}`)
  }

  // Save
  const outFile = path.join(OUT_DIR, `scanner_wf_${Date.now()}.json`)
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        config: { days, stepMinutes: STEP_MINUTES, minScore, symbols },
        windowStart,
        windowEnd,
        metrics,
        trades,
      },
      null,
      2,
    ),
  )
  console.log(`\n[WF] Saved to ${outFile}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
