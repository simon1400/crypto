/**
 * Deep analysis runner — 4 follow-up investigations on top of base experiments:
 *   8. TEST window monthly breakdown + BTC regime per month
 *   9. Strategy × Type combo sweep
 *  10. Per-coin breakdown (top/bottom 5)
 *  11. USDT P&L with fees + leverage
 *
 * Loads bundles ONCE, runs everything against the same data.
 * Output: data/backtest/scanner_deep_<ts>.json + console summary
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/runDeepAnalysis.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import {
  loadBundles, runWalkforward, aggregate, loadTop30Symbols,
  STEP_MS, BacktestConfig, AggregateMetrics,
} from './backtestCore'
import { TradeResult } from './tradeSimulator'
import { LimitTradeResult } from './limitSimulator'
import { EnrichedSignal } from '../../scanner/scoring/index'
import { buildBtcRegime, buildSnapshot } from './historicalScannerEngine'

const OUT_DIR = path.join(__dirname, '../../../data/backtest')
const DAYS = 365

// === Fee model ===
// Bybit linear perp default: 0.06% taker, 0.01% maker.
// Conservative round-trip (open + close at taker): 0.12% × leverage.
// On a trade with leverage=5 and risk=1%, fees eat 0.6% of margin per round trip.
const FEE_TAKER = 0.0006
const FEE_MAKER = 0.0001

function header(s: string) {
  console.log(`\n${'='.repeat(80)}\n${s}\n${'='.repeat(80)}`)
}

function pct(n: number) { return (n * 100).toFixed(1) + '%' }
function r(n: number) { return n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2) }

// =============================================================================
// EXPERIMENT 8: TEST window monthly breakdown
// =============================================================================
async function exp8_testWindowAnalysis(bundles: any, symbols: string[], windowStart: number, windowEnd: number, train90: number) {
  header('Exp 8: TEST window monthly breakdown')

  const testTrades = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70,
    windowStartMs: train90, windowEndMs: windowEnd, quiet: true,
  })

  // Group trades by month (entry month)
  const byMonth: Record<string, (TradeResult | LimitTradeResult)[]> = {}
  for (const t of testTrades.trades) {
    const month = new Date(t.entryTime).toISOString().slice(0, 7)
    if (!byMonth[month]) byMonth[month] = []
    byMonth[month].push(t)
  }

  // Determine BTC regime over each month using daily snapshot at the 15th of each month
  const btc = bundles.get('BTCUSDT')
  const monthRegimes: Record<string, { regime: string; sample: number }> = {}
  const months = Object.keys(byMonth).sort()
  for (const m of months) {
    const midMonth = Date.parse(`${m}-15T12:00:00Z`)
    const snap = buildSnapshot(btc.data, midMonth)
    if (!snap) continue
    const reg = buildBtcRegime(btc.data, midMonth)
    monthRegimes[m] = { regime: reg.regime, sample: midMonth }
  }

  console.log(`\n  Monthly breakdown (TEST: ${new Date(train90).toISOString().slice(0,10)} → ${new Date(windowEnd).toISOString().slice(0,10)}):`)
  console.log(`  Month     BTC Regime         Trades    WR    Total R    Avg R`)
  console.log(`  --------  -----------------  ------  -----  --------  -------`)
  const monthlyResults: any[] = []
  for (const m of months) {
    const trades = byMonth[m]
    const wins = trades.filter(t => t.realizedR > 0).length
    const totalR = trades.reduce((s, t) => s + t.realizedR, 0)
    const avgR = totalR / trades.length
    const wr = wins / trades.length
    const reg = monthRegimes[m]?.regime || 'UNKNOWN'
    console.log(`  ${m}    ${reg.padEnd(17)}  ${String(trades.length).padStart(6)}  ${(wr * 100).toFixed(0).padStart(4)}%  ${totalR.toFixed(2).padStart(7)}  ${avgR.toFixed(3)}`)
    monthlyResults.push({ month: m, regime: reg, trades: trades.length, wins, totalR: Math.round(totalR * 100) / 100, avgR: Math.round(avgR * 1000) / 1000, winRate: Math.round(wr * 1000) / 1000 })
  }

  // Strategy × month grid
  console.log(`\n  Strategy × Month grid (totalR):`)
  const strategies = ['trend_follow', 'breakout', 'mean_revert']
  console.log(`  Month    ${strategies.map(s => s.padStart(12)).join(' ')}`)
  for (const m of months) {
    const row = [m]
    for (const s of strategies) {
      const trs = byMonth[m].filter(t => t.strategy === s)
      const tr = trs.reduce((sum, t) => sum + t.realizedR, 0)
      row.push(trs.length > 0 ? `${tr.toFixed(2).padStart(7)} (${trs.length})` : '       '.padStart(12))
    }
    console.log(`  ${row[0]}  ${row.slice(1).map(s => s.padStart(12)).join(' ')}`)
  }

  return { monthlyResults, totalTestTrades: testTrades.trades.length }
}

// =============================================================================
// EXPERIMENT 9: Strategy × Type combo sweep
// =============================================================================
async function exp9_comboSweep(bundles: any, symbols: string[], windowStart: number, windowEnd: number) {
  header('Exp 9: Strategy × Type combo sweep')

  const combos: { name: string; filter: (e: EnrichedSignal) => boolean }[] = [
    { name: 'baseline (all)', filter: () => true },
    { name: 'LONG only', filter: e => e.type === 'LONG' },
    { name: 'SHORT only', filter: e => e.type === 'SHORT' },
    { name: 'breakout only', filter: e => e.strategy === 'breakout' },
    { name: 'trend_follow only', filter: e => e.strategy === 'trend_follow' },
    { name: 'mean_revert only', filter: e => e.strategy === 'mean_revert' },
    { name: 'LONG breakout', filter: e => e.type === 'LONG' && e.strategy === 'breakout' },
    { name: 'LONG trend_follow', filter: e => e.type === 'LONG' && e.strategy === 'trend_follow' },
    { name: 'SHORT breakout', filter: e => e.type === 'SHORT' && e.strategy === 'breakout' },
    { name: 'SHORT trend_follow', filter: e => e.type === 'SHORT' && e.strategy === 'trend_follow' },
    { name: 'no SHORT mean_revert', filter: e => !(e.type === 'SHORT' && e.strategy === 'mean_revert') },
    { name: 'no LONG mean_revert', filter: e => !(e.type === 'LONG' && e.strategy === 'mean_revert') },
  ]

  console.log(`\n  ${'combo'.padEnd(28)} trades   WR    totalR     avgR    maxDD  Sharpe`)
  console.log(`  ${'-'.repeat(28)} ------  ----- --------  -------  ------  ------`)
  const results: any[] = []
  for (const c of combos) {
    const r2 = runWalkforward(bundles, {
      symbols, days: DAYS, minScore: 70,
      windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
      signalFilter: (e: EnrichedSignal, ms: number) => {
        if (!e.hard_filter.passed) return false
        if (e.category === 'IGNORE') return false
        if (e.setup_score < ms) return false
        if (e.execution_type !== 'ENTER_NOW_LONG' && e.execution_type !== 'ENTER_NOW_SHORT') return false
        return c.filter(e)
      },
    })
    const m = aggregate(r2.trades)
    console.log(`  ${c.name.padEnd(28)} ${String(m.totalTrades).padStart(6)}  ${(m.winRate * 100).toFixed(1).padStart(4)}% ${m.totalR.toFixed(2).padStart(8)}  ${m.avgR.toFixed(3).padStart(7)}  ${m.maxDrawdownR.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(3).padStart(6)}`)
    results.push({
      name: c.name,
      trades: m.totalTrades, winRate: m.winRate, totalR: m.totalR,
      avgR: m.avgR, maxDD: m.maxDrawdownR, sharpe: m.sharpe,
    })
  }
  return results
}

// =============================================================================
// EXPERIMENT 10: Per-coin breakdown
// =============================================================================
async function exp10_perCoinBreakdown_reuse(baseline: ReturnType<typeof runWalkforward>) {
  header('Exp 10: Per-coin breakdown')
  const m = aggregate(baseline.trades)

  // Sort coins by totalR
  const coinEntries = Object.entries(m.byCoin).sort((a, b) => b[1].totalR - a[1].totalR)

  console.log(`\n  Top 10 coins (by totalR):`)
  console.log(`  ${'rank'.padStart(4)}  ${'coin'.padEnd(15)} trades   WR    totalR    avgR`)
  for (let i = 0; i < Math.min(10, coinEntries.length); i++) {
    const [coin, b] = coinEntries[i]
    console.log(`  ${String(i + 1).padStart(4)}  ${coin.padEnd(15)} ${String(b.trades).padStart(6)}  ${(b.winRate * 100).toFixed(0).padStart(4)}% ${b.totalR.toFixed(2).padStart(7)}  ${b.avgR.toFixed(3)}`)
  }

  console.log(`\n  Bottom 10 coins (by totalR):`)
  console.log(`  ${'rank'.padStart(4)}  ${'coin'.padEnd(15)} trades   WR    totalR    avgR`)
  for (let i = 0; i < Math.min(10, coinEntries.length); i++) {
    const [coin, b] = coinEntries[coinEntries.length - 1 - i]
    console.log(`  ${String(i + 1).padStart(4)}  ${coin.padEnd(15)} ${String(b.trades).padStart(6)}  ${(b.winRate * 100).toFixed(0).padStart(4)}% ${b.totalR.toFixed(2).padStart(7)}  ${b.avgR.toFixed(3)}`)
  }

  // What if we blacklist worst N?
  console.log(`\n  Effect of blacklisting bottom-N coins:`)
  for (const n of [0, 3, 5, 7, 10]) {
    const blackset = new Set(coinEntries.slice(coinEntries.length - n).map(e => e[0]))
    const surviving = baseline.trades.filter(t => !blackset.has(t.coin))
    const totalR = surviving.reduce((s, t) => s + t.realizedR, 0)
    const wr = surviving.length > 0 ? surviving.filter(t => t.realizedR > 0).length / surviving.length : 0
    console.log(`    blacklist worst ${String(n).padStart(2)}: keep ${surviving.length} trades, totalR=${totalR.toFixed(2)}, WR=${(wr * 100).toFixed(0)}%`)
  }

  return { coinEntries: coinEntries.map(([coin, b]) => ({ coin, ...b })) }
}

// =============================================================================
// EXPERIMENT 11: USDT P&L with fees + leverage
// =============================================================================
async function exp11_usdtPnl_reuse(baseline: ReturnType<typeof runWalkforward>) {
  header('Exp 11: USDT P&L with fees + leverage')

  // Simulation params
  const startingDeposit = 1000
  const riskPctPerTrade = 0.01 // 1% of deposit per trade

  // Two scenarios:
  //   A) "raw R": assume risk_amount is constant ($10 on $1000 deposit)
  //   B) "compounding": each trade risks 1% of CURRENT equity
  // For both: subtract fees per trade.
  // Fee = 2 × taker_rate × position_notional = 2 × 0.0006 × (risk × leverage / slPct)
  //     = 2 × 0.0006 × leverage / slPct × risk
  // Simplification: fee in R = 2 × 0.0006 × leverage / slPct
  // Since each enriched signal has leverage and slPercent, fee per round-trip in R:

  function feeInR(leverage: number, slPercent: number): number {
    // round trip: open + close, both at taker rate
    // notional = position_size = (risk_amount × leverage / slPct)
    // fee = 2 × taker × notional
    // in R units: fee_R = fee / risk_amount = 2 × taker × leverage / (slPct/100)
    if (slPercent <= 0) return 0.05 // safety floor
    return 2 * FEE_TAKER * leverage / (slPercent / 100)
  }

  // We need per-trade leverage and slPercent. These were stored in the simulator's
  // TradeResult only as initialStop and entry, but not leverage. Let me reconstruct:
  // SL% = |entry - initialStop| / entry × 100
  // Leverage was set in EnrichedSignal but we didn't propagate. For now, assume
  // a representative leverage of 5x (median in our sweeps).

  const ASSUMED_LEVERAGE = 5

  let scenarioA_balance = startingDeposit
  let scenarioB_balance = startingDeposit
  const scenarioA_curve: { time: number; balance: number }[] = []
  const scenarioB_curve: { time: number; balance: number }[] = []
  let totalFeesA = 0
  let totalFeesB = 0

  for (const t of [...baseline.trades].sort((a, b) => a.entryTime - b.entryTime)) {
    const slPct = Math.abs(t.entry - t.initialStop) / t.entry * 100
    const fee_R = feeInR(ASSUMED_LEVERAGE, slPct)
    const net_R = t.realizedR - fee_R

    // Scenario A: fixed $10 risk
    const dollarPnL_A = net_R * (startingDeposit * riskPctPerTrade)
    scenarioA_balance += dollarPnL_A
    totalFeesA += fee_R * (startingDeposit * riskPctPerTrade)
    scenarioA_curve.push({ time: t.exitTime, balance: Math.round(scenarioA_balance * 100) / 100 })

    // Scenario B: compounding 1% of current equity
    const riskUsd_B = scenarioB_balance * riskPctPerTrade
    const dollarPnL_B = net_R * riskUsd_B
    totalFeesB += fee_R * riskUsd_B
    scenarioB_balance += dollarPnL_B
    scenarioB_curve.push({ time: t.exitTime, balance: Math.round(scenarioB_balance * 100) / 100 })
  }

  // Stats
  const finalA = scenarioA_balance
  const finalB = scenarioB_balance
  const peakA = Math.max(...scenarioA_curve.map(p => p.balance))
  const peakB = Math.max(...scenarioB_curve.map(p => p.balance))
  let troughA = startingDeposit, troughB = startingDeposit
  let runningPeakA = startingDeposit, runningPeakB = startingDeposit
  let maxDDA_pct = 0, maxDDB_pct = 0
  for (const p of scenarioA_curve) {
    if (p.balance > runningPeakA) runningPeakA = p.balance
    const dd = (runningPeakA - p.balance) / runningPeakA
    if (dd > maxDDA_pct) maxDDA_pct = dd
    if (p.balance < troughA) troughA = p.balance
  }
  for (const p of scenarioB_curve) {
    if (p.balance > runningPeakB) runningPeakB = p.balance
    const dd = (runningPeakB - p.balance) / runningPeakB
    if (dd > maxDDB_pct) maxDDB_pct = dd
    if (p.balance < troughB) troughB = p.balance
  }

  console.log(`\n  Starting deposit: $${startingDeposit}, risk per trade: ${(riskPctPerTrade * 100).toFixed(1)}%`)
  console.log(`  Assumed leverage: ${ASSUMED_LEVERAGE}x, taker fee: ${(FEE_TAKER * 100).toFixed(3)}%`)
  console.log(`  Total trades: ${baseline.trades.length}`)
  console.log()
  console.log(`  Scenario A (fixed $${(startingDeposit * riskPctPerTrade).toFixed(0)}/trade):`)
  console.log(`    Final balance: $${finalA.toFixed(2)} (${((finalA / startingDeposit - 1) * 100).toFixed(1)}%)`)
  console.log(`    Peak:          $${peakA.toFixed(2)}, Trough: $${troughA.toFixed(2)}`)
  console.log(`    Max DD:        ${(maxDDA_pct * 100).toFixed(1)}%`)
  console.log(`    Total fees:    $${totalFeesA.toFixed(2)}`)
  console.log()
  console.log(`  Scenario B (compounding 1%):`)
  console.log(`    Final balance: $${finalB.toFixed(2)} (${((finalB / startingDeposit - 1) * 100).toFixed(1)}%)`)
  console.log(`    Peak:          $${peakB.toFixed(2)}, Trough: $${troughB.toFixed(2)}`)
  console.log(`    Max DD:        ${(maxDDB_pct * 100).toFixed(1)}%`)
  console.log(`    Total fees:    $${totalFeesB.toFixed(2)}`)

  // Save curves for plotting
  const csvA = path.join(OUT_DIR, 'scanner_balance_fixed.csv')
  const csvB = path.join(OUT_DIR, 'scanner_balance_compounding.csv')
  fs.writeFileSync(csvA, ['time_iso,balance', ...scenarioA_curve.map(p => `${new Date(p.time).toISOString()},${p.balance}`)].join('\n'))
  fs.writeFileSync(csvB, ['time_iso,balance', ...scenarioB_curve.map(p => `${new Date(p.time).toISOString()},${p.balance}`)].join('\n'))
  console.log(`\n  Saved equity curves: ${path.basename(csvA)}, ${path.basename(csvB)}`)

  return {
    startingDeposit, riskPctPerTrade, assumedLeverage: ASSUMED_LEVERAGE, feeTaker: FEE_TAKER,
    scenarioA: { final: finalA, peak: peakA, trough: troughA, maxDDPct: maxDDA_pct, totalFees: totalFeesA },
    scenarioB: { final: finalB, peak: peakB, trough: troughB, maxDDPct: maxDDB_pct, totalFees: totalFeesB },
  }
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  const symbols = loadTop30Symbols()
  console.log(`[Deep] Loading ${symbols.length} symbols × 4 TFs + funding for ${DAYS}d...`)
  const bundles = await loadBundles(symbols, DAYS, true)
  console.log(`[Deep] Bundles loaded.`)

  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - DAYS * 24 * 3600_000
  const train90 = windowStart + Math.floor((windowEnd - windowStart) * 0.75)

  const out: any = { generatedAt: new Date().toISOString(), windowStart, windowEnd, train90 }

  // Run baseline once and reuse for exp10 + exp11
  const baseline = runWalkforward(bundles, {
    symbols, days: DAYS, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })
  console.log(`[Deep] Baseline: ${baseline.trades.length} trades`)

  out.exp8 = await exp8_testWindowAnalysis(bundles, symbols, windowStart, windowEnd, train90)
  out.exp9 = await exp9_comboSweep(bundles, symbols, windowStart, windowEnd)
  out.exp10 = await exp10_perCoinBreakdown_reuse(baseline)
  out.exp11 = await exp11_usdtPnl_reuse(baseline)

  const outFile = path.join(OUT_DIR, `scanner_deep_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
  console.log(`\n\nSaved: ${path.relative(process.cwd(), outFile)}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
