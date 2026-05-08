/**
 * Compare USDT-PnL of baseline vs flagged config (head-to-head with fees).
 * Both configs use the same window and bundles for fair comparison.
 *
 * Note: env flags affect strategies/index.ts and hardFilters.ts at MODULE LOAD.
 * To test flagged config we need a separate process — but for SHORT and
 * mean_revert filtering, we can simulate via signalFilter on the same run.
 * For SCANNER_MAX_LEVERAGE=3, we override leverage on the resulting trades.
 *
 * This script approximates the production config without re-loading modules.
 */

import 'dotenv/config'
import { loadBundles, runWalkforward, aggregate, loadTop30Symbols, STEP_MS } from './backtestCore'
import { TradeResult } from './tradeSimulator'
import { LimitTradeResult } from './limitSimulator'
import { EnrichedSignal } from '../../scanner/scoring/index'

const FEE_TAKER = 0.0006

function feeInR(leverage: number, slPct: number): number {
  if (slPct <= 0) return 0.05
  return 2 * FEE_TAKER * leverage / (slPct / 100)
}

function pnlSimulation(trades: (TradeResult | LimitTradeResult)[], leverageCap: number, label: string) {
  const startingDeposit = 1000
  const riskPct = 0.01
  let balance = startingDeposit
  let totalFees = 0
  let runningPeak = startingDeposit
  let maxDDPct = 0
  let totalGrossR = 0
  let totalNetR = 0
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) {
    const slPct = Math.abs(t.entry - t.initialStop) / t.entry * 100
    // We don't have the actual leverage in TradeResult — approximate from signal.
    // For now use a representative average: cap or 5x
    const lev = leverageCap > 0 ? leverageCap : 5
    const feeR = feeInR(lev, slPct)
    const netR = t.realizedR - feeR
    totalGrossR += t.realizedR
    totalNetR += netR
    const riskUsd = balance * riskPct
    balance += netR * riskUsd
    totalFees += feeR * riskUsd
    if (balance > runningPeak) runningPeak = balance
    const dd = (runningPeak - balance) / runningPeak
    if (dd > maxDDPct) maxDDPct = dd
  }
  const wins = trades.filter(t => t.realizedR > 0).length
  console.log(`\n[${label}]`)
  console.log(`  Trades:        ${trades.length}`)
  console.log(`  WR:            ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '?'}%`)
  console.log(`  Gross R:       ${totalGrossR.toFixed(2)}`)
  console.log(`  Net R:         ${totalNetR.toFixed(2)}  (after fees @${leverageCap}x lev)`)
  console.log(`  Final balance: $${balance.toFixed(2)}  (${((balance / startingDeposit - 1) * 100).toFixed(1)}%)`)
  console.log(`  Max DD:        ${(maxDDPct * 100).toFixed(1)}%`)
  console.log(`  Total fees:    $${totalFees.toFixed(2)}`)
}

async function main() {
  const symbols = loadTop30Symbols()
  console.log('[Compare] Loading bundles...')
  const bundles = await loadBundles(symbols, 365, true)
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - 365 * 24 * 3600_000

  // Single backtest run, then split via post-filter (cheaper than two runs)
  console.log('[Compare] Running 365-day backtest...')
  const r = runWalkforward(bundles, {
    symbols, days: 365, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })

  const all = r.trades
  // Baseline: all trades
  // Flagged (production): SHORT off + mean_revert off
  const flagged = all.filter(t => t.type === 'LONG' && t.strategy !== 'mean_revert')

  console.log('\n========== USDT P&L COMPARISON ==========')
  pnlSimulation(all, 5, 'A) Baseline (all trades, lev 5x)')
  pnlSimulation(all, 3, 'B) Baseline + leverage cap 3x')
  pnlSimulation(flagged, 5, 'C) SHORT+MR off (lev 5x)')
  pnlSimulation(flagged, 3, 'D) PRODUCTION CONFIG (SHORT+MR off, lev 3x)')

  const m_all = aggregate(all)
  const m_flagged = aggregate(flagged)
  console.log('\n========== R-METRICS ==========')
  console.log(`  Baseline:  trades=${m_all.totalTrades}, totalR=${m_all.totalR.toFixed(2)}, Sharpe=${m_all.sharpe.toFixed(3)}, maxDD=${m_all.maxDrawdownR.toFixed(2)}`)
  console.log(`  Flagged:   trades=${m_flagged.totalTrades}, totalR=${m_flagged.totalR.toFixed(2)}, Sharpe=${m_flagged.sharpe.toFixed(3)}, maxDD=${m_flagged.maxDrawdownR.toFixed(2)}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
