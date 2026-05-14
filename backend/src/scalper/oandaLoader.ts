/**
 * OANDA historical loader — forex candles с кешированием на диск.
 *
 * Зачем: для backtest BB-touch стратегии на forex (EUR/USD, GBP/USD и т.п.).
 *
 * API: https://developer.oanda.com/rest-live-v20/instrument-ep/
 *   GET /v3/instruments/{instrument}/candles?granularity=M5&count=5000
 *
 * Аутентификация:
 *   Authorization: Bearer ${OANDA_API_TOKEN}  (из .env)
 *   Используем practice endpoint: api-fxpractice.oanda.com (для demo аккаунта).
 *
 * Особенности:
 *   - OANDA отдаёт максимум 5000 свечей за запрос → walking back chunks по времени
 *   - Forex закрыт в выходные (Sat-Sun), там просто пропуски — это нормально
 *   - granularity: M1, M5, M15, M30, H1, H4, D
 *   - Имена пар через подчёркивание: EUR_USD, USD_JPY (не EURUSD)
 *
 * Cache совместим с историческим bybit loader: тот же формат файла в data/backtest/.
 */

import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const OANDA_BASE = 'https://api-fxpractice.oanda.com'
const OANDA_MAX_COUNT = 5000

const INTERVAL_MS: Record<string, number> = {
  '1m':  60_000,
  '5m':  5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h':  60 * 60_000,
  '4h':  4 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
}

const OANDA_GRANULARITY: Record<string, string> = {
  '1m':  'M1',
  '5m':  'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h':  'H1',
  '4h':  'H4',
  '1d':  'D',
}

interface CacheFile {
  source: 'oanda'
  symbol: string
  interval: string
  candles: OHLCV[]
  fetchedAt: number
}

interface OandaCandle {
  time: string         // ISO timestamp e.g. "2024-01-15T10:00:00.000000000Z"
  volume: number
  complete: boolean
  mid: { o: string; h: string; l: string; c: string }
}

interface OandaCandlesResponse {
  instrument: string
  granularity: string
  candles: OandaCandle[]
}

function cachePath(symbol: string, interval: string): string {
  return path.join(CACHE_DIR, `oanda_${symbol}_${interval}.json`)
}

function getToken(): string {
  const t = process.env.OANDA_API_TOKEN
  if (!t) throw new Error('OANDA_API_TOKEN not set in .env')
  return t
}

async function fetchBatch(
  instrument: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<OHLCV[]> {
  const gran = OANDA_GRANULARITY[interval]
  if (!gran) throw new Error(`Unsupported interval: ${interval}`)

  // OANDA expects from/to as RFC3339 timestamps. Use unix seconds.
  const from = new Date(fromMs).toISOString()
  const to = new Date(toMs).toISOString()
  const url = `${OANDA_BASE}/v3/instruments/${instrument}/candles?price=M&granularity=${gran}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&count=${OANDA_MAX_COUNT}`

  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${getToken()}`,
          'Accept-Datetime-Format': 'RFC3339',
        },
      })
      if (res.status === 429) {
        throw new Error(`OANDA 429 rate limit`)
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`OANDA ${res.status} ${res.statusText} on ${instrument} ${interval}: ${txt.slice(0, 200)}`)
      }
      const json = (await res.json()) as OandaCandlesResponse
      const candles = (json.candles ?? [])
        .filter((c) => c.complete && c.mid)
        .map((c) => ({
          time: Date.parse(c.time),
          open: parseFloat(c.mid.o),
          high: parseFloat(c.mid.h),
          low: parseFloat(c.mid.l),
          close: parseFloat(c.mid.c),
          volume: c.volume,
        }))
        .filter((c) => isFinite(c.close) && c.time > 0)
        .sort((a, b) => a.time - b.time)
      return candles
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? e)
      const isRetry = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
      if (!isRetry) throw e
      const wait = Math.min(30_000, 1_000 * Math.pow(2, attempt))
      console.warn(`[Loader/oanda] ${instrument} ${interval}: retry ${attempt + 1}/5 after ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr ?? new Error(`OANDA fetch failed after retries`)
}

/**
 * Load `monthsBack` months of history for instrument (e.g. "EUR_USD") at given interval.
 * Caches to data/backtest/oanda_{instrument}_{interval}.json — re-runs only fetch fresh tail.
 *
 * @param instrument OANDA-style name with underscore: EUR_USD, GBP_USD, USD_JPY...
 * @param interval   '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'
 * @param monthsBack history span in months
 */
export async function loadOanda(
  instrument: string,
  interval: string,
  monthsBack: number,
): Promise<OHLCV[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

  const intervalMs = INTERVAL_MS[interval]
  if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`)

  const file = cachePath(instrument, interval)
  let cached: OHLCV[] = []
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheFile
    cached = data.candles
    console.log(`[Loader/oanda] ${instrument} ${interval}: loaded ${cached.length} cached candles`)
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
    console.log(`[Loader/oanda] ${instrument} ${interval}: cache up to date (${cached.length} candles)`)
    return cached
  }

  const fresh: OHLCV[] = []
  let cursor = fetchFrom
  // chunk size: ~OANDA_MAX_COUNT bars per request
  const chunkSpan = OANDA_MAX_COUNT * intervalMs

  while (cursor < lastClosedTime) {
    const chunkEnd = Math.min(cursor + chunkSpan, lastClosedTime + intervalMs)
    let batch: OHLCV[]
    try {
      batch = await fetchBatch(instrument, interval, cursor, chunkEnd)
    } catch (e: any) {
      console.warn(`[Loader/oanda] ${instrument} ${interval}: chunk failed at ${new Date(cursor).toISOString()}: ${e.message}`)
      throw e
    }

    if (batch.length === 0) {
      // Forex closed (weekend) or simply no data in this slice → advance cursor anyway
      cursor = chunkEnd
      continue
    }

    fresh.push(...batch)
    const lastT = batch[batch.length - 1].time
    cursor = Math.max(lastT + intervalMs, cursor + intervalMs)
    console.log(`[Loader/oanda] ${instrument} ${interval}: +${batch.length} (up to ${new Date(lastT).toISOString()})`)
    await new Promise((r) => setTimeout(r, 300))  // be polite
  }

  // Merge — dedupe by time
  const all = [...cached, ...fresh]
  const dedup = new Map<number, OHLCV>()
  for (const c of all) dedup.set(c.time, c)
  const merged = [...dedup.values()].sort((a, b) => a.time - b.time)

  const out: CacheFile = {
    source: 'oanda',
    symbol: instrument,
    interval,
    candles: merged,
    fetchedAt: Date.now(),
  }
  fs.writeFileSync(file, JSON.stringify(out))
  console.log(`[Loader/oanda] ${instrument} ${interval}: saved ${merged.length} total`)
  return merged
}
