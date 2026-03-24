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
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance error: ${res.status}`)
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

export async function fetchMarketOverview(): Promise<MarketOverview> {
  const [fngRes, globalRes] = await Promise.all([
    fetch('https://api.alternative.me/fng/?limit=1'),
    fetch('https://api.coingecko.com/api/v3/global'),
  ])

  if (!fngRes.ok) throw new Error(`Fear&Greed API error: ${fngRes.status}`)
  if (!globalRes.ok) throw new Error(`CoinGecko API error: ${globalRes.status}`)

  const fngData: any = await fngRes.json()
  const globalData: any = await globalRes.json()

  return {
    fearGreed: Number(fngData.data[0].value),
    fearGreedLabel: fngData.data[0].value_classification,
    btcDominance: Math.round(globalData.data.market_cap_percentage.btc * 10) / 10,
  }
}
