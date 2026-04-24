import { OHLCV } from '../services/market'

const API_KEY = process.env.TWELVE_DATA_API_KEY || ''
const BASE = 'https://api.twelvedata.com'

// Forex tickers passed as "EURUSD" — Twelve Data expects "EUR/USD"
// Indices have special symbols on Twelve Data
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
  GBPJPY: 'GBP/JPY',
  XAUUSD: 'XAU/USD',
  US30: 'DJI',
  NAS100: 'IXIC',
}

const INTERVAL_MAP: Record<string, string> = {
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
}

interface TwelveDataValue {
  datetime: string
  open: string
  high: string
  low: string
  close: string
  volume?: string
}

interface TwelveDataResponse {
  meta?: { symbol: string; interval: string }
  values?: TwelveDataValue[]
  status?: string
  code?: number
  message?: string
}

// Simple in-memory cache keyed by symbol+interval.
// TTL matches scan cadence — if scan fires hourly, candles older than 50 min are fresh enough.
interface CacheEntry {
  data: OHLCV[]
  fetchedAt: number
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 25 * 60 * 1000 // 25 min — aggressive to respect 800 req/day budget

export function mapForexSymbol(symbol: string): string {
  return SYMBOL_MAP[symbol] || symbol
}

export async function fetchForexOHLCV(
  symbol: string,
  interval: '30m' | '1h' | '4h',
  outputsize = 200,
): Promise<OHLCV[]> {
  if (!API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY not configured')
  }

  const cacheKey = `${symbol}:${interval}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  const tdSymbol = mapForexSymbol(symbol)
  const tdInterval = INTERVAL_MAP[interval]
  if (!tdInterval) throw new Error(`Unknown interval: ${interval}`)

  const url = `${BASE}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&outputsize=${outputsize}&apikey=${API_KEY}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Twelve Data HTTP ${res.status} for ${symbol} ${interval}`)
  }

  const data = (await res.json()) as TwelveDataResponse

  if (data.status === 'error' || data.code) {
    throw new Error(`Twelve Data error for ${symbol} ${interval}: ${data.message || 'unknown'}`)
  }

  if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
    throw new Error(`Twelve Data returned empty values for ${symbol} ${interval}`)
  }

  // Twelve Data returns newest first — reverse to chronological order for indicators
  const candles: OHLCV[] = data.values
    .map((v) => ({
      time: Math.floor(new Date(v.datetime).getTime() / 1000),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume ? Number(v.volume) : 0,
    }))
    .reverse()

  cache.set(cacheKey, { data: candles, fetchedAt: Date.now() })
  return candles
}

export function clearForexCache() {
  cache.clear()
}

// Called on boot so we know if key is even configured
export function isForexProviderConfigured(): boolean {
  return !!API_KEY
}
