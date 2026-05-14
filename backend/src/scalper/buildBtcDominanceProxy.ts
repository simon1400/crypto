/**
 * Build BTC.D proxy from cached 5m candles + current CoinGecko supplies.
 *
 * Why proxy?
 *   - CoinGecko free API не отдаёт historical total market cap (PRO only)
 *   - TradingView CSV export платный
 *
 * Method:
 *   1. Fetch current circulating supply for top-15 non-stablecoins from CoinGecko
 *      (circulating_supply меняется медленно — BTC ~+1.7%/yr, остальные похоже)
 *   2. Use cached 5m candles aggregated to daily for price history
 *   3. market_cap_proxy[day] = price[day] × current_supply
 *   4. BTC.D_proxy[day] = BTC_mcap / sum(all top-15 mcaps) × 100
 *
 * Accuracy:
 *   - Реальная BTC.D = BTC_mcap / total_mcap (включая стейблкоины)
 *   - Stables ~15-20% от total, относительно стабильны
 *   - Наш proxy исключает stables → BTC.D_proxy = ~1.2× реальной
 *   - RELATIVE движения (наши signals!) идентичны реальной BTC.D
 *
 * Output: backend/data/btc_dominance.csv
 *   time,close
 *
 * Run: cd backend && npx tsx src/scalper/buildBtcDominanceProxy.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'

const MONTHS_BACK = 14
const DAYS_BACK = 365
const BUFFER_DAYS = 60

// Top-15 non-stablecoin по market cap rank (на 2026-05-13).
// HYPE добавлен (новый top-10), исключены: USDT, USDC, USDS, DAI, USDE, LEO (exchange token).
const TOP_COINS = [
  'BTC', 'ETH', 'BNB', 'XRP', 'SOL',
  'TRX', 'DOGE', 'ADA', 'HYPE', 'LINK',
  'BCH', 'AVAX', 'TON', 'LTC', 'XMR',
]

const COIN_GECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', XRP: 'ripple', SOL: 'solana',
  TRX: 'tron', DOGE: 'dogecoin', ADA: 'cardano', HYPE: 'hyperliquid', LINK: 'chainlink',
  BCH: 'bitcoin-cash', AVAX: 'avalanche-2', TON: 'the-open-network', LTC: 'litecoin', XMR: 'monero',
}

const OUT_CSV = path.join(__dirname, '../../data/btc_dominance.csv')
const CACHE_DIR = path.join(__dirname, '../../data/backtest')

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mToDaily(m5: OHLCV[]): OHLCV[] {
  const bucketMs = 24 * 3600_000
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const b = Math.floor(c.time / bucketMs) * bucketMs
    const list = buckets.get(b) ?? []
    list.push(c); buckets.set(b, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t, open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

async function fetchCurrentSupplies(): Promise<Record<string, number>> {
  const ids = TOP_COINS.map(c => COIN_GECKO_IDS[c]).filter(Boolean)
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&per_page=${ids.length}&page=1`
  console.log(`Fetching supplies from CoinGecko (${ids.length} coins)...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${await res.text()}`)
  const data = await res.json() as Array<{ symbol: string; circulating_supply: number; market_cap: number }>
  const out: Record<string, number> = {}
  for (const c of data) {
    out[c.symbol.toUpperCase()] = c.circulating_supply
  }
  return out
}

async function main() {
  console.log('Build BTC.D proxy from cached 5m candles')
  console.log(`Top-${TOP_COINS.length} non-stablecoin universe: ${TOP_COINS.join(', ')}\n`)

  const supplies = await fetchCurrentSupplies()
  console.log('Current circulating supplies:')
  let currentMcapTotal = 0
  for (const sym of TOP_COINS) {
    const supply = supplies[sym]
    if (!supply) { console.warn(`  ${sym}: SUPPLY MISSING (skipping)`); continue }
    console.log(`  ${sym.padEnd(6)}: ${supply.toExponential(3)}`)
  }
  console.log()

  // Load daily candles
  console.log('Loading daily candles from 5m cache...')
  const dailyBySymbol = new Map<string, OHLCV[]>()
  for (const sym of TOP_COINS) {
    const pair = `${sym}USDT`
    const cp = path.join(CACHE_DIR, `bybit_${pair}_5m.json`)
    if (!fs.existsSync(cp)) {
      console.warn(`  ${pair}: NO CACHE — skipping`)
      continue
    }
    const m5all = await loadHistorical(pair, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 100) { console.warn(`  ${pair}: too few candles (${m5.length})`); continue }
    const daily = aggregate5mToDaily(m5)
    dailyBySymbol.set(sym, daily)
    console.log(`  ${pair}: ${daily.length} daily bars`)
  }
  console.log()

  // Build BTC.D series по дням
  // Найдём общий диапазон дат — берём пересечение
  let allDays = new Set<number>()
  for (const [sym, daily] of dailyBySymbol.entries()) {
    if (sym === 'BTC') {
      for (const d of daily) allDays.add(d.time)
    }
  }
  console.log(`BTC daily range: ${allDays.size} days`)

  const sortedDays = [...allDays].sort((a, b) => a - b)
  const btcDomSeries: { time: number; close: number }[] = []

  for (const day of sortedDays) {
    let btcMcap = 0
    let totalMcap = 0
    for (const sym of TOP_COINS) {
      const daily = dailyBySymbol.get(sym)
      if (!daily) continue
      const candle = daily.find(c => c.time === day)
      if (!candle) continue
      const supply = supplies[sym]
      if (!supply) continue
      const mcap = candle.close * supply
      if (sym === 'BTC') btcMcap = mcap
      totalMcap += mcap
    }
    if (btcMcap > 0 && totalMcap > 0) {
      const btcD = (btcMcap / totalMcap) * 100
      btcDomSeries.push({ time: day, close: btcD })
    }
  }

  console.log(`\nBuilt BTC.D proxy: ${btcDomSeries.length} daily points`)
  console.log(`Range: ${new Date(btcDomSeries[0].time).toISOString().slice(0, 10)} → ${new Date(btcDomSeries[btcDomSeries.length - 1].time).toISOString().slice(0, 10)}`)
  console.log(`First: ${btcDomSeries[0].close.toFixed(2)}% | Last: ${btcDomSeries[btcDomSeries.length - 1].close.toFixed(2)}%`)
  const min = Math.min(...btcDomSeries.map(x => x.close))
  const max = Math.max(...btcDomSeries.map(x => x.close))
  console.log(`Min: ${min.toFixed(2)}% | Max: ${max.toFixed(2)}%`)

  // Save CSV (compatible with rotation backtest)
  const csv = ['time,open,high,low,close']
  for (const point of btcDomSeries) {
    csv.push(`${point.time},${point.close},${point.close},${point.close},${point.close}`)
  }
  const dataDir = path.dirname(OUT_CSV)
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(OUT_CSV, csv.join('\n'))
  console.log(`\nSaved to ${OUT_CSV}`)
  console.log('\nNow run: npx tsx src/scalper/runBacktest_btc_dominance_rotation.ts')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
