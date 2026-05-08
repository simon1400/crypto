/**
 * Phase 2 smoke test:
 *   - Top-5 of top-30: BTC, ETH, SOL, XRP, DOGE
 *   - Last 7 days of history
 *   - Step 12 minutes (matches autoScanner)
 *   - Min score 70
 *
 * Goal: validate that the engine produces signals end-to-end and that
 * trade simulation works. Output trade list and basic stats.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/smokeTest.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadHistorical } from '../historicalLoader'
import { loadFundingHistory, fundingAt, FundingPoint } from '../fundingLoader'
import { buildSnapshot, buildBtcRegime, scoreSymbolAt, SymbolHistoricalData } from './historicalScannerEngine'
import { simulateTrade, TradeResult } from './tradeSimulator'

const SMOKE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']
const DAYS = 7
const STEP_MS = 12 * 60_000
const DEDUPE_WINDOW_MS = 2 * 3600_000
const MIN_SCORE = 70

const OUT_DIR = path.join(__dirname, '../../../data/backtest')

async function main() {
  console.log(`[Smoke] Loading ${SMOKE_SYMBOLS.length} symbols...`)
  const months = Math.ceil(DAYS / 30) + 2

  const bundles = new Map<string, { data: SymbolHistoricalData; funding: FundingPoint[] }>()
  for (const sym of SMOKE_SYMBOLS) {
    const t0 = Date.now()
    const [c5, c15, c1h, c4h, funding] = await Promise.all([
      loadHistorical(sym, '5m', months, 'bybit', 'linear'),
      loadHistorical(sym, '15m', months, 'bybit', 'linear'),
      loadHistorical(sym, '1h', months, 'bybit', 'linear'),
      loadHistorical(sym, '4h', months, 'bybit', 'linear'),
      loadFundingHistory(sym, DAYS + 30),
    ])
    bundles.set(sym, {
      data: { candles5m: c5, candles15m: c15, candles1h: c1h, candles4h: c4h },
      funding,
    })
    console.log(`  ${sym}: 5m=${c5.length}, 15m=${c15.length}, 1h=${c1h.length}, 4h=${c4h.length}, funding=${funding.length} — ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  const btc = bundles.get('BTCUSDT')!
  const now = Date.now()
  const windowEnd = Math.floor((now - 3600_000) / STEP_MS) * STEP_MS
  const windowStart = windowEnd - DAYS * 24 * 3600_000
  console.log(`\n[Smoke] Window: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`)

  const trades: TradeResult[] = []
  const lastEntry = new Map<string, number>()
  let totalSignals = 0
  let stepsProcessed = 0
  const totalSteps = Math.floor((windowEnd - windowStart) / STEP_MS)

  const t0 = Date.now()
  for (let T = windowStart; T <= windowEnd; T += STEP_MS) {
    stepsProcessed++
    const btcSnap = buildSnapshot(btc.data, T)
    if (!btcSnap) continue
    const regime = buildBtcRegime(btc.data, T)

    for (const sym of SMOKE_SYMBOLS) {
      const b = bundles.get(sym)!
      const fnFunding = (ms: number) => fundingAt(b.funding, ms)
      let enriched
      try {
        enriched = scoreSymbolAt(sym.replace(/USDT$/, ''), b.data, T, {
          regime, btcSnapshot: btcSnap, fundingAt: fnFunding,
        })
      } catch (err: any) {
        console.warn(`  [error] ${sym} at ${new Date(T).toISOString()}: ${err.message}`)
        continue
      }
      if (!enriched) continue
      if (!enriched.hard_filter.passed) continue
      if (enriched.category === 'IGNORE') continue
      if (enriched.setup_score < MIN_SCORE) continue
      if (enriched.execution_type !== 'ENTER_NOW_LONG' && enriched.execution_type !== 'ENTER_NOW_SHORT') continue

      totalSignals++

      const key = `${enriched.coin}|${enriched.type}`
      if (lastEntry.has(key) && T - lastEntry.get(key)! < DEDUPE_WINDOW_MS) continue
      lastEntry.set(key, T)

      const futureIdx = b.data.candles5m.findIndex(c => c.time >= T)
      if (futureIdx < 0) continue
      const result = simulateTrade(enriched, b.data.candles5m.slice(futureIdx), T)
      trades.push(result)

      console.log(
        `  [${new Date(T).toISOString().slice(0, 16)}] ${enriched.coin} ${enriched.type} ${enriched.strategy} score=${enriched.setup_score} ${enriched.category} ${enriched.execution_type} → ${result.exitReason} R=${result.realizedR.toFixed(2)} (${result.holdingHours}h)`,
      )
    }
  }

  console.log(`\n[Smoke] Steps processed: ${stepsProcessed}/${totalSteps}`)
  console.log(`[Smoke] Signals matched (after gates): ${totalSignals}`)
  console.log(`[Smoke] Trades after dedupe: ${trades.length}`)
  console.log(`[Smoke] Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  if (trades.length > 0) {
    const totalR = trades.reduce((s, t) => s + t.realizedR, 0)
    const wins = trades.filter(t => t.realizedR > 0).length
    console.log(`\n[Smoke] Total R: ${totalR.toFixed(2)}`)
    console.log(`[Smoke] Win rate: ${((wins / trades.length) * 100).toFixed(1)}% (${wins}/${trades.length})`)
    console.log(`[Smoke] Avg R/trade: ${(totalR / trades.length).toFixed(3)}`)

    const byStrat: Record<string, { n: number; r: number }> = {}
    for (const t of trades) {
      if (!byStrat[t.strategy]) byStrat[t.strategy] = { n: 0, r: 0 }
      byStrat[t.strategy].n++
      byStrat[t.strategy].r += t.realizedR
    }
    console.log(`\n[Smoke] By strategy:`)
    for (const [k, v] of Object.entries(byStrat)) {
      console.log(`  ${k.padEnd(15)} n=${v.n}, totalR=${v.r.toFixed(2)}, avgR=${(v.r / v.n).toFixed(3)}`)
    }
  }

  const outFile = path.join(OUT_DIR, `scanner_smoke_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ trades, totalSignals }, null, 2))
  console.log(`\n[Smoke] Saved to ${outFile}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
