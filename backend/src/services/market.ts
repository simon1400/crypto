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

export async function fetchOHLCV(
  symbol: string,
  interval = '4h',
  limit = 60
): Promise<OHLCV[]> {
  // Try Binance first, fallback to MEXC
  const exchanges = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ]

  for (const url of exchanges) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = (await res.json()) as any[][]
      if (!Array.isArray(data) || data.length === 0) continue

      return data.map((k) => ({
        time: k[0] as number,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
      }))
    } catch {
      continue
    }
  }

  throw new Error(`Symbol ${symbol} not found on any exchange`)
}

export async function fetchOHLCV_MEXC(
  symbol: string,
  interval = '4h',
  limit = 60
): Promise<OHLCV[]> {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
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
  try {
    const res = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`)
    if (!res.ok) return null
    const data = await res.json() as any
    if (data.price) return parseFloat(data.price)
  } catch {}
  return null
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
