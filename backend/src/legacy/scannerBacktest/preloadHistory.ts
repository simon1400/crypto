/**
 * Phase 1.3: Pre-download all timeframes (5m / 15m / 1h / 4h) for the 30 selected symbols.
 *
 * 4h is already cached from selectTopSymbols.ts. This script tops up the rest.
 *
 * Storage estimate (per symbol, 14 months):
 *   5m  ≈ 122k candles  ≈ 12 MB
 *   15m ≈ 41k  candles  ≈ 4 MB
 *   1h  ≈ 10k  candles  ≈ 1 MB
 *   4h  ≈ 2.5k candles  ≈ 0.3 MB
 *
 * Total: ~17 MB × 30 = ~500 MB. Most of the time is spent on 5m.
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/preloadHistory.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadHistorical } from '../historicalLoader'
import { loadFundingHistory } from '../fundingLoader'

const TOP30_FILE = path.join(__dirname, '../../../data/backtest/scanner_top30.json')
const MONTHS_BACK = 14
const INTERVALS: ('5m' | '15m' | '1h' | '4h')[] = ['1h', '15m', '5m'] // 4h already cached
const FUNDING_DAYS = 400 // covers 365d + buffer

interface SymbolEntry {
  symbol: string
  turnoverUsd: number
  firstCandleDate: string
  candle4hCount: number
}

async function main() {
  if (!fs.existsSync(TOP30_FILE)) {
    throw new Error(`Top30 file not found: ${TOP30_FILE}. Run selectTopSymbols.ts first.`)
  }

  const data = JSON.parse(fs.readFileSync(TOP30_FILE, 'utf-8'))
  const symbols: SymbolEntry[] = data.symbols
  console.log(`[Preload] Loading ${symbols.length} symbols × ${INTERVALS.length} intervals + funding\n`)

  const startTime = Date.now()
  let completed = 0
  const failed: { symbol: string; interval: string; error: string }[] = []

  for (const s of symbols) {
    completed++
    console.log(`\n[Preload] [${completed}/${symbols.length}] ${s.symbol}`)
    for (const interval of INTERVALS) {
      try {
        const t0 = Date.now()
        const candles = await loadHistorical(s.symbol, interval, MONTHS_BACK, 'bybit', 'linear')
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`  ${interval}: ${candles.length} candles in ${elapsed}s`)
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        console.warn(`  ${interval}: FAILED — ${msg}`)
        failed.push({ symbol: s.symbol, interval, error: msg })
      }
    }
    // funding
    try {
      const t0 = Date.now()
      const points = await loadFundingHistory(s.symbol, FUNDING_DAYS)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  funding: ${points.length} points in ${elapsed}s`)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      console.warn(`  funding: FAILED — ${msg}`)
      failed.push({ symbol: s.symbol, interval: 'funding', error: msg })
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 60_000).toFixed(1)
  console.log(`\n[Preload] Done in ${totalElapsed}min. Failures: ${failed.length}`)
  if (failed.length > 0) {
    console.log('\nFailures:')
    failed.forEach(f => console.log(`  ${f.symbol} ${f.interval}: ${f.error}`))
  }
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
