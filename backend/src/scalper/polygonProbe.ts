/**
 * Quick probe: check what Polygon free plan allows.
 * Tests a small fetch (1 day of 5m bars) for each candidate ticker.
 */

import 'dotenv/config'
import { loadPolygonHistorical } from './polygonLoader'

const TICKERS = [
  // forex
  { symbol: 'C:XAGUSD', label: 'XAG/USD silver' },
  { symbol: 'C:XAUUSD', label: 'XAU/USD gold (sanity check vs TwelveData)' },
  // ETFs (stocks API)
  { symbol: 'SPY', label: 'SPY ETF (S&P 500 proxy)' },
  { symbol: 'QQQ', label: 'QQQ ETF (Nasdaq 100 proxy)' },
  { symbol: 'USO', label: 'USO ETF (WTI crude oil proxy)' },
  // Indexes (likely paid)
  { symbol: 'I:SPX', label: 'SPX index (likely paid)' },
]

async function probe(symbol: string, label: string): Promise<{ symbol: string; status: 'ok' | 'fail'; detail: string }> {
  try {
    // Just request 1 day to keep it small
    const candles = await loadPolygonHistorical(symbol, '5m', 0.05) // ~1.5 days
    if (candles.length === 0) {
      return { symbol, status: 'fail', detail: 'no candles returned' }
    }
    const first = new Date(candles[0].time).toISOString()
    const last = new Date(candles[candles.length - 1].time).toISOString()
    return { symbol, status: 'ok', detail: `${candles.length} candles, ${first} → ${last}` }
  } catch (e: any) {
    return { symbol, status: 'fail', detail: e.message }
  }
}

async function main() {
  if (!process.env.POLYGON_API_KEY) {
    console.error('POLYGON_API_KEY missing in .env')
    process.exit(1)
  }
  console.log(`Polygon API key: ${process.env.POLYGON_API_KEY.slice(0, 8)}... (${process.env.POLYGON_API_KEY.length} chars)\n`)

  for (const t of TICKERS) {
    console.log(`\n--- ${t.symbol} (${t.label}) ---`)
    const r = await probe(t.symbol, t.label)
    if (r.status === 'ok') {
      console.log(`✅ OK: ${r.detail}`)
    } else {
      console.log(`❌ FAIL: ${r.detail}`)
    }
  }

  console.log('\n=== SUMMARY ===')
  console.log('Tickers that succeeded → can be used for full backtest.')
  console.log('Tickers with 403 error → require paid plan.')
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
