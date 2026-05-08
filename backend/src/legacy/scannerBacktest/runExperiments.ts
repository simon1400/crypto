/**
 * Master experiment runner. Runs all 5 experiments in sequence:
 *   1. minScore sweep (60/65/70/75/80) on full year
 *   2. SHORT trend_follow only filter
 *   3. Equity curve / drawdown for baseline (minScore=70)
 *   4. LIMIT execution (minScore=70 + LIMIT enabled)
 *   5. Walk-forward TRAIN(9mo)/TEST(3mo) split — find best minScore on TRAIN, validate on TEST
 *
 * Loads bundles ONCE (heavy I/O), runs all experiments against the same data.
 *
 * Output: data/backtest/scanner_experiments_<ts>.json
 *         + console summary
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/runExperiments.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import {
  loadBundles, runWalkforward, aggregate, formatBucket, loadTop30Symbols,
  STEP_MS, BacktestConfig, BacktestRunResult, AggregateMetrics, EquityPoint,
} from './backtestCore'
import { TradeResult } from './tradeSimulator'
import { LimitTradeResult } from './limitSimulator'
import { EnrichedSignal } from '../../scanner/scoring/index'

const OUT_DIR = path.join(__dirname, '../../../data/backtest')
const DAYS = 365

interface ExperimentResult {
  name: string
  description: string
  config: Partial<BacktestConfig> & { minScore?: number; tag?: string }
  metrics: AggregateMetrics
  totalSignals: number
  signalsRejectedByFilter: number
  runTimeSec: number
  windowStart: number
  windowEnd: number
}

function dump(name: string, result: BacktestRunResult, meta: { description: string; config: any }): ExperimentResult {
  const m = aggregate(result.trades)
  return {
    name,
    description: meta.description,
    config: meta.config,
    metrics: m,
    totalSignals: result.totalSignals,
    signalsRejectedByFilter: result.signalsRejectedByFilter,
    runTimeSec: result.runTimeSec,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
  }
}

function header(s: string) {
  console.log(`\n${'='.repeat(80)}\n${s}\n${'='.repeat(80)}`)
}

function summarize(name: string, m: AggregateMetrics) {
  const pf = m.totalR > 0 && m.losses > 0
    ? (m.byStrategy ? '' : '')
    : ''
  console.log(`  ${name.padEnd(35)} trades=${String(m.totalTrades).padStart(4)} WR=${(m.winRate * 100).toFixed(1).padStart(5)}% totalR=${m.totalR.toFixed(2).padStart(7)} avgR=${m.avgR.toFixed(3)} maxDD=${m.maxDrawdownR.toFixed(2).padStart(6)} Sharpe=${m.sharpe.toFixed(3)}`)
}

async function main() {
  const symbols = loadTop30Symbols()
  console.log(`[Master] Loading ${symbols.length} symbols × 4 TFs + funding for ${DAYS}d...`)
  const bundles = await loadBundles(symbols, DAYS, true)
  console.log(`[Master] Bundles loaded.\n`)

  // Compute the same window for all experiments so they're directly comparable
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - DAYS * 24 * 3600_000
  const train90 = windowStart + Math.floor((windowEnd - windowStart) * 0.75) // 9/12 = 75%

  const allResults: ExperimentResult[] = []

  // ============================================================
  // Experiment 1: Score sweep
  // ============================================================
  header('Experiment 1: minScore sweep')
  const scoreSweep = [60, 65, 70, 75, 80]
  for (const ms of scoreSweep) {
    const t0 = Date.now()
    process.stdout.write(`  minScore=${ms} ... `)
    const r = runWalkforward(bundles, { symbols, days: DAYS, minScore: ms, windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true })
    const ms_t = ((Date.now() - t0) / 1000).toFixed(0)
    const m = aggregate(r.trades)
    console.log(`${ms_t}s — ${m.totalTrades} trades, totalR=${m.totalR.toFixed(2)}, WR=${(m.winRate * 100).toFixed(0)}%, maxDD=${m.maxDrawdownR.toFixed(1)}, Sharpe=${m.sharpe.toFixed(3)}`)
    allResults.push(dump(`sweep_minScore_${ms}`, r, { description: `Sweep: minScore = ${ms}, default filters`, config: { minScore: ms } }))
  }

  // ============================================================
  // Experiment 2: SHORT-trend_follow-only filter
  // ============================================================
  // Hypothesis: SHORT mean_revert + breakout might be net negative; only allow SHORT in trend_follow.
  header('Experiment 2: SHORT trend_follow only (vs all SHORT)')
  // 2a: baseline (all SHORT allowed)
  const exp2_baseline = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70, windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })
  // 2b: filter to drop non-trend_follow SHORT
  const exp2_filtered = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70, windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
    signalFilter: (e: EnrichedSignal, ms: number) => {
      if (!e.hard_filter.passed) return false
      if (e.category === 'IGNORE') return false
      if (e.setup_score < ms) return false
      if (e.execution_type !== 'ENTER_NOW_LONG' && e.execution_type !== 'ENTER_NOW_SHORT') return false
      // Block SHORT signals from non-trend_follow strategies
      if (e.type === 'SHORT' && e.strategy !== 'trend_follow') return false
      return true
    },
  })
  const m2a = aggregate(exp2_baseline.trades)
  const m2b = aggregate(exp2_filtered.trades)
  console.log(`  baseline (all SHORT):       trades=${m2a.totalTrades}, totalR=${m2a.totalR.toFixed(2)}, WR=${(m2a.winRate * 100).toFixed(0)}%`)
  console.log(`  SHORT only via trend_follow: trades=${m2b.totalTrades}, totalR=${m2b.totalR.toFixed(2)}, WR=${(m2b.winRate * 100).toFixed(0)}%`)
  console.log(`\n  SHORT subgroup analysis:`)
  console.log(`    baseline SHORT.byStrategy:`)
  if (m2a.byType.SHORT) console.log(`      total SHORT: trades=${m2a.byType.SHORT.trades}, totalR=${m2a.byType.SHORT.totalR.toFixed(2)}`)
  for (const strat of ['trend_follow', 'breakout', 'mean_revert']) {
    const shortStrat = exp2_baseline.trades.filter(t => t.type === 'SHORT' && t.strategy === strat)
    if (shortStrat.length === 0) continue
    const totalR = shortStrat.reduce((s, t) => s + t.realizedR, 0)
    const wins = shortStrat.filter(t => t.realizedR > 0).length
    console.log(`      SHORT ${strat.padEnd(15)} trades=${shortStrat.length}, totalR=${totalR.toFixed(2)}, WR=${((wins / shortStrat.length) * 100).toFixed(0)}%, avgR=${(totalR / shortStrat.length).toFixed(3)}`)
  }
  allResults.push(dump('exp2_baseline', exp2_baseline, { description: 'Baseline minScore=70', config: { minScore: 70 } }))
  allResults.push(dump('exp2_short_trend_only', exp2_filtered, { description: 'SHORT only via trend_follow strategy', config: { minScore: 70, shortFilter: 'trend_follow_only' } }))

  // ============================================================
  // Experiment 3: Equity curve / drawdown — baseline run already done
  // Save equity curve for plotting
  // ============================================================
  header('Experiment 3: Equity curve')
  const eqCurve = exp2_baseline.equityCurve
  const peakR = eqCurve.length > 0 ? Math.max(...eqCurve.map(e => e.equityR)) : 0
  const finalR = eqCurve.length > 0 ? eqCurve[eqCurve.length - 1].equityR : 0
  console.log(`  Curve points: ${eqCurve.length}`)
  console.log(`  Final equity: ${finalR.toFixed(2)}R`)
  console.log(`  Peak equity:  ${peakR.toFixed(2)}R`)
  console.log(`  Max DD:       ${m2a.maxDrawdownR.toFixed(2)}R`)
  // Save curve as CSV
  const csvPath = path.join(OUT_DIR, 'scanner_equity_baseline.csv')
  const csvLines = ['time_iso,trade_index,equity_r']
  eqCurve.forEach((p, i) => csvLines.push(`${new Date(p.time).toISOString()},${i + 1},${p.equityR}`))
  fs.writeFileSync(csvPath, csvLines.join('\n'))
  console.log(`  Saved equity curve to: ${path.relative(process.cwd(), csvPath)}`)

  // ============================================================
  // Experiment 4: LIMIT execution simulation
  // ============================================================
  header('Experiment 4: LIMIT execution')
  const exp4 = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70, windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
    enableLimitSim: true,
  })
  const m4 = aggregate(exp4.trades)
  const limitTrades = exp4.trades.filter(t => t.executionType === 'LIMIT_LONG' || t.executionType === 'LIMIT_SHORT')
  const marketTrades = exp4.trades.filter(t => t.executionType === 'ENTER_NOW_LONG' || t.executionType === 'ENTER_NOW_SHORT')
  console.log(`  ALL (market + limit):   trades=${m4.totalTrades}, totalR=${m4.totalR.toFixed(2)}, WR=${(m4.winRate * 100).toFixed(0)}%, Sharpe=${m4.sharpe.toFixed(3)}`)

  if (marketTrades.length > 0) {
    const mr = marketTrades.reduce((s, t) => s + t.realizedR, 0)
    const mw = marketTrades.filter(t => t.realizedR > 0).length
    console.log(`  Market only:            trades=${marketTrades.length}, totalR=${mr.toFixed(2)}, WR=${((mw / marketTrades.length) * 100).toFixed(0)}%, avgR=${(mr / marketTrades.length).toFixed(3)}`)
  }
  if (limitTrades.length > 0) {
    const lr = limitTrades.reduce((s, t) => s + t.realizedR, 0)
    const lw = limitTrades.filter(t => t.realizedR > 0).length
    const avgWait = limitTrades.reduce((s, t) => s + ((t as LimitTradeResult).limitWaitMinutes || 0), 0) / limitTrades.length
    console.log(`  Limit fills only:       trades=${limitTrades.length}, totalR=${lr.toFixed(2)}, WR=${((lw / limitTrades.length) * 100).toFixed(0)}%, avgR=${(lr / limitTrades.length).toFixed(3)}, avgWait=${avgWait.toFixed(0)}min`)
    const byStrat: Record<string, { n: number; r: number; w: number }> = {}
    for (const t of limitTrades as LimitTradeResult[]) {
      if (!byStrat[t.strategy]) byStrat[t.strategy] = { n: 0, r: 0, w: 0 }
      byStrat[t.strategy].n++
      byStrat[t.strategy].r += t.realizedR
      if (t.realizedR > 0) byStrat[t.strategy].w++
    }
    for (const [k, v] of Object.entries(byStrat)) {
      console.log(`    LIMIT ${k.padEnd(15)} trades=${v.n}, totalR=${v.r.toFixed(2)}, WR=${((v.w / v.n) * 100).toFixed(0)}%, avgR=${(v.r / v.n).toFixed(3)}`)
    }
  }
  allResults.push(dump('exp4_limit_enabled', exp4, { description: 'Market + LIMIT execution at minScore=70', config: { minScore: 70, enableLimitSim: true } }))

  // ============================================================
  // Experiment 5: Walk-forward TRAIN(9mo) / TEST(3mo) split
  // ============================================================
  header('Experiment 5: Walk-forward TRAIN(9mo) / TEST(3mo)')
  console.log(`  TRAIN: ${new Date(windowStart).toISOString().slice(0, 10)} → ${new Date(train90).toISOString().slice(0, 10)}`)
  console.log(`  TEST:  ${new Date(train90).toISOString().slice(0, 10)} → ${new Date(windowEnd).toISOString().slice(0, 10)}`)
  console.log()

  // 5a. Sweep minScore on TRAIN
  console.log(`  TRAIN sweep:`)
  const trainResults: { minScore: number; metrics: AggregateMetrics }[] = []
  for (const ms of scoreSweep) {
    const r = runWalkforward(bundles, { symbols, days: DAYS, minScore: ms, windowStartMs: windowStart, windowEndMs: train90, quiet: true })
    const m = aggregate(r.trades)
    trainResults.push({ minScore: ms, metrics: m })
    console.log(`    minScore=${ms} trades=${String(m.totalTrades).padStart(4)} WR=${(m.winRate * 100).toFixed(0).padStart(3)}% totalR=${m.totalR.toFixed(2).padStart(7)} avgR=${m.avgR.toFixed(3)} Sharpe=${m.sharpe.toFixed(3)}`)
  }
  // Pick best by Sharpe (risk-adjusted) on TRAIN
  trainResults.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe)
  const bestTrain = trainResults[0]
  console.log(`\n  Best TRAIN: minScore=${bestTrain.minScore} (Sharpe=${bestTrain.metrics.sharpe})`)

  // 5b. Apply best to TEST
  const testRes = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: bestTrain.minScore,
    windowStartMs: train90, windowEndMs: windowEnd, quiet: true,
  })
  const mTest = aggregate(testRes.trades)
  console.log(`\n  TEST result with minScore=${bestTrain.minScore}:`)
  console.log(`    trades=${mTest.totalTrades}, WR=${(mTest.winRate * 100).toFixed(1)}%, totalR=${mTest.totalR.toFixed(2)}, avgR=${mTest.avgR.toFixed(3)}, maxDD=${mTest.maxDrawdownR.toFixed(2)}, Sharpe=${mTest.sharpe.toFixed(3)}`)

  // Compare to: minScore=70 baseline on TEST
  const baseTestRes = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70,
    windowStartMs: train90, windowEndMs: windowEnd, quiet: true,
  })
  const mBaseTest = aggregate(baseTestRes.trades)
  console.log(`\n  TEST baseline (minScore=70):`)
  console.log(`    trades=${mBaseTest.totalTrades}, WR=${(mBaseTest.winRate * 100).toFixed(1)}%, totalR=${mBaseTest.totalR.toFixed(2)}, avgR=${mBaseTest.avgR.toFixed(3)}, maxDD=${mBaseTest.maxDrawdownR.toFixed(2)}, Sharpe=${mBaseTest.sharpe.toFixed(3)}`)

  console.log(`\n  Verdict: optimised vs baseline TEST:`)
  console.log(`    totalR: ${mTest.totalR.toFixed(2)} vs ${mBaseTest.totalR.toFixed(2)} = ${(mTest.totalR - mBaseTest.totalR > 0 ? '+' : '')}${(mTest.totalR - mBaseTest.totalR).toFixed(2)}R`)
  console.log(`    avgR:   ${mTest.avgR.toFixed(3)} vs ${mBaseTest.avgR.toFixed(3)}`)
  console.log(`    Sharpe: ${mTest.sharpe.toFixed(3)} vs ${mBaseTest.sharpe.toFixed(3)}`)

  allResults.push(dump('exp5_test_optimized', testRes, { description: `TEST window with minScore=${bestTrain.minScore} (selected by Sharpe on TRAIN)`, config: { minScore: bestTrain.minScore, window: 'TEST' } }))
  allResults.push(dump('exp5_test_baseline70', baseTestRes, { description: 'TEST window with minScore=70 (baseline)', config: { minScore: 70, window: 'TEST' } }))

  // ============================================================
  // Master summary
  // ============================================================
  header('MASTER COMPARISON — all configs side by side (full year unless noted)')
  console.log(`  ${'experiment'.padEnd(35)} ${'trades'.padStart(6)} ${'WR%'.padStart(5)} ${'totalR'.padStart(8)} ${'avgR'.padStart(6)} ${'maxDD'.padStart(6)} ${'Sharpe'.padStart(7)}`)
  console.log(`  ${'-'.repeat(35)} ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(7)}`)
  for (const r of allResults) {
    const m = r.metrics
    console.log(`  ${r.name.padEnd(35)} ${String(m.totalTrades).padStart(6)} ${(m.winRate * 100).toFixed(1).padStart(5)} ${m.totalR.toFixed(2).padStart(8)} ${m.avgR.toFixed(3).padStart(6)} ${m.maxDrawdownR.toFixed(2).padStart(6)} ${m.sharpe.toFixed(3).padStart(7)}`)
  }

  // Save everything
  const outFile = path.join(OUT_DIR, `scanner_experiments_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    daysTotal: DAYS,
    windowStart, windowEnd, train90,
    symbols,
    experiments: allResults,
    equityCurveBaseline: eqCurve,
  }, null, 2))
  console.log(`\nSaved: ${path.relative(process.cwd(), outFile)}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
