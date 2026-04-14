export interface OHLCV {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketOverview {
  fearGreed: number
  fearGreedLabel: string
  btcDominance: number
}

// MEXC uses different interval format: 1m,5m,15m,30m,60m,4h,8h,1d,1W,1M
const MEXC_INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '60m', '4h': '4h', '8h': '8h', '1d': '1d',
}

/**
 * Универсальный fetchOHLCV: Bybit linear перпетуалы → Binance fallback → MEXC fallback.
 *
 * Bybit — основной источник так как пользователь торгует там.
 * Это гарантирует что индикаторы и скоринг считаются на тех же свечах
 * что и реальные позиции на бирже исполнения.
 */
export type ExchangeSource = 'bybit' | 'binance' | 'mexc' | 'bingx'

export interface OHLCVWithExchange {
  candles: OHLCV[]
  exchange: ExchangeSource
}

/**
 * Fetch OHLCV with exchange source tracking.
 * Priority: Bybit → BingX → Binance → MEXC.
 * Bybit first (user trades there). BingX second for coins not on Bybit.
 */
export async function fetchOHLCVWithExchange(
  symbol: string,
  interval = '4h',
  limit = 60
): Promise<OHLCVWithExchange> {
  // 1) Bybit linear (primary — user trades here)
  try {
    const { fetchBybitKlines } = await import('./bybitMarket')
    const candles = await fetchBybitKlines(symbol, interval, limit)
    if (candles.length > 0) return { candles, exchange: 'bybit' }
  } catch {}

  // 2) BingX linear swap (secondary)
  try {
    const { fetchBingxKlines } = await import('./bingxMarket')
    const candles = await fetchBingxKlines(symbol, interval, limit)
    if (candles.length > 0) return { candles, exchange: 'bingx' }
  } catch {}

  // 3) Binance / 4) MEXC fallback
  const mexcInterval = MEXC_INTERVAL_MAP[interval] || interval
  const fallbacks: { url: string; exchange: ExchangeSource }[] = [
    { url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, exchange: 'binance' },
    { url: `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${mexcInterval}&limit=${limit}`, exchange: 'mexc' },
  ]

  for (const { url, exchange } of fallbacks) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = (await res.json()) as any[][]
      if (!Array.isArray(data) || data.length === 0) continue

      return {
        candles: data.map((k) => ({
          time: k[0] as number,
          open: parseFloat(k[1] as string),
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
          volume: parseFloat(k[5] as string),
        })),
        exchange,
      }
    } catch {
      continue
    }
  }

  throw new Error(`Symbol ${symbol} not found on any exchange`)
}

export async function fetchOHLCV(
  symbol: string,
  interval = '4h',
  limit = 60
): Promise<OHLCV[]> {
  const result = await fetchOHLCVWithExchange(symbol, interval, limit)
  return result.candles
}

export async function fetchOHLCV_MEXC(
  symbol: string,
  interval = '4h',
  limit = 60
): Promise<OHLCV[]> {
  const mexcInterval = MEXC_INTERVAL_MAP[interval] || interval
  const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${mexcInterval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`MEXC error: ${res.status}`)
  const data = (await res.json()) as any[][]

  return data.map((k) => ({
    time: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }))
}

export async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  // 1) Bybit
  try {
    const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`)
    if (res.ok) {
      const data = await res.json() as any
      const price = data.result?.list?.[0]?.lastPrice
      if (price) return parseFloat(price)
    }
  } catch {}
  // 2) BingX fallback
  try {
    const { fetchBingxTicker } = await import('./bingxMarket')
    const ticker = await fetchBingxTicker(symbol)
    if (ticker && ticker.lastPrice > 0) return ticker.lastPrice
  } catch {}
  return null
}

/**
 * Параллельный фетч текущих цен для набора символов.
 * Возвращает объект { [symbol]: price | null } — удобно для lookup'а в map/loop.
 * Дедуплицирует символы автоматически.
 */
export async function fetchPricesBatch(symbols: string[]): Promise<Record<string, number | null>> {
  const unique = [...new Set(symbols)]
  const entries = await Promise.all(unique.map(async (s) => [s, await fetchCurrentPrice(s)] as const))
  return Object.fromEntries(entries)
}

export async function fetchMarketOverview(): Promise<MarketOverview> {
  let fearGreed = 50
  let fearGreedLabel = 'Neutral'
  let btcDominance = 60

  try {
    const fngRes = await fetch('https://api.alternative.me/fng/?limit=1')
    if (fngRes.ok) {
      const fngData: any = await fngRes.json()
      fearGreed = Number(fngData.data[0].value)
      fearGreedLabel = fngData.data[0].value_classification
    }
  } catch (e) {
    console.warn('Fear&Greed API unavailable, using defaults')
  }

  try {
    const globalRes = await fetch('https://api.coingecko.com/api/v3/global')
    if (globalRes.ok) {
      const globalData: any = await globalRes.json()
      btcDominance = Math.round(globalData.data.market_cap_percentage.btc * 10) / 10
    }
  } catch (e) {
    console.warn('CoinGecko API unavailable, using defaults')
  }

  return { fearGreed, fearGreedLabel, btcDominance }
}
