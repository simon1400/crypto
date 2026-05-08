/**
 * Mega-sweep — find the best USDT-profitable config.
 *
 * Strategy: run baseline backtest ONCE on biggest universe + minScore=60 (most permissive),
 * then post-filter the trade list under all configs. This is far cheaper than re-running
 * the whole walk-forward 192 times.
 *
 * Axes:
 *   minScore        ∈ {60, 65, 70, 75}
 *   strategyMask    ∈ {all, breakout, breakout+trend_follow, no-mean-revert}
 *   typeMask        ∈ {all, LONG, SHORT}
 *   leverageCap     ∈ {3, 5}
 *   feeModel        ∈ {all-taker, mixed-realistic}
 *
 * Fee model "mixed-realistic":
 *   - Open: taker (market entry) — 0.055%
 *   - Close: maker (TP via limit) — 0.02%, EXCEPT when SL hit (taker 0.055%)
 *   - Partial closes (35% TP1 + 35% TP2 + 30% TP3) split fee proportionally
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/megaSweep.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadBundles, runWalkforward, aggregate, loadTop30Symbols, STEP_MS } from './backtestCore'
import { TradeResult, ExitReason } from './tradeSimulator'
import { LimitTradeResult } from './limitSimulator'

const OUT_DIR = path.join(__dirname, '../../../data/backtest')

// === Fee constants ===
// Bybit VIP 0:
const FEE_TAKER = 0.00055 // 0.055%
const FEE_MAKER = 0.00020 // 0.020%

// === Fee in R helper ===
// open_fee + close_fee both as % of notional, then converted to R via leverage/SL%
function feeInR_AllTaker(leverage: number, slPct: number): number {
  if (slPct <= 0) return 0.05
  return (FEE_TAKER + FEE_TAKER) * leverage / (slPct / 100)
}

function feeInR_Mixed(leverage: number, slPct: number, exitReason: ExitReason): number {
  if (slPct <= 0) return 0.05
  // Open is taker (market entry)
  const openFee = FEE_TAKER
  // Close depends on how the trade exited:
  //   - TP hit via limit → maker
  //   - SL hit → taker (market stop or forced close)
  //   - Time stop → taker (manual market close)
  //   - Partial closes (TP1/TP2 partial then SL on rest):
  //     each leg has its own close fee. We approximate by exit reason of the FINAL leg.
  let closeFee: number
  switch (exitReason) {
    case 'INITIAL_STOP':
    case 'BE_STOP':
    case 'TRAILING_STOP_AFTER_TP1':
    case 'TRAILING_STOP_AFTER_TP2':
    case 'TIME_STOP_PARTIAL':
    case 'TIME_STOP_CLOSE':
      closeFee = FEE_TAKER
      break
    case 'TP3_FINAL':
    case 'END_OF_DATA':
    default:
      closeFee = FEE_MAKER
      break
  }
  return (openFee + closeFee) * leverage / (slPct / 100)
}

// === Sweep ===
interface Config {
  label: string
  minScore: number
  strategyMask: 'all' | 'breakout' | 'breakout_trend_follow' | 'no_mean_revert'
  typeMask: 'all' | 'LONG' | 'SHORT'
  leverageCap: 3 | 5
  feeModel: 'all_taker' | 'mixed_realistic'
}

function buildConfigs(): Config[] {
  const out: Config[] = []
  const minScores: number[] = [60, 65, 70, 75]
  const strats: Config['strategyMask'][] = ['all', 'breakout', 'breakout_trend_follow', 'no_mean_revert']
  const types: Config['typeMask'][] = ['all', 'LONG']
  const levs: Config['leverageCap'][] = [3, 5]
  const fees: Config['feeModel'][] = ['all_taker', 'mixed_realistic']
  for (const ms of minScores)
    for (const st of strats)
      for (const ty of types)
        for (const lv of levs)
          for (const fe of fees) {
            const lbl = `S${ms}_${st}_${ty}_lev${lv}_${fe}`
            out.push({ label: lbl, minScore: ms, strategyMask: st, typeMask: ty, leverageCap: lv, feeModel: fe })
          }
  return out
}

function tradePassesConfig(t: TradeResult | LimitTradeResult, cfg: Config): boolean {
  if (t.setupScore < cfg.minScore) return false
  if (cfg.strategyMask === 'breakout' && t.strategy !== 'breakout') return false
  if (cfg.strategyMask === 'breakout_trend_follow' && t.strategy === 'mean_revert') return false
  if (cfg.strategyMask === 'no_mean_revert' && t.strategy === 'mean_revert') return false
  if (cfg.typeMask !== 'all' && t.type !== cfg.typeMask) return false
  return true
}

function evaluate(trades: (TradeResult | LimitTradeResult)[], cfg: Config): {
  config: Config; trades: number; wins: number; grossR: number; netR: number;
  finalBalance: number; maxDDPct: number; totalFees: number;
  avgGrossR: number; avgNetR: number; sharpeNet: number;
} {
  const filtered = trades.filter(t => tradePassesConfig(t, cfg))
  const startingDeposit = 1000
  const riskPct = 0.01
  let balance = startingDeposit
  let totalFees = 0
  let runningPeak = startingDeposit
  let maxDDPct = 0
  let grossR = 0
  let netR = 0
  let wins = 0
  const netRs: number[] = []

  for (const t of [...filtered].sort((a, b) => a.entryTime - b.entryTime)) {
    const slPct = Math.abs(t.entry - t.initialStop) / t.entry * 100
    const fee = cfg.feeModel === 'all_taker'
      ? feeInR_AllTaker(cfg.leverageCap, slPct)
      : feeInR_Mixed(cfg.leverageCap, slPct, t.exitReason as ExitReason)
    const tradeNet = t.realizedR - fee
    grossR += t.realizedR
    netR += tradeNet
    netRs.push(tradeNet)
    if (t.realizedR > 0) wins++
    const riskUsd = balance * riskPct
    balance += tradeNet * riskUsd
    totalFees += fee * riskUsd
    if (balance > runningPeak) runningPeak = balance
    const dd = (runningPeak - balance) / runningPeak
    if (dd > maxDDPct) maxDDPct = dd
  }

  // Sharpe of net R
  const meanNet = filtered.length > 0 ? netR / filtered.length : 0
  const variance = filtered.length > 0
    ? netRs.reduce((s, r) => s + (r - meanNet) ** 2, 0) / filtered.length
    : 0
  const std = Math.sqrt(variance)
  const sharpeNet = std > 0 ? meanNet / std : 0

  return {
    config: cfg, trades: filtered.length, wins, grossR, netR,
    finalBalance: balance, maxDDPct, totalFees,
    avgGrossR: filtered.length > 0 ? grossR / filtered.length : 0,
    avgNetR: meanNet, sharpeNet,
  }
}

async function main() {
  const symbols = loadTop30Symbols()
  console.log('[Mega] Loading bundles for top-30...')
  const bundles = await loadBundles(symbols, 365, true)
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - 365 * 24 * 3600_000

  console.log('[Mega] Running base run (minScore=60, no other filters)...')
  const base = runWalkforward(bundles, {
    symbols, days: 365, minScore: 60,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })
  console.log(`[Mega] Base: ${base.trades.length} trades`)

  const configs = buildConfigs()
  console.log(`[Mega] Evaluating ${configs.length} configs...`)
  const results = configs.map(c => evaluate(base.trades, c))

  // Sort by final balance descending
  results.sort((a, b) => b.finalBalance - a.finalBalance)

  // Print top 30 + bottom 5
  console.log(`\n=== TOP 30 BY FINAL BALANCE ===`)
  console.log(`  ${'rank'.padStart(4)}  ${'config'.padEnd(58)}  ${'tr'.padStart(4)}  ${'WR'.padStart(4)}  ${'grossR'.padStart(7)}  ${'netR'.padStart(7)}  ${'final'.padStart(7)}  ${'maxDD'.padStart(5)}  ${'sharpeNet'.padStart(8)}`)
  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i]
    const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(0) : '-'
    console.log(`  ${String(i + 1).padStart(4)}  ${r.config.label.padEnd(58)}  ${String(r.trades).padStart(4)}  ${wr.padStart(3)}%  ${r.grossR.toFixed(2).padStart(7)}  ${r.netR.toFixed(2).padStart(7)}  $${r.finalBalance.toFixed(0).padStart(5)}  ${(r.maxDDPct * 100).toFixed(0).padStart(4)}%  ${r.sharpeNet.toFixed(3).padStart(8)}`)
  }
  console.log(`\n=== BOTTOM 5 ===`)
  for (let i = 0; i < 5; i++) {
    const r = results[results.length - 1 - i]
    const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(0) : '-'
    console.log(`        ${r.config.label.padEnd(58)}  ${String(r.trades).padStart(4)}  ${wr.padStart(3)}%  ${r.grossR.toFixed(2).padStart(7)}  ${r.netR.toFixed(2).padStart(7)}  $${r.finalBalance.toFixed(0).padStart(5)}  ${(r.maxDDPct * 100).toFixed(0).padStart(4)}%`)
  }

  // Profitable count
  const profitable = results.filter(r => r.finalBalance > 1000)
  console.log(`\n[Mega] Profitable configs (final > $1000): ${profitable.length}/${results.length}`)

  // Find best by Sharpe (alternative ranking)
  const bySharpe = [...results].sort((a, b) => b.sharpeNet - a.sharpeNet)
  console.log(`\n=== TOP 5 BY NET SHARPE ===`)
  for (let i = 0; i < 5; i++) {
    const r = bySharpe[i]
    const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(0) : '-'
    console.log(`  ${String(i + 1).padStart(4)}  ${r.config.label.padEnd(58)}  ${String(r.trades).padStart(4)}  ${wr.padStart(3)}%  netR=${r.netR.toFixed(2).padStart(7)}  $${r.finalBalance.toFixed(0).padStart(5)}  Sharpe=${r.sharpeNet.toFixed(3)}`)
  }

  // Write JSON
  const out = {
    generatedAt: new Date().toISOString(),
    baseTradeCount: base.trades.length,
    feeTaker: FEE_TAKER,
    feeMaker: FEE_MAKER,
    results: results.map(r => ({
      config: r.config,
      trades: r.trades, wins: r.wins,
      grossR: Math.round(r.grossR * 100) / 100,
      netR: Math.round(r.netR * 100) / 100,
      finalBalance: Math.round(r.finalBalance * 100) / 100,
      maxDDPct: Math.round(r.maxDDPct * 1000) / 1000,
      totalFees: Math.round(r.totalFees * 100) / 100,
      avgGrossR: Math.round(r.avgGrossR * 1000) / 1000,
      avgNetR: Math.round(r.avgNetR * 1000) / 1000,
      sharpeNet: Math.round(r.sharpeNet * 1000) / 1000,
    })),
  }
  const outFile = path.join(OUT_DIR, `scanner_megasweep_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
  console.log(`\nSaved: ${path.relative(process.cwd(), outFile)}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
