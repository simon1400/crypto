/**
 * Polygon.io historical loader for instruments NOT available on Bybit or TwelveData free.
 *
 * Free plan limits:
 *   - 5 requests / minute
 *   - 2 years of history
 *   - Stocks API (ETFs like SPY/QQQ work) — open
 *   - Forex (C:XAGUSD, C:XAUUSD) — open
 *   - Indexes (I:SPX, I:NDX) — paid only, expect 403
 *
 * Caches per (symbol, interval) into data/backtest/polygon_<SYM>_<TF>.json.
 */

import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const BASE = 'https://api.polygon.io'
const API_KEY = process.env.POLYGON_API_KEY || ''

const POLYGON_SLEEP_MS = 13_000 // 13s between calls → ~4.6 req/min, safely under 5/min limit
const POLYGON_RATE_LIMIT_RECOVERY_MS = 65_000 // wait full minute on rate-limit error

// Map our internal interval → Polygon multiplier+timespan
const INTERVAL_POLYGON: Record<string, { multiplier: number; timespan: string }> = {
  '1m':  { multiplier: 1, timespan: 'minute' },
  '5m':  { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '30m': { multiplier: 30, timespan: 'minute' },
  '1h':  { multiplier: 1, timespan: 'hour' },
  '4h':  { multiplier: 4, timespan: 'hour' },
  '1d':  { multiplier: 1, timespan: 'day' },
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

interface CacheFile {
  source: 'polygon'
  symbol: string
  interval: string
  candles: OHLCV[]
  fetchedAt: number
}

interface PolygonAggBar {
  t: number  // unix ms timestamp (open of bar)
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface PolygonAggResponse {
  status?: string
  error?: string
  message?: string
  results?: PolygonAggBar[]
  resultsCount?: number
  next_url?: string
}

function cachePath(symbol: string, interval: string): string {
  // sanitize ":" and "/" for filenames
  const safe = symbol.replace(/[:/]/g, '_')
  return path.join(CACHE_DIR, `polygon_${safe}_${interval}.json`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchPolygonAggs(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  retryAttempt = 0,
): Promise<{ bars: OHLCV[]; nextUrl: string | null }> {
  const cfg = INTERVAL_POLYGON[interval]
  if (!cfg) throw new Error(`Polygon: unsupported interval ${interval}`)
  const url = `${BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${cfg.multiplier}/${cfg.timespan}/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=50000&apiKey=${API_KEY}`
  const res = await fetch(url)
  if (res.status === 429) {
    if (retryAttempt < 3) {
      console.warn(`[Loader/poly] 429 rate-limit, sleeping ${POLYGON_RATE_LIMIT_RECOVERY_MS}ms (attempt ${retryAttempt + 1}/3)`)
      await sleep(POLYGON_RATE_LIMIT_RECOVERY_MS)
      return fetchPolygonAggs(symbol, interval, fromMs, toMs, retryAttempt + 1)
    }
    throw new Error('Polygon 429 — rate limited after 3 retries')
  }
  if (res.status === 403) {
    throw new Error(`Polygon 403 — symbol ${symbol} requires paid plan`)
  }
  if (!res.ok) {
    throw new Error(`Polygon HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const data = (await res.json()) as PolygonAggResponse
  if (data.status === 'ERROR' || data.error) {
    throw new Error(`Polygon error: ${data.error || data.message || 'unknown'}`)
  }
  const bars: OHLCV[] = (data.results ?? []).map((b) => ({
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }))
  return { bars, nextUrl: data.next_url ?? null }
}

export async function loadPolygonHistorical(
  symbol: string,
  interval: string,
  monthsBack: number,
): Promise<OHLCV[]> {
  if (!API_KEY) throw new Error('POLYGON_API_KEY not set in env')
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
  const intervalMs = INTERVAL_MS[interval]
  if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`)

  const file = cachePath(symbol, interval)
  let cached: OHLCV[] = []
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheFile
    cached = data.candles
    console.log(`[Loader/poly] ${symbol} ${interval}: loaded ${cached.length} cached candles`)
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
    console.log(`[Loader/poly] ${symbol} ${interval}: cache up to date (${cached.length} candles)`)
    return cached
  }

  // Polygon allows up to 50000 bars per request — usually plenty for a year of 5m (~75k bars).
  // We chunk into 50000-bar windows to stay safe.
  const fresh: OHLCV[] = []
  const windowMs = 50000 * intervalMs
  let cursor = fetchFrom
  let consecutiveEmpty = 0

  while (cursor <= lastClosedTime) {
    const windowEnd = Math.min(cursor + windowMs, lastClosedTime)
    let bars: OHLCV[]
    try {
      const r = await fetchPolygonAggs(symbol, interval, cursor, windowEnd)
      bars = r.bars
    } catch (e: any) {
      console.warn(`[Loader/poly] fetch failed at ${new Date(cursor).toISOString()}: ${e.message}`)
      throw e
    }
    if (bars.length === 0) {
      consecutiveEmpty++
      if (consecutiveEmpty >= 3) {
        console.log(`[Loader/poly] ${symbol} ${interval}: 3 empty windows, stopping at ${new Date(cursor).toISOString()}`)
        break
      }
      cursor = windowEnd + intervalMs
      await sleep(POLYGON_SLEEP_MS)
      continue
    }
    consecutiveEmpty = 0
    const newCandles = bars.filter((c) => c.time >= cursor && c.time <= lastClosedTime)
    if (newCandles.length === 0) {
      cursor = windowEnd + intervalMs
      await sleep(POLYGON_SLEEP_MS)
      continue
    }
    fresh.push(...newCandles)
    cursor = newCandles[newCandles.length - 1].time + intervalMs
    console.log(`[Loader/poly] ${symbol} ${interval}: ${fresh.length} new (up to ${new Date(cursor).toISOString()})`)
    await sleep(POLYGON_SLEEP_MS)
  }

  const all = [...cached, ...fresh]
  const dedup = dedupAndSort(all)
  const out: CacheFile = { source: 'polygon', symbol, interval, candles: dedup, fetchedAt: Date.now() }
  fs.writeFileSync(file, JSON.stringify(out))
  console.log(`[Loader/poly] ${symbol} ${interval}: total ${dedup.length} candles (${fresh.length} new)`)
  return dedup
}

function dedupAndSort(candles: OHLCV[]): OHLCV[] {
  const map = new Map<number, OHLCV>()
  for (const c of candles) map.set(c.time, c)
  return [...map.values()].sort((a, b) => a.time - b.time)
}
