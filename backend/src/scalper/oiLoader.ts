/**
 * Bybit Open Interest historical loader with disk caching.
 *
 * Bybit endpoint: GET /v5/market/open-interest
 *   - category=linear, symbol, intervalTime=5min (also 15min/30min/1h/4h/1d)
 *   - Returns OI snapshots newest-first, with nextPageCursor for pagination.
 *   - Each item: { openInterest: string, timestamp: string (ms) }
 *   - openInterest is in BASE units (coins), not USD. Multiply by price to get USD.
 *
 * History depth: ~12+ months for liquid pairs (confirmed BTCUSDT back to 2025-05).
 *
 * Cache format mirrors historicalLoader: JSON file per symbol with append-on-fetch.
 */

import * as fs from 'fs'
import * as path from 'path'

const CACHE_DIR = path.join(__dirname, '../../data/backtest/oi')
const BYBIT_OI_BASE = 'https://api.bybit.com/v5/market/open-interest'

export interface OISnapshot {
  time: number          // unix ms (start of 5min bucket)
  openInterest: number  // in base units (coins)
}

interface OICacheFile {
  symbol: string
  intervalTime: string
  snapshots: OISnapshot[]
  fetchedAt: number
}

const INTERVAL_MS_OI: Record<string, number> = {
  '5min': 5 * 60_000,
  '15min': 15 * 60_000,
  '30min': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

function cachePath(symbol: string, intervalTime: string): string {
  return path.join(CACHE_DIR, `bybit_oi_${symbol}_${intervalTime}.json`)
}

interface BybitOIBatchResponse {
  retCode: number
  retMsg: string
  result?: {
    symbol: string
    category: string
    list?: Array<{ openInterest: string; timestamp: string }>
    nextPageCursor?: string
  }
}

/**
 * Fetch a single batch of OI from Bybit with retry on rate-limit.
 * Returns snapshots ascending by time.
 */
async function fetchBybitOIBatch(
  symbol: string,
  intervalTime: string,
  startTime: number,
  endTime: number,
  cursor?: string,
): Promise<{ snapshots: OISnapshot[]; nextCursor?: string }> {
  let url = `${BYBIT_OI_BASE}?category=linear&symbol=${symbol}&intervalTime=${intervalTime}&startTime=${startTime}&endTime=${endTime}&limit=200`
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`

  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Bybit OI ${res.status} ${res.statusText} on ${symbol}`)
      const json = (await res.json()) as BybitOIBatchResponse
      if (json.retCode === 10006) throw new Error(`Bybit OI retCode=10006 retMsg=${json.retMsg}`)
      if (json.retCode !== 0) throw new Error(`Bybit OI retCode=${json.retCode} retMsg=${json.retMsg}`)
      const list = json.result?.list ?? []
      const snapshots: OISnapshot[] = list.map(item => ({
        time: parseInt(item.timestamp),
        openInterest: parseFloat(item.openInterest),
      })).sort((a, b) => a.time - b.time)
      return { snapshots, nextCursor: json.result?.nextPageCursor }
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? e)
      const isRateLimit = msg.includes('10006') || msg.includes('Rate Limit')
      const isTransient = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
      if (!isRateLimit && !isTransient) throw e
      const wait = isRateLimit ? Math.min(60_000, 2_000 * Math.pow(2, attempt)) : Math.min(10_000, 500 * Math.pow(2, attempt))
      console.warn(`[OILoader] ${symbol}: ${isRateLimit ? 'rate-limit' : 'transient'} (attempt ${attempt + 1}/6), waiting ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr ?? new Error('Bybit OI fetch failed after retries')
}

/**
 * Load OI history for symbol over the past N months, cached to disk.
 *
 * Bybit returns OI newest-first with nextPageCursor for going further back.
 * We walk backwards from `now` until we hit `desiredStart`, then merge into cache.
 *
 * Pagination strategy: paginate with cursor (more reliable than start/end windowing
 * for OI endpoint which has its own per-symbol depth limits).
 */
export async function loadOIHistory(
  symbol: string,
  intervalTime: string = '5min',
  monthsBack: number = 14,
): Promise<OISnapshot[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
  const intervalMs = INTERVAL_MS_OI[intervalTime]
  if (!intervalMs) throw new Error(`Unsupported OI interval: ${intervalTime}`)

  const file = cachePath(symbol, intervalTime)
  let cached: OISnapshot[] = []
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as OICacheFile
    cached = data.snapshots
    console.log(`[OILoader] ${symbol} ${intervalTime}: loaded ${cached.length} cached snapshots`)
  }

  const now = Date.now()
  const desiredStart = now - monthsBack * 30 * 24 * 60 * 60_000
  const lastClosedTime = Math.floor(now / intervalMs) * intervalMs - intervalMs

  // Determine what we still need to fetch.
  // Case 1: no cache → fetch entire [desiredStart, lastClosedTime]
  // Case 2: cache exists → fetch gap [lastCachedTime+intervalMs, lastClosedTime]
  //         (we don't backfill older than cache start — assume initial fetch grabbed all)
  let fetchFrom: number
  if (cached.length === 0) {
    fetchFrom = desiredStart
  } else {
    fetchFrom = cached[cached.length - 1].time + intervalMs
    if (cached[0].time > desiredStart) {
      console.warn(
        `[OILoader] ${symbol}: cache starts ${new Date(cached[0].time).toISOString()} but ${monthsBack}mo ago is ${new Date(desiredStart).toISOString()}. Using cached range.`
      )
    }
  }

  if (fetchFrom > lastClosedTime) {
    console.log(`[OILoader] ${symbol} ${intervalTime}: cache up to date (${cached.length} snapshots)`)
    return cached
  }

  // Walk backwards from `lastClosedTime` using cursor pagination.
  // Bybit returns ~200 items per batch newest-first; we accumulate then stop when
  // we go below fetchFrom.
  const fresh: OISnapshot[] = []
  let cursor: string | undefined = undefined
  let consecutiveEmpty = 0

  while (true) {
    let batch: { snapshots: OISnapshot[]; nextCursor?: string }
    try {
      batch = await fetchBybitOIBatch(symbol, intervalTime, fetchFrom, lastClosedTime, cursor)
    } catch (e: any) {
      console.warn(`[OILoader] ${symbol}: batch fetch failed: ${e.message}`)
      throw e
    }

    if (batch.snapshots.length === 0) {
      consecutiveEmpty++
      if (consecutiveEmpty >= 2 || !batch.nextCursor) break
      cursor = batch.nextCursor
      continue
    }
    consecutiveEmpty = 0

    const newSnaps = batch.snapshots.filter(s => s.time >= fetchFrom && s.time <= lastClosedTime)
    fresh.push(...newSnaps)

    // Stop conditions:
    //   - no nextPageCursor (Bybit ran out of history)
    //   - oldest snapshot in this batch is at or before fetchFrom (we've covered the range)
    const oldestInBatch = batch.snapshots[0].time
    if (!batch.nextCursor || oldestInBatch <= fetchFrom) break

    cursor = batch.nextCursor

    if (fresh.length % 2000 < 200) {
      console.log(`[OILoader] ${symbol} ${intervalTime}: ${fresh.length} new (down to ${new Date(oldestInBatch).toISOString()})`)
    }
    await new Promise(r => setTimeout(r, 400))
  }

  // Merge: cached + fresh, sort, dedupe by time
  const merged = [...cached, ...fresh]
  const dedupedMap = new Map<number, OISnapshot>()
  for (const s of merged) dedupedMap.set(s.time, s)
  const deduped = Array.from(dedupedMap.values()).sort((a, b) => a.time - b.time)

  const out: OICacheFile = {
    symbol,
    intervalTime,
    snapshots: deduped,
    fetchedAt: now,
  }
  fs.writeFileSync(file, JSON.stringify(out))
  console.log(`[OILoader] ${symbol} ${intervalTime}: saved ${deduped.length} snapshots (${fresh.length} new)`)

  return deduped
}

/**
 * Align OI snapshots to candle timestamps for fast lookup during backtest.
 * Returns a Map keyed by the floor(time / intervalMs) so we can do O(1) lookups.
 */
export function buildOIIndex(snapshots: OISnapshot[]): Map<number, number> {
  const idx = new Map<number, number>()
  for (const s of snapshots) idx.set(s.time, s.openInterest)
  return idx
}
