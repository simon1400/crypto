/**
 * Compare real scanner trades from production DB vs backtest simulation
 * over the same time window. This is the ground-truth check on whether
 * the bektest's negative USDT P&L is real or an artifact.
 *
 * Input: /tmp/real_trades.txt (export from VPS, see preceding command)
 * Output: comparison table + verdict.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/compareRealVsBacktest.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import {
  loadBundles, runWalkforward, loadTop30Symbols,
  STEP_MS,
} from './backtestCore'
import { TradeResult } from './tradeSimulator'

interface RealTrade {
  id: number
  coin: string             // BTCUSDT
  type: 'LONG' | 'SHORT'
  source: string
  leverage: number
  entryPrice: number
  amount: number           // margin USDT
  stopLoss: number
  initialStop: number
  status: string
  realizedPnl: number      // USDT, gross of fees
  closedPct: number
  fees: number
  createdAt: number        // ms
  closedAt: number | null  // ms
  notes: string
  score: number | null
  strategy: string | null
}

const REAL_TRADES_FILE = '/tmp/real_trades.txt'

function parseRealTrades(): RealTrade[] {
  const text = fs.readFileSync(REAL_TRADES_FILE, 'utf-8')
  const lines = text.trim().split('\n').slice(1) // skip header
  const rows: RealTrade[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const f = line.split('|')
    if (f.length < 16) continue
    const notes = f[15] || ''
    const scoreMatch = notes.match(/Score:\s*(\d+)/)
    const stratMatch = notes.match(/\|\s*(trend_follow|breakout|mean_revert)\s*\|/)
    rows.push({
      id: parseInt(f[0]),
      coin: f[1],
      type: f[2] as 'LONG' | 'SHORT',
      source: f[3],
      leverage: parseInt(f[4]),
      entryPrice: parseFloat(f[5]),
      amount: parseFloat(f[6]),
      stopLoss: parseFloat(f[7]),
      initialStop: parseFloat(f[8]) || parseFloat(f[7]),
      status: f[9],
      realizedPnl: parseFloat(f[10]),
      closedPct: parseFloat(f[11]),
      fees: parseFloat(f[12]),
      createdAt: Date.parse(f[13]),
      closedAt: f[14] ? Date.parse(f[14]) : null,
      notes,
      score: scoreMatch ? parseInt(scoreMatch[1]) : null,
      strategy: stratMatch ? stratMatch[1] : null,
    })
  }
  return rows
}

function compute_R(rt: RealTrade): number {
  // Convert realizedPnl USDT into R-multiple using initialStop
  // riskAbsPrice = |entryPrice - initialStop|
  // sizeBaseUnits = amount * leverage / entryPrice
  // riskUsd = riskAbsPrice * sizeBaseUnits = amount * leverage * |1 - initialStop/entryPrice|
  // R = realizedPnl / riskUsd
  const riskFraction = Math.abs(rt.entryPrice - rt.initialStop) / rt.entryPrice
  const riskUsd = rt.amount * rt.leverage * riskFraction
  if (riskUsd <= 0) return 0
  return rt.realizedPnl / riskUsd
}

async function main() {
  // Step 1: parse real trades
  const real = parseRealTrades()
  console.log(`[Compare] Parsed ${real.length} real trades`)
  const dates = real.map(t => t.createdAt)
  const minDate = Math.min(...dates)
  const maxDate = Math.max(...dates)
  console.log(`[Compare] Real trades period: ${new Date(minDate).toISOString().slice(0, 10)} → ${new Date(maxDate).toISOString().slice(0, 10)}`)
  console.log()

  // Step 2: real trades summary
  const realClosed = real.filter(t => t.status === 'CLOSED' || t.status === 'SL_HIT')
  const realPartial = real.filter(t => t.status === 'PARTIALLY_CLOSED')
  const realOpen = real.filter(t => t.status === 'OPEN')
  const totalPnlClosed = realClosed.reduce((s, t) => s + t.realizedPnl, 0)
  const totalFeesClosed = realClosed.reduce((s, t) => s + t.fees, 0)
  const realRMults = realClosed.map(t => compute_R(t))
  const totalR = realRMults.reduce((s, r) => s + r, 0)
  const wins = realRMults.filter(r => r > 0).length

  console.log(`=== REAL TRADES (production DB) ===`)
  console.log(`  Closed/SL_HIT:     ${realClosed.length}`)
  console.log(`  Partially closed:  ${realPartial.length}`)
  console.log(`  Open:              ${realOpen.length}`)
  console.log(`  Total realized PnL (gross): $${totalPnlClosed.toFixed(2)}`)
  console.log(`  Total fees paid:            $${totalFeesClosed.toFixed(2)}`)
  console.log(`  Net (after fees):           $${(totalPnlClosed - totalFeesClosed).toFixed(2)}`)
  console.log(`  Total R (closed only):      ${totalR.toFixed(2)}`)
  console.log(`  Win rate:                   ${realClosed.length > 0 ? ((wins / realClosed.length) * 100).toFixed(1) : '?'}% (${wins}/${realClosed.length})`)
  console.log(`  Avg R per closed trade:     ${realClosed.length > 0 ? (totalR / realClosed.length).toFixed(3) : '?'}`)

  // By strategy
  const byStrat: Record<string, { n: number; pnl: number; r: number; wins: number }> = {}
  for (const t of realClosed) {
    const s = t.strategy || 'unknown'
    if (!byStrat[s]) byStrat[s] = { n: 0, pnl: 0, r: 0, wins: 0 }
    byStrat[s].n++
    byStrat[s].pnl += t.realizedPnl
    const tr = compute_R(t)
    byStrat[s].r += tr
    if (tr > 0) byStrat[s].wins++
  }
  console.log(`\n  By strategy:`)
  for (const [s, v] of Object.entries(byStrat).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`    ${s.padEnd(14)} n=${String(v.n).padStart(3)} pnl=$${v.pnl.toFixed(2).padStart(7)} totalR=${v.r.toFixed(2).padStart(7)} WR=${((v.wins / v.n) * 100).toFixed(0)}% avgR=${(v.r / v.n).toFixed(3)}`)
  }

  // By type
  const byType: Record<string, { n: number; pnl: number; r: number; wins: number }> = {}
  for (const t of realClosed) {
    if (!byType[t.type]) byType[t.type] = { n: 0, pnl: 0, r: 0, wins: 0 }
    byType[t.type].n++
    byType[t.type].pnl += t.realizedPnl
    const tr = compute_R(t)
    byType[t.type].r += tr
    if (tr > 0) byType[t.type].wins++
  }
  console.log(`\n  By type:`)
  for (const [s, v] of Object.entries(byType).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`    ${s.padEnd(14)} n=${String(v.n).padStart(3)} pnl=$${v.pnl.toFixed(2).padStart(7)} totalR=${v.r.toFixed(2).padStart(7)} WR=${((v.wins / v.n) * 100).toFixed(0)}% avgR=${(v.r / v.n).toFixed(3)}`)
  }

  // By score band
  const byBand: Record<string, { n: number; pnl: number; r: number; wins: number }> = {}
  for (const t of realClosed) {
    const sc = t.score || 0
    const band = sc >= 80 ? '80+' : sc >= 70 ? '70-79' : sc >= 60 ? '60-69' : '<60'
    if (!byBand[band]) byBand[band] = { n: 0, pnl: 0, r: 0, wins: 0 }
    byBand[band].n++
    byBand[band].pnl += t.realizedPnl
    const tr = compute_R(t)
    byBand[band].r += tr
    if (tr > 0) byBand[band].wins++
  }
  console.log(`\n  By score band:`)
  for (const [s, v] of Object.entries(byBand).sort((a, b) => b[1].r - a[1].r)) {
    console.log(`    ${s.padEnd(8)} n=${String(v.n).padStart(3)} pnl=$${v.pnl.toFixed(2).padStart(7)} totalR=${v.r.toFixed(2).padStart(7)} WR=${((v.wins / v.n) * 100).toFixed(0)}% avgR=${(v.r / v.n).toFixed(3)}`)
  }

  // Step 3: run backtest on the same window for comparison
  console.log(`\n\n=== BACKTEST on same window ===`)
  const symbols = loadTop30Symbols()
  // Pad start by 1 day to allow backtest snapshot
  const windowStart = Math.floor(minDate / STEP_MS) * STEP_MS
  const windowEnd = Math.ceil(maxDate / STEP_MS) * STEP_MS
  const days = Math.ceil((windowEnd - windowStart) / (24 * 3600_000))
  console.log(`  Window: ${new Date(windowStart).toISOString().slice(0, 10)} → ${new Date(windowEnd).toISOString().slice(0, 10)}`)
  console.log(`  Days: ${days}`)

  const bundles = await loadBundles(symbols, days + 60, true) // bigger load for warm-up
  const r = runWalkforward(bundles, {
    symbols, days, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd, quiet: true,
  })

  const bk = r.trades
  const bkR = bk.reduce((s, t) => s + t.realizedR, 0)
  const bkWins = bk.filter(t => t.realizedR > 0).length
  console.log(`\n  Backtest trades: ${bk.length}`)
  console.log(`  Total R:         ${bkR.toFixed(2)}`)
  console.log(`  Win rate:        ${bk.length > 0 ? ((bkWins / bk.length) * 100).toFixed(1) : '?'}% (${bkWins}/${bk.length})`)
  console.log(`  Avg R:           ${bk.length > 0 ? (bkR / bk.length).toFixed(3) : '?'}`)

  // Backtest by strategy
  const bkStrat: Record<string, { n: number; r: number; wins: number }> = {}
  for (const t of bk) {
    if (!bkStrat[t.strategy]) bkStrat[t.strategy] = { n: 0, r: 0, wins: 0 }
    bkStrat[t.strategy].n++
    bkStrat[t.strategy].r += t.realizedR
    if (t.realizedR > 0) bkStrat[t.strategy].wins++
  }
  console.log(`\n  By strategy (backtest):`)
  for (const [s, v] of Object.entries(bkStrat).sort((a, b) => b[1].r - a[1].r)) {
    console.log(`    ${s.padEnd(14)} n=${String(v.n).padStart(3)} totalR=${v.r.toFixed(2).padStart(7)} WR=${((v.wins / v.n) * 100).toFixed(0)}% avgR=${(v.r / v.n).toFixed(3)}`)
  }

  // Step 4: side-by-side comparison
  console.log(`\n\n=== HEAD-TO-HEAD ===`)
  console.log(`                          REAL              BACKTEST`)
  console.log(`  Trades:                ${String(realClosed.length).padStart(4)} closed         ${String(bk.length).padStart(4)} simulated`)
  console.log(`  Total R:               ${totalR.toFixed(2).padStart(7)}              ${bkR.toFixed(2).padStart(7)}`)
  console.log(`  Avg R:                 ${(totalR / Math.max(1, realClosed.length)).toFixed(3).padStart(7)}              ${(bkR / Math.max(1, bk.length)).toFixed(3).padStart(7)}`)
  console.log(`  WR:                    ${((wins / Math.max(1, realClosed.length)) * 100).toFixed(0).padStart(5)}%               ${((bkWins / Math.max(1, bk.length)) * 100).toFixed(0).padStart(5)}%`)
  console.log(`  Total $PnL (gross):   $${totalPnlClosed.toFixed(2).padStart(7)}              N/A (R only)`)
  console.log(`  Total $PnL (net):     $${(totalPnlClosed - totalFeesClosed).toFixed(2).padStart(7)}              N/A`)

  // ID-level matching: which real trades had a corresponding backtest signal
  console.log(`\n\n=== TRADE-LEVEL MATCHING ===`)
  console.log(`(For each real trade, check if backtest produced a signal on the same coin within ±2 hours)`)
  let matched = 0
  let unmatched = 0
  const matchedRows: { real: RealTrade; bk: TradeResult; diff: { rDelta: number } }[] = []
  for (const rt of realClosed) {
    const realCoinBase = rt.coin.replace(/USDT$/, '')
    const matches = bk.filter(b =>
      b.coin === realCoinBase &&
      b.type === rt.type &&
      Math.abs(b.entryTime - rt.createdAt) < 2 * 3600_000,
    )
    if (matches.length > 0) {
      matched++
      const rR = compute_R(rt)
      const closest = matches.reduce((best, cur) =>
        Math.abs(cur.entryTime - rt.createdAt) < Math.abs(best.entryTime - rt.createdAt) ? cur : best,
      )
      matchedRows.push({ real: rt, bk: closest, diff: { rDelta: rR - closest.realizedR } })
    } else {
      unmatched++
    }
  }
  console.log(`  Real trades matched to backtest signals: ${matched} / ${realClosed.length}`)
  console.log(`  Unmatched real trades:                   ${unmatched}`)
  console.log(`    (Reasons: coin not in top-30, hard filter blocked in BT, or different score)`)

  if (matchedRows.length > 0) {
    const avgDelta = matchedRows.reduce((s, m) => s + m.diff.rDelta, 0) / matchedRows.length
    const realBetter = matchedRows.filter(m => m.diff.rDelta > 0.1).length
    const btBetter = matchedRows.filter(m => m.diff.rDelta < -0.1).length
    const similar = matchedRows.length - realBetter - btBetter
    console.log(`\n  Per-trade R difference (real - backtest), n=${matchedRows.length}:`)
    console.log(`    avg R delta:    ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(3)}`)
    console.log(`    real better:    ${realBetter}`)
    console.log(`    backtest better: ${btBetter}`)
    console.log(`    similar (±0.1): ${similar}`)

    console.log(`\n  Top 10 cases where real outperformed backtest:`)
    const top = [...matchedRows].sort((a, b) => b.diff.rDelta - a.diff.rDelta).slice(0, 10)
    for (const m of top) {
      const realR = compute_R(m.real)
      console.log(`    ${m.real.coin.padEnd(15)} ${m.real.type} score=${m.real.score} | real R=${realR.toFixed(2).padStart(5)} (status=${m.real.status}, partial=${m.real.closedPct}%) vs BT R=${m.bk.realizedR.toFixed(2).padStart(5)} (${m.bk.exitReason})`)
    }
    console.log(`\n  Top 10 cases where backtest outperformed real:`)
    const bot = [...matchedRows].sort((a, b) => a.diff.rDelta - b.diff.rDelta).slice(0, 10)
    for (const m of bot) {
      const realR = compute_R(m.real)
      console.log(`    ${m.real.coin.padEnd(15)} ${m.real.type} score=${m.real.score} | real R=${realR.toFixed(2).padStart(5)} (status=${m.real.status}, partial=${m.real.closedPct}%) vs BT R=${m.bk.realizedR.toFixed(2).padStart(5)} (${m.bk.exitReason})`)
    }
  }

  // Save full comparison
  const outFile = '/tmp/scanner_real_vs_bk.json'
  fs.writeFileSync(outFile, JSON.stringify({
    real: { trades: real.length, closed: realClosed.length, totalPnl: totalPnlClosed, totalFees: totalFeesClosed, totalR, wins },
    backtest: { trades: bk.length, totalR: bkR, wins: bkWins },
    matchedRows: matchedRows.map(m => ({
      coin: m.real.coin, type: m.real.type, score: m.real.score,
      realR: compute_R(m.real), bkR: m.bk.realizedR,
      delta: m.diff.rDelta, realPnl: m.real.realizedPnl,
      realStatus: m.real.status, realClosedPct: m.real.closedPct,
      bkExitReason: m.bk.exitReason,
    })),
  }, null, 2))
  console.log(`\nSaved: ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
