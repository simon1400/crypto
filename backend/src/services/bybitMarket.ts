/**
 * Унифицированный source-of-truth для всех рыночных данных с Bybit.
 *
 * Содержит:
 * - fetchBybitKlines           — свечи (используется в обёртке fetchOHLCV)
 * - fetchBybitTicker           — текущая цена + funding rate + OI
 * - fetchBybitFundingRate      — отдельный helper, оборачивает ticker
 * - fetchBybitOpenInterest     — текущий OI
 * - fetchBybitOIHistory        — история OI (1h интервал) для расчёта delta %
 * - fetchBybitLongShortRatio   — long/short account ratio
 *
 * Все методы публичные, не требуют API ключей.
 */

import { OHLCV } from './market'

const BASE = 'https://api.bybit.com'

// Bybit использует собственный формат интервалов для linear category:
// 1, 3, 5, 15, 30, 60, 120, 240, 360, 720, D, W, M
const BYBIT_INTERVAL_MAP: Record<string, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
  '1w': 'W',
}

interface BybitKlineRow {
  // Bybit kline format: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
  0: string
  1: string
  2: string
  3: string
  4: string
  5: string
  6: string
}

/**
 * Свечи с Bybit linear perpetual.
 * Возвращает в хронологическом порядке (старые → новые), как Binance.
 */
export async function fetchBybitKlines(
  symbol: string,
  interval = '4h',
  limit = 60,
): Promise<OHLCV[]> {
  const bybitInterval = BYBIT_INTERVAL_MAP[interval] || interval
  const url = `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit klines ${symbol} HTTP ${res.status}`)
  const data = (await res.json()) as { result?: { list?: BybitKlineRow[] } }
  const list = data.result?.list
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Bybit klines ${symbol} empty`)
  }

  // Bybit возвращает свечи в обратном порядке (новые → старые) — переворачиваем
  return list
    .map((k: any) => ({
      time: Number(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
    .reverse()
}

export interface BybitTickerData {
  symbol: string
  lastPrice: number
  fundingRate: number       // например 0.0001 = 0.01% за 8h
  nextFundingTime: number   // ms timestamp
  openInterest: number      // в base coins
  openInterestValue: number // в USDT (notional)
  volume24h: number
  turnover24h: number
}

/**
 * Один запрос за всеми ticker-метриками монеты:
 * lastPrice, fundingRate, openInterest, openInterestValue, volume24h.
 * Это самый эффективный способ получить funding+OI одним запросом.
 */
export async function fetchBybitTicker(symbol: string): Promise<BybitTickerData | null> {
  try {
    const url = `${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { result?: { list?: any[] } }
    const t = data.result?.list?.[0]
    if (!t) return null
    return {
      symbol,
      lastPrice: parseFloat(t.lastPrice ?? '0'),
      fundingRate: parseFloat(t.fundingRate ?? '0'),
      nextFundingTime: parseInt(t.nextFundingTime ?? '0', 10),
      openInterest: parseFloat(t.openInterest ?? '0'),
      openInterestValue: parseFloat(t.openInterestValue ?? '0'),
      volume24h: parseFloat(t.volume24h ?? '0'),
      turnover24h: parseFloat(t.turnover24h ?? '0'),
    }
  } catch {
    return null
  }
}

/**
 * История Open Interest (1h интервал, последние N точек).
 * Используется для расчёта oiChangePct: (current - prev) / prev * 100.
 */
export async function fetchBybitOIHistory(
  symbol: string,
  intervalTime: '5min' | '15min' | '30min' | '1h' | '4h' | '1d' = '1h',
  limit = 24,
): Promise<{ time: number; oi: number }[]> {
  try {
    const url = `${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${intervalTime}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = (await res.json()) as { result?: { list?: any[] } }
    const list = data.result?.list ?? []
    return list
      .map((row: any) => ({
        time: parseInt(row.timestamp, 10),
        oi: parseFloat(row.openInterest),
      }))
      .reverse() // старые → новые
  } catch {
    return []
  }
}

export interface BybitLongShortRatio {
  symbol: string
  buyRatio: number   // 0..1 — доля лонгов
  sellRatio: number  // 0..1
  timestamp: number
}

/**
 * Long/Short account ratio с Bybit (account-ratio endpoint).
 * Period: 5min, 15min, 30min, 1h, 4h, 1d.
 */
export async function fetchBybitLongShortRatio(
  symbol: string,
  period: '5min' | '15min' | '30min' | '1h' | '4h' | '1d' = '1h',
): Promise<BybitLongShortRatio | null> {
  try {
    const url = `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=${period}&limit=1`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { result?: { list?: any[] } }
    const row = data.result?.list?.[0]
    if (!row) return null
    return {
      symbol,
      buyRatio: parseFloat(row.buyRatio),
      sellRatio: parseFloat(row.sellRatio),
      timestamp: parseInt(row.timestamp, 10),
    }
  } catch {
    return null
  }
}
