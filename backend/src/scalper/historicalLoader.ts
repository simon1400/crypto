import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const BYBIT_BASE = 'https://api.bybit.com/v5/market/kline'
const BYBIT_LIMIT = 1000
const BINANCE_BASE = 'https://api.binance.com/api/v3/klines'
const BINANCE_LIMIT = 1000

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

const BYBIT_INTERVAL: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D',
}

export type ExchangeSource = 'bybit' | 'binance'
export type BybitCategory = 'linear' | 'spot' | 'inverse'

function cachePath(symbol: string, interval: string, source: ExchangeSource): string {
  return path.join(CACHE_DIR, `${source}_${symbol}_${interval}.json`)
}

interface CacheFile {
  source: ExchangeSource
  symbol: string
  interval: string
  candles: OHLCV[]
  fetchedAt: number
}

async function fetchBybitBatch(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  category: BybitCategory,
): Promise<OHLCV[]> {
  const bybitInt = BYBIT_INTERVAL[interval]
  if (!bybitInt) throw new Error(`Bybit: unsupported interval ${interval}`)
  const url = `${BYBIT_BASE}?category=${category}&symbol=${symbol}&interval=${bybitInt}&start=${startTime}&end=${endTime}&limit=${BYBIT_LIMIT}`

  // Retry with exponential backoff on rate-limit (retCode=10006) and transient HTTP errors.
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Bybit ${res.status} ${res.statusText} on ${symbol} ${interval}`)
      const json = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: any[][] } }
      if (json.retCode === 10006) throw new Error(`Bybit retCode=10006 retMsg=${json.retMsg}`)
      if (json.retCode !== 0) throw new Error(`Bybit retCode=${json.retCode} retMsg=${json.retMsg}`)
      const list = json.result?.list ?? []
      // success — break out and process below
      return list.map((k) => ({
        time: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })).sort((a, b) => a.time - b.time)
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? e)
      const isRateLimit = msg.includes('10006') || msg.includes('Rate Limit')
      const isTransient = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
      if (!isRateLimit && !isTransient) throw e
      const wait = isRateLimit ? Math.min(60_000, 2_000 * Math.pow(2, attempt)) : Math.min(10_000, 500 * Math.pow(2, attempt))
      console.warn(`[Loader/bybit] ${symbol} ${interval}: ${isRateLimit ? 'rate-limit' : 'transient'} (attempt ${attempt + 1}/6), waiting ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr ?? new Error(`Bybit fetch failed after retries`)
}


async function fetchBinanceBatch(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<OHLCV[]> {
  const url = `${BINANCE_BASE}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${BINANCE_LIMIT}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance ${res.status} ${res.statusText} on ${symbol} ${interval}`)
  const raw = (await res.json()) as any[]
  return raw.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

/**
 * Load historical klines, cached as JSON.
 * Default source: Bybit linear perp (matches what user trades on).
 * Cache files are namespaced by source so switching sources doesn't mix data.
 *
 * Bybit caveat: max ~2 years of history depending on symbol. If you need more,
 * fall back to Binance manually with `source: 'binance'`.
 */
export async function loadHistorical(
  symbol: string,
  interval: string,
  monthsBack: number,
  source: ExchangeSource = 'bybit',
  bybitCategory: BybitCategory = 'linear',
): Promise<OHLCV[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

  const intervalMs = INTERVAL_MS[interval]
  if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`)

  const file = cachePath(symbol, interval, source)
  let cached: OHLCV[] = []
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheFile
    cached = data.candles
    console.log(`[Loader/${source}] ${symbol} ${interval}: loaded ${cached.length} cached candles`)
  }

  const now = Date.now()
  const lastClosedTime = Math.floor(now / intervalMs) * intervalMs - intervalMs
  const desiredStart = now - monthsBack * 30 * 24 * 60 * 60_000

  let fetchFrom: number
  if (cached.length === 0) {
    fetchFrom = desiredStart
  } else {
    fetchFrom = cached[cached.length - 1].time + intervalMs
    if (cached[0].time > desiredStart) {
      console.warn(
        `[Loader/${source}] ${symbol} ${interval}: cache starts ${new Date(cached[0].time).toISOString()} but ${monthsBack}mo ago is ${new Date(desiredStart).toISOString()}. Using cached range.`,
      )
    }
  }

  if (fetchFrom > lastClosedTime) {
    console.log(`[Loader/${source}] ${symbol} ${interval}: cache up to date (${cached.length} candles)`)
    return cached
  }

  const fresh: OHLCV[] = []
  if (source === 'bybit') {
    // Bybit returns newest-first within [start, end] and caps at limit. So we walk
    // BACKWARDS from `end` toward `fetchFrom`, lowering `end` after each batch.
    let endCursor = lastClosedTime
    let consecutiveEmpty = 0
    while (endCursor >= fetchFrom) {
      let batch: OHLCV[]
      try {
        batch = await fetchBybitBatch(symbol, interval, fetchFrom, endCursor, bybitCategory)
      } catch (e: any) {
        console.warn(`[Loader/bybit] fetch failed at end ${new Date(endCursor).toISOString()}: ${e.message}`)
        throw e
      }
      if (batch.length === 0) {
        consecutiveEmpty++
        if (consecutiveEmpty >= 2) break
        endCursor -= BYBIT_LIMIT * intervalMs
        continue
      }
      consecutiveEmpty = 0
      // batch is sorted ascending by time (we sorted in fetchBybitBatch). Take only those
      // strictly inside [fetchFrom, endCursor].
      const newCandles = batch.filter((c) => c.time >= fetchFrom && c.time <= endCursor)
      if (newCandles.length === 0) break
      fresh.push(...newCandles)
      // Move endCursor below the oldest candle we just received
      const oldest = newCandles[0].time
      const nextEnd = oldest - intervalMs
      if (nextEnd >= endCursor) break
      endCursor = nextEnd
      if (fresh.length % 10000 < BYBIT_LIMIT) {
        console.log(`[Loader/bybit] ${symbol} ${interval}: ${fresh.length} new (down to ${new Date(oldest).toISOString()})`)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  } else {
    // Binance: forward-walking
    let cursor = fetchFrom
    while (cursor <= lastClosedTime) {
      const batch = await fetchBinanceBatch(symbol, interval, cursor, lastClosedTime)
      if (batch.length === 0) break
      fresh.push(...batch)
      cursor = batch[batch.length - 1].time + intervalMs
      if (fresh.length % 10000 < BINANCE_LIMIT) {
        console.log(`[Loader/binance] ${symbol} ${interval}: ${fresh.length} new (up to ${new Date(cursor).toISOString()})`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const all = [...cached, ...fresh]
  const dedup = dedupAndSort(all)
  const out: CacheFile = { source, symbol, interval, candles: dedup, fetchedAt: Date.now() }
  fs.writeFileSync(file, JSON.stringify(out))
  console.log(`[Loader/${source}] ${symbol} ${interval}: total ${dedup.length} candles (${fresh.length} new)`)
  return dedup
}

function dedupAndSort(candles: OHLCV[]): OHLCV[] {
  const map = new Map<number, OHLCV>()
  for (const c of candles) map.set(c.time, c)
  return [...map.values()].sort((a, b) => a.time - b.time)
}
