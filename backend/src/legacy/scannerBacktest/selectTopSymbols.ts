/**
 * Phase 1: Select top-30 Bybit USDT-perps that have at least 365 days of 4h history.
 *
 * Why this script: scanner needs 4h × 200 candles for EMA200, plus 365d of test data,
 * so each symbol must have ≥ (200 + 365×6) = ~2390 4h candles available on Bybit.
 *
 * Output:
 *   1. console table of selected symbols with first-candle date and candle count
 *   2. JSON file at backend/data/backtest/scanner_top30.json
 *
 * Run: cd backend && npx tsx src/scalper/scannerBacktest/selectTopSymbols.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadHistorical } from '../historicalLoader'

const TARGET_COUNT = 30
const CANDIDATE_POOL = 80 // probe top-80 by turnover, keep first 30 with full history
const REQUIRED_DAYS = 365
const WARMUP_4H_BARS = 200 // EMA200 warm-up
const REQUIRED_4H_BARS = WARMUP_4H_BARS + (REQUIRED_DAYS * 24) / 4

const CACHE_DIR = path.join(__dirname, '../../../data/backtest')
const OUTPUT_FILE = path.join(CACHE_DIR, 'scanner_top30.json')
const TICKERS_URL = 'https://api.bybit.com/v5/market/tickers?category=linear'

interface Ticker {
  symbol: string
  turnover24h: string
}

interface SelectedSymbol {
  symbol: string
  turnoverUsd: number
  firstCandleTime: number
  firstCandleDate: string
  candle4hCount: number
}

async function fetchTickers(): Promise<Ticker[]> {
  const res = await fetch(TICKERS_URL)
  if (!res.ok) throw new Error(`Bybit tickers ${res.status}`)
  const json = (await res.json()) as { retCode: number; result: { list: Ticker[] } }
  if (json.retCode !== 0) throw new Error(`Bybit retCode=${json.retCode}`)
  return json.result.list
}

function isPlainPerp(sym: string): boolean {
  if (sym.includes('-')) return false
  if (!sym.endsWith('USDT')) return false
  // Skip 1000X meme leveraged variants — they're aliases
  return true
}

async function probeSymbol(symbol: string): Promise<{ ok: boolean; firstTime: number; count: number }> {
  try {
    const candles = await loadHistorical(symbol, '4h', 14, 'bybit', 'linear')
    if (candles.length === 0) return { ok: false, firstTime: 0, count: 0 }
    const firstTime = candles[0].time
    const ageDays = (Date.now() - firstTime) / (24 * 3600_000)
    const ok = candles.length >= REQUIRED_4H_BARS && ageDays >= REQUIRED_DAYS + 30
    return { ok, firstTime, count: candles.length }
  } catch (err: any) {
    console.warn(`[Select] ${symbol}: probe failed — ${err.message}`)
    return { ok: false, firstTime: 0, count: 0 }
  }
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

  console.log(`[Select] Fetching Bybit tickers...`)
  const tickers = await fetchTickers()
  const candidates = tickers
    .filter(t => isPlainPerp(t.symbol))
    .map(t => ({ symbol: t.symbol, turnover: parseFloat(t.turnover24h) || 0 }))
    .filter(t => t.turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, CANDIDATE_POOL)

  console.log(`[Select] Probing top-${CANDIDATE_POOL} by turnover for 365d 4h history...\n`)
  console.log(`[Select] Required: ≥${REQUIRED_4H_BARS} 4h candles + first candle ≥${REQUIRED_DAYS + 30} days old\n`)

  const selected: SelectedSymbol[] = []

  for (let i = 0; i < candidates.length && selected.length < TARGET_COUNT; i++) {
    const c = candidates[i]
    process.stdout.write(`[${i + 1}/${candidates.length}] ${c.symbol.padEnd(20)} `)
    const probe = await probeSymbol(c.symbol)
    if (probe.ok) {
      const date = new Date(probe.firstTime).toISOString().slice(0, 10)
      console.log(`✓ ${probe.count} 4h candles, since ${date}`)
      selected.push({
        symbol: c.symbol,
        turnoverUsd: c.turnover,
        firstCandleTime: probe.firstTime,
        firstCandleDate: date,
        candle4hCount: probe.count,
      })
    } else {
      const reason = probe.count === 0 ? 'no candles' : `only ${probe.count} candles`
      console.log(`✗ ${reason}`)
    }
    // small pause to be nice to Bybit
    await new Promise(r => setTimeout(r, 300))
  }

  console.log(`\n[Select] Selected ${selected.length} symbols:\n`)
  console.log('Rank  Symbol               Turnover($M)  First candle  4h count')
  console.log('────  ───────────────────  ────────────  ────────────  ────────')
  selected.forEach((s, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)}  ${s.symbol.padEnd(19)}  ${(s.turnoverUsd / 1_000_000).toFixed(1).padStart(12)}  ${s.firstCandleDate}    ${s.candle4hCount}`,
    )
  })

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        selectedAt: new Date().toISOString(),
        symbols: selected,
        config: { targetCount: TARGET_COUNT, requiredDays: REQUIRED_DAYS, required4hBars: REQUIRED_4H_BARS },
      },
      null,
      2,
    ),
  )
  console.log(`\n[Select] Saved to ${OUTPUT_FILE}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
