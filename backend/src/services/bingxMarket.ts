/**
 * BingX swap (perpetual futures) market data.
 *
 * Public endpoints, no API keys required.
 * Symbol format: BTC-USDT (dash-separated).
 * Intervals: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d
 */

import { OHLCV } from './market'

const BASE = 'https://open-api.bingx.com'

/**
 * Convert COINUSDT -> COIN-USDT for BingX API.
 */
function toBingxSymbol(symbol: string): string {
  // BTCUSDT -> BTC-USDT
  if (symbol.endsWith('USDT')) {
    return symbol.slice(0, -4) + '-USDT'
  }
  return symbol
}

/**
 * Klines from BingX linear swap.
 * Returns in chronological order (old -> new).
 */
export async function fetchBingxKlines(
  symbol: string,
  interval = '4h',
  limit = 60,
): Promise<OHLCV[]> {
  const bingxSymbol = toBingxSymbol(symbol)
  const url = `${BASE}/openApi/swap/v3/quote/klines?symbol=${bingxSymbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BingX klines ${symbol} HTTP ${res.status}`)
  const json = (await res.json()) as { code: number; data?: any[] }
  if (json.code !== 0 || !Array.isArray(json.data) || json.data.length === 0) {
    throw new Error(`BingX klines ${symbol} empty or error code ${json.code}`)
  }

  return json.data.map((k: any) => ({
    time: Number(k.time),
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume),
  }))
}

export interface BingxTickerData {
  symbol: string
  lastPrice: number
  volume24h: number
}

/**
 * Current ticker from BingX linear swap.
 */
export async function fetchBingxTicker(symbol: string): Promise<BingxTickerData | null> {
  try {
    const bingxSymbol = toBingxSymbol(symbol)
    const url = `${BASE}/openApi/swap/v2/quote/ticker?symbol=${bingxSymbol}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as { code: number; data?: any }
    if (json.code !== 0 || !json.data) return null
    return {
      symbol,
      lastPrice: parseFloat(json.data.lastPrice ?? '0'),
      volume24h: parseFloat(json.data.volume ?? '0'),
    }
  } catch {
    return null
  }
}
