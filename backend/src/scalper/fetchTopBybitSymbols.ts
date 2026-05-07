/**
 * Fetch top-N Bybit USDT-linear perps by 24h turnover and download 5m×365d history.
 *
 * Output: cached files in data/backtest/bybit_<SYMBOL>_5m.json
 *
 * Filters out:
 *   - Dated futures (BTC-08MAY26 etc) — only keep plain USDT perps
 *   - Symbols already cached (skip refetch unless --force)
 *
 * Run: cd backend && npx tsx src/scalper/fetchTopBybitSymbols.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { loadHistorical } from './historicalLoader'

const TOP_N = 150
const MONTHS_BACK = 14   // covers 365d + buffer used by backtest
const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const TICKERS_URL = 'https://api.bybit.com/v5/market/tickers?category=linear'

interface Ticker {
  symbol: string
  lastPrice: string
  turnover24h: string
  volume24h: string
}

async function fetchTickers(): Promise<Ticker[]> {
  const res = await fetch(TICKERS_URL)
  if (!res.ok) throw new Error(`Bybit tickers ${res.status}`)
  const json = (await res.json()) as { retCode: number; retMsg: string; result: { list: Ticker[] } }
  if (json.retCode !== 0) throw new Error(`Bybit retCode=${json.retCode} ${json.retMsg}`)
  return json.result.list
}

function isPlainPerp(sym: string): boolean {
  // Skip dated futures: contain a dash like BTC-08MAY26 / ETH-25DEC26 etc.
  if (sym.includes('-')) return false
  // Must end with USDT
  if (!sym.endsWith('USDT')) return false
  return true
}

function alreadyCached(symbol: string): boolean {
  const p = path.join(CACHE_DIR, `bybit_${symbol}_5m.json`)
  return fs.existsSync(p)
}

async function main() {
  const force = process.argv.includes('--force')
  console.log(`[TopFetch] Fetching Bybit linear tickers...`)
  const tickers = await fetchTickers()
  console.log(`[TopFetch] Got ${tickers.length} tickers total`)

  const perps = tickers
    .filter(t => isPlainPerp(t.symbol))
    .map(t => ({ symbol: t.symbol, turnover: parseFloat(t.turnover24h) || 0 }))
    .filter(t => t.turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, TOP_N)

  console.log(`[TopFetch] Top ${TOP_N} plain USDT perps by 24h turnover:`)
  for (let i = 0; i < Math.min(20, perps.length); i++) {
    console.log(`  ${(i + 1).toString().padStart(3)}. ${perps[i].symbol.padEnd(20)} $${(perps[i].turnover / 1_000_000).toFixed(1)}M`)
  }
  console.log(`  ... (${perps.length - 20} more)`)

  const toFetch = force ? perps : perps.filter(p => !alreadyCached(p.symbol))
  const cached = perps.length - toFetch.length
  console.log()
  console.log(`[TopFetch] Already cached: ${cached}, to fetch: ${toFetch.length}`)
  if (toFetch.length === 0) {
    console.log('[TopFetch] Nothing to do.')
    return
  }

  async function fetchPass(symbols: string[], passLabel: string): Promise<{ ok: number; failed: string[] }> {
    let ok = 0
    const failed: string[] = []
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]
      console.log(`\n[TopFetch ${passLabel}] [${i + 1}/${symbols.length}] ${sym}`)
      try {
        const candles = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
        console.log(`[TopFetch] ${sym} OK — ${candles.length} candles`)
        ok++
      } catch (e: any) {
        console.warn(`[TopFetch] ${sym} FAILED: ${e?.message ?? e}`)
        failed.push(sym)
      }
      // small pause between symbols to spread load
      await new Promise((r) => setTimeout(r, 500))
    }
    return { ok, failed }
  }

  const pass1 = await fetchPass(toFetch.map(p => p.symbol), 'pass1')
  let totalOk = pass1.ok
  let stillFailed = pass1.failed

  if (stillFailed.length > 0) {
    console.log(`\n[TopFetch] Pass 1 failed (${stillFailed.length}): ${stillFailed.join(', ')}`)
    console.log(`[TopFetch] Cooling down 30s before retry pass...`)
    await new Promise((r) => setTimeout(r, 30_000))
    const pass2 = await fetchPass(stillFailed, 'pass2')
    totalOk += pass2.ok
    stillFailed = pass2.failed
  }

  console.log(`\n[TopFetch] Done. OK=${totalOk}/${toFetch.length}`)
  if (stillFailed.length) {
    console.log(`[TopFetch] Final failed: ${stillFailed.join(', ')}`)
  }

  // Final cache summary
  const allCached = fs.readdirSync(CACHE_DIR)
    .filter(f => /^bybit_.+_5m\.json$/.test(f))
    .length
  console.log(`[TopFetch] Total 5m caches now: ${allCached}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
