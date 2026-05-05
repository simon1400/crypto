/**
 * Forex/commodity historical loader via Twelve Data.
 *
 * Used for instruments NOT on Bybit (or whose Bybit history is too short),
 * notably XAU/USD on the spot forex (where the user actually trades).
 *
 * Caches per (symbol, interval) into data/backtest/twelvedata_<SYM>_<TF>.json.
 *
 * Free-tier respects: 8 req/min, ~800 req/day. We sleep 8s between batches
 * to stay safely under the 8/min limit.
 */

import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const BASE = 'https://api.twelvedata.com'
const API_KEY = process.env.TWELVE_DATA_API_KEY || ''

const SYMBOL_MAP: Record<string, string> = {
  XAUUSD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
}

const INTERVAL_TD: Record<string, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '1h', '4h': '4h', '1d': '1day',
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

const TD_BATCH_SIZE = 5000
const TD_SLEEP_MS = 8000 // 8 sec between requests → 7.5 req/min < 8/min limit

interface CacheFile {
  source: 'twelvedata'
  symbol: string
  interval: string
  candles: OHLCV[]
  fetchedAt: number
}

function cachePath(symbol: string, interval: string): string {
  return path.join(CACHE_DIR, `twelvedata_${symbol}_${interval}.json`)
}

function fmtDateUTC(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

interface TdValue { datetime: string; open: string; high: string; low: string; close: string; volume?: string }
interface TdResponse { values?: TdValue[]; status?: string; code?: number; message?: string }

async function fetchTdBatch(
  tdSymbol: string,
  tdInterval: string,
  startMs: number,
  endMs: number,
): Promise<OHLCV[]> {
  const url = `${BASE}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&start_date=${encodeURIComponent(fmtDateUTC(startMs))}&end_date=${encodeURIComponent(fmtDateUTC(endMs))}&outputsize=${TD_BATCH_SIZE}&order=asc&timezone=UTC&apikey=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`TwelveData HTTP ${res.status}`)
  const data = (await res.json()) as TdResponse
  if (data.status === 'error' || data.code) {
    throw new Error(`TwelveData error: ${data.message || 'unknown'}`)
  }
  const values = data.values ?? []
  return values.map((v) => ({
    time: new Date(v.datetime + 'Z').getTime(), // datetime is in UTC because we passed timezone=UTC
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close),
    volume: v.volume ? Number(v.volume) : 0,
  })).sort((a, b) => a.time - b.time)
}

export async function loadForexHistorical(
  symbol: string,
  interval: string,
  monthsBack: number,
): Promise<OHLCV[]> {
  if (!API_KEY) throw new Error('TWELVE_DATA_API_KEY not set in env')
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

  const tdSymbol = SYMBOL_MAP[symbol]
  if (!tdSymbol) throw new Error(`Unsupported forex symbol: ${symbol}`)
  const tdInterval = INTERVAL_TD[interval]
  if (!tdInterval) throw new Error(`Unsupported interval: ${interval}`)
  const intervalMs = INTERVAL_MS[interval]

  const file = cachePath(symbol, interval)
  let cached: OHLCV[] = []
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheFile
    cached = data.candles
    console.log(`[Loader/td] ${symbol} ${interval}: loaded ${cached.length} cached candles`)
  }

  const now = Date.now()
  const lastClosedTime = Math.floor(now / intervalMs) * intervalMs - intervalMs
  const desiredStart = now - monthsBack * 30 * 24 * 60 * 60_000

  let fetchFrom: number
  if (cached.length === 0) {
    fetchFrom = desiredStart
  } else {
    fetchFrom = cached[cached.length - 1].time + intervalMs
  }
  if (fetchFrom > lastClosedTime) {
    console.log(`[Loader/td] ${symbol} ${interval}: cache up to date (${cached.length} candles)`)
    return cached
  }

  // Forward-walk in date windows. Twelve Data returns up to outputsize=5000 between start/end.
  // We compute a window length ≈ 5000 * intervalMs, send a request, and step `start` past
  // the latest candle returned.
  const fresh: OHLCV[] = []
  const windowMs = TD_BATCH_SIZE * intervalMs
  let cursor = fetchFrom
  let consecutiveEmpty = 0
  while (cursor <= lastClosedTime) {
    const windowEnd = Math.min(cursor + windowMs, lastClosedTime)
    let batch: OHLCV[]
    try {
      batch = await fetchTdBatch(tdSymbol, tdInterval, cursor, windowEnd)
    } catch (e: any) {
      console.warn(`[Loader/td] fetch failed at ${new Date(cursor).toISOString()}: ${e.message}`)
      throw e
    }
    if (batch.length === 0) {
      consecutiveEmpty++
      if (consecutiveEmpty >= 3) {
        console.log(`[Loader/td] ${symbol} ${interval}: 3 empty windows in a row, stopping at ${new Date(cursor).toISOString()}`)
        break
      }
      // forex closes on weekends — skip ahead
      cursor = windowEnd + intervalMs
      await new Promise((r) => setTimeout(r, TD_SLEEP_MS))
      continue
    }
    consecutiveEmpty = 0
    const newCandles = batch.filter((c) => c.time >= cursor && c.time <= lastClosedTime)
    if (newCandles.length === 0) {
      cursor = windowEnd + intervalMs
      await new Promise((r) => setTimeout(r, TD_SLEEP_MS))
      continue
    }
    fresh.push(...newCandles)
    cursor = newCandles[newCandles.length - 1].time + intervalMs
    console.log(`[Loader/td] ${symbol} ${interval}: ${fresh.length} new (up to ${new Date(cursor).toISOString()})`)
    await new Promise((r) => setTimeout(r, TD_SLEEP_MS))
  }

  const all = [...cached, ...fresh]
  const dedup = dedupAndSort(all)
  const out: CacheFile = { source: 'twelvedata', symbol, interval, candles: dedup, fetchedAt: Date.now() }
  fs.writeFileSync(file, JSON.stringify(out))
  console.log(`[Loader/td] ${symbol} ${interval}: total ${dedup.length} candles (${fresh.length} new)`)
  return dedup
}

function dedupAndSort(candles: OHLCV[]): OHLCV[] {
  const map = new Map<number, OHLCV>()
  for (const c of candles) map.set(c.time, c)
  return [...map.values()].sort((a, b) => a.time - b.time)
}
