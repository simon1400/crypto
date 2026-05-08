/**
 * Quick sanity check: run LIMIT execution on 7 days to confirm the simulator works.
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/quickLimitTest.ts
 */

import 'dotenv/config'
import { loadBundles, runWalkforward, aggregate, STEP_MS } from './backtestCore'
import { LimitTradeResult } from './limitSimulator'

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'NEARUSDT']
  const bundles = await loadBundles(symbols, 30, true)
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - 14 * 24 * 3600_000

  console.log(`\n[QuickLimit] Window: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`)

  const r = runWalkforward(bundles, {
    symbols, days: 14, minScore: 70,
    windowStartMs: windowStart, windowEndMs: windowEnd,
    quiet: true, enableLimitSim: true,
  })
  const m = aggregate(r.trades)
  const limit = r.trades.filter(t => t.executionType.startsWith('LIMIT_'))
  const market = r.trades.filter(t => t.executionType.startsWith('ENTER_NOW'))

  console.log(`\n[QuickLimit] Run finished in ${r.runTimeSec}s`)
  console.log(`  All trades: ${m.totalTrades}, totalR=${m.totalR.toFixed(2)}, WR=${(m.winRate * 100).toFixed(0)}%`)
  console.log(`  Market:     ${market.length} trades, totalR=${market.reduce((s,t)=>s+t.realizedR,0).toFixed(2)}`)
  console.log(`  Limit:      ${limit.length} trades, totalR=${limit.reduce((s,t)=>s+t.realizedR,0).toFixed(2)}`)
  if (limit.length > 0) {
    const avgWait = limit.reduce((s, t) => s + ((t as LimitTradeResult).limitWaitMinutes || 0), 0) / limit.length
    console.log(`  Avg wait time for limit fills: ${avgWait.toFixed(0)}min`)
    for (const t of limit.slice(0, 10)) {
      const lt = t as LimitTradeResult
      console.log(`    ${new Date(lt.entryTime).toISOString().slice(0,16)} ${lt.coin} ${lt.type} ${lt.executionType} fill@${lt.entry.toFixed(4)} (waited ${lt.limitWaitMinutes}min) → ${lt.exitReason} R=${lt.realizedR.toFixed(2)}`)
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
