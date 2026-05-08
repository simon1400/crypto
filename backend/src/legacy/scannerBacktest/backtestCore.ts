/**
 * Backtest Core — shared infra for all scanner backtests.
 *
 * Pluggable hooks let each experiment override behavior without copy-paste:
 *   - signalFilter: decides whether to take a signal (e.g. score gate, strategy gate)
 *   - executionFilter: which execution_types to simulate (default: ENTER_NOW only)
 *   - tradeRecorder: optional callback for per-trade logging
 *
 * Returns: { trades, signals, runTimeSec, equityCurve }
 */

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
import { simulateTrade, TradeResult } from './tradeSimulator'
import { simulateLimitTrade, LimitTradeResult } from './limitSimulator'
import { EnrichedSignal } from '../../scanner/scoring/index'

export const STEP_MS = 12 * 60_000 // matches autoScanner default
export const DEDUPE_WINDOW_MS = 2 * 3600_000 // matches alert TTL

export interface BacktestConfig {
  symbols: string[]
  days: number
  // Optional sub-window inside loaded history. If unset, uses [now-days, now-1h]
  windowStartMs?: number
  windowEndMs?: number
  /** Decide whether to take this enriched signal. Defaults to: passed hard filter, score≥minScore, ENTER_NOW only. */
  signalFilter?: (e: EnrichedSignal, minScore: number) => boolean
  /** Min score gate (used by default signalFilter) */
  minScore?: number
  /** Whether to simulate LIMIT/WAIT_FOR_PULLBACK signals via limit fills (default false) */
  enableLimitSim?: boolean
  /** Quiet-load (don't print per-symbol load lines) */
  quiet?: boolean
}

export interface SymbolBundle {
  symbol: string
  data: SymbolHistoricalData
  fundingHistory: FundingPoint[]
}

export interface EquityPoint {
  time: number
  equityR: number // cumulative R
}

export interface BacktestRunResult {
  trades: (TradeResult | LimitTradeResult)[]
  totalSignals: number
  signalsRejectedByFilter: number
  runTimeSec: number
  equityCurve: EquityPoint[]
  windowStart: number
  windowEnd: number
}

export async function loadBundles(symbols: string[], days: number, quiet = false): Promise<Map<string, SymbolBundle>> {
  const months = Math.ceil(days / 30) + 2
  const bundles = new Map<string, SymbolBundle>()
  if (!quiet) console.log(`[Core] Loading ${symbols.length} symbols × 4 TFs + funding...`)
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]
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
    if (!quiet) console.log(`  [${i + 1}/${symbols.length}] ${sym}: ${((Date.now() - t0) / 1000).toFixed(1)}s — 5m=${c5.length}, funding=${funding.length}`)
  }
  return bundles
}

export const DEFAULT_SIGNAL_FILTER = (e: EnrichedSignal, minScore: number): boolean => {
  if (!e.hard_filter.passed) return false
  if (e.category === 'IGNORE') return false
  if (e.setup_score < minScore) return false
  if (e.execution_type !== 'ENTER_NOW_LONG' && e.execution_type !== 'ENTER_NOW_SHORT') return false
  return true
}

/**
 * Full walk-forward run. Bundles must already be loaded (call loadBundles first).
 * Trades are returned in entry-time order, ready for equity curve construction.
 */
export function runWalkforward(
  bundles: Map<string, SymbolBundle>,
  cfg: BacktestConfig,
): BacktestRunResult {
  const minScore = cfg.minScore ?? 70
  const signalFilter = cfg.signalFilter ?? ((e: EnrichedSignal) => DEFAULT_SIGNAL_FILTER(e, minScore))
  const symbols = cfg.symbols
  const enableLimit = cfg.enableLimitSim === true

  const btc = bundles.get('BTCUSDT')
  if (!btc) throw new Error('BTCUSDT bundle required for regime detection')

  const now = Date.now()
  const windowEnd = cfg.windowEndMs ?? Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = cfg.windowStartMs ?? windowEnd - cfg.days * 24 * 3600_000

  if (!cfg.quiet) {
    console.log(`[Core] Window: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`)
    console.log(`[Core] minScore=${minScore}, limitSim=${enableLimit}`)
  }

  const trades: (TradeResult | LimitTradeResult)[] = []
  const lastEntryByKey = new Map<string, number>()
  const lastLimitOpenByKey = new Map<string, number>()
  let totalSignals = 0
  let rejectedByFilter = 0
  const totalSteps = Math.floor((windowEnd - windowStart) / STEP_MS)
  let stepsProcessed = 0
  let lastReportedPct = -1
  const t0 = Date.now()

  for (let T = windowStart; T <= windowEnd; T += STEP_MS) {
    stepsProcessed++
    if (!cfg.quiet) {
      const pct = Math.floor((stepsProcessed / totalSteps) * 100)
      if (pct >= lastReportedPct + 10) {
        const elapsed = (Date.now() - t0) / 1000
        const eta = elapsed / stepsProcessed * (totalSteps - stepsProcessed)
        console.log(`  ${pct}% — ${trades.length} trades, ${totalSignals} signals, ${elapsed.toFixed(0)}s elapsed / ${eta.toFixed(0)}s eta`)
        lastReportedPct = pct
      }
    }

    const btcSnap = buildSnapshot(btc.data, T)
    if (!btcSnap) continue
    const regime = buildBtcRegime(btc.data, T)

    for (const sym of symbols) {
      const b = bundles.get(sym)
      if (!b) continue
      const fnFunding = (ms: number) => fundingAt(b.fundingHistory, ms)

      let enriched: EnrichedSignal | null
      try {
        enriched = scoreSymbolAt(sym.replace(/USDT$/, ''), b.data, T, {
          regime, btcSnapshot: btcSnap, fundingAt: fnFunding,
        })
      } catch { continue }
      if (!enriched) continue

      // Always count signals that pass hard filter + are not IGNORE
      const isMarketSignal = enriched.execution_type === 'ENTER_NOW_LONG' || enriched.execution_type === 'ENTER_NOW_SHORT'
      const isLimitSignal = enriched.execution_type === 'LIMIT_LONG' || enriched.execution_type === 'LIMIT_SHORT'

      if (!signalFilter(enriched, minScore)) {
        // Track LIMIT signals separately if limit sim enabled
        if (enableLimit && isLimitSignal && enriched.hard_filter.passed && enriched.category !== 'IGNORE' && enriched.setup_score >= minScore) {
          const dedupKey = `LIMIT|${enriched.coin}|${enriched.type}`
          const lastEntry = lastLimitOpenByKey.get(dedupKey)
          if (lastEntry === undefined || T - lastEntry >= DEDUPE_WINDOW_MS) {
            lastLimitOpenByKey.set(dedupKey, T)
            totalSignals++
            const futureIdx = b.data.candles5m.findIndex(c => c.time >= T)
            if (futureIdx >= 0) {
              const result = simulateLimitTrade(enriched, b.data.candles5m.slice(futureIdx), T)
              if (result) trades.push(result)
            }
          }
        } else {
          rejectedByFilter++
        }
        continue
      }
      if (!isMarketSignal) {
        rejectedByFilter++
        continue
      }

      totalSignals++
      const dedupKey = `MARKET|${enriched.coin}|${enriched.type}`
      const lastEntry = lastEntryByKey.get(dedupKey)
      if (lastEntry !== undefined && T - lastEntry < DEDUPE_WINDOW_MS) continue
      lastEntryByKey.set(dedupKey, T)

      const futureIdx = b.data.candles5m.findIndex(c => c.time >= T)
      if (futureIdx < 0) continue
      const result = simulateTrade(enriched, b.data.candles5m.slice(futureIdx), T)
      trades.push(result)
    }
  }

  // Sort trades by entry time for equity curve
  trades.sort((a, b) => a.entryTime - b.entryTime)

  const equityCurve: EquityPoint[] = []
  let cum = 0
  for (const tr of trades) {
    cum += tr.realizedR
    equityCurve.push({ time: tr.exitTime, equityR: Math.round(cum * 1000) / 1000 })
  }

  return {
    trades,
    totalSignals,
    signalsRejectedByFilter: rejectedByFilter,
    runTimeSec: Math.round((Date.now() - t0) / 100) / 10,
    equityCurve,
    windowStart,
    windowEnd,
  }
}

// === Aggregation helpers ===
export interface BucketStats { trades: number; wins: number; totalR: number; avgR: number; winRate: number }
export const emptyBucket = (): BucketStats => ({ trades: 0, wins: 0, totalR: 0, avgR: 0, winRate: 0 })

export interface AggregateMetrics {
  totalTrades: number
  wins: number
  losses: number
  totalR: number
  avgR: number
  winRate: number
  maxDrawdownR: number
  // Sharpe-like ratio: avgR / stdev(R)
  sharpe: number
  byStrategy: Record<string, BucketStats>
  bySetupCategory: Record<string, BucketStats>
  byExecutionType: Record<string, BucketStats>
  byScoreBand: Record<string, BucketStats>
  byType: Record<string, BucketStats>
  byExitReason: Record<string, number>
  byCoin: Record<string, BucketStats>
}

export function scoreBand(score: number): string {
  if (score >= 80) return '80-100'
  if (score >= 70) return '70-79'
  if (score >= 60) return '60-69'
  return '<60'
}

export function aggregate(trades: (TradeResult | LimitTradeResult)[]): AggregateMetrics {
  const m: AggregateMetrics = {
    totalTrades: trades.length,
    wins: 0, losses: 0, totalR: 0, avgR: 0, winRate: 0,
    maxDrawdownR: 0, sharpe: 0,
    byStrategy: {}, bySetupCategory: {}, byExecutionType: {},
    byScoreBand: {}, byType: {}, byExitReason: {}, byCoin: {},
  }
  if (trades.length === 0) return m

  const rs: number[] = []
  for (const t of trades) {
    if (t.realizedR > 0) m.wins++; else m.losses++
    m.totalR += t.realizedR
    rs.push(t.realizedR)

    const buckets: [Record<string, BucketStats>, string][] = [
      [m.byStrategy, t.strategy],
      [m.bySetupCategory, t.setupCategory],
      [m.byExecutionType, t.executionType],
      [m.byScoreBand, scoreBand(t.setupScore)],
      [m.byType, t.type],
      [m.byCoin, t.coin],
    ]
    for (const [bucket, key] of buckets) {
      if (!bucket[key]) bucket[key] = emptyBucket()
      bucket[key].trades++
      bucket[key].totalR += t.realizedR
      if (t.realizedR > 0) bucket[key].wins++
    }
    m.byExitReason[t.exitReason] = (m.byExitReason[t.exitReason] || 0) + 1
  }
  m.avgR = m.totalR / trades.length
  m.winRate = m.wins / trades.length

  // Max drawdown — equity curve in entry order, track running peak
  let cum = 0, peak = 0, maxDd = 0
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime)
  for (const t of sorted) {
    cum += t.realizedR
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDd) maxDd = dd
  }
  m.maxDrawdownR = Math.round(maxDd * 1000) / 1000

  // Sharpe-like
  const mean = m.avgR
  const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / rs.length
  const std = Math.sqrt(variance)
  m.sharpe = std > 0 ? Math.round((mean / std) * 1000) / 1000 : 0

  for (const bucket of [m.byStrategy, m.bySetupCategory, m.byExecutionType, m.byScoreBand, m.byType, m.byCoin]) {
    for (const k of Object.keys(bucket)) {
      const b = bucket[k]
      b.avgR = b.trades > 0 ? Math.round((b.totalR / b.trades) * 1000) / 1000 : 0
      b.winRate = b.trades > 0 ? Math.round((b.wins / b.trades) * 1000) / 1000 : 0
      b.totalR = Math.round(b.totalR * 100) / 100
    }
  }
  m.totalR = Math.round(m.totalR * 100) / 100
  m.avgR = Math.round(m.avgR * 1000) / 1000
  m.winRate = Math.round(m.winRate * 1000) / 1000

  return m
}

export function formatBucket(label: string, bucket: Record<string, BucketStats>, topN = 10): string[] {
  const lines: string[] = [`  By ${label}:`]
  const keys = Object.keys(bucket).sort((a, b) => bucket[b].totalR - bucket[a].totalR).slice(0, topN)
  for (const k of keys) {
    const b = bucket[k]
    lines.push(`    ${k.padEnd(28)} trades=${String(b.trades).padStart(4)} WR=${(b.winRate * 100).toFixed(0).padStart(3)}% totalR=${b.totalR.toFixed(2).padStart(7)} avgR=${b.avgR.toFixed(3)}`)
  }
  return lines
}

export function loadTop30Symbols(): string[] {
  const f = path.join(__dirname, '../../../data/backtest/scanner_top30.json')
  if (!fs.existsSync(f)) throw new Error('scanner_top30.json missing — run selectTopSymbols.ts first')
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const symbols: string[] = data.symbols.map((s: any) => s.symbol)
  if (!symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT')
  return symbols
}
