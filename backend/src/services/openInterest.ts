// Fetch Open Interest from MEXC Futures API (free, no auth needed)

export interface OIData {
  symbol: string
  openInterest: number       // contract value in USDT
  openInterestChange: number // % change (calculated from recent data)
}

export async function fetchOpenInterest(symbol: string): Promise<OIData | null> {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/open_interest/${symbol}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json() as any
    if (!json.success || !json.data) return null

    return {
      symbol,
      openInterest: json.data.openInterest ?? 0,
      openInterestChange: 0, // Will be computed by comparing snapshots
    }
  } catch {
    return null
  }
}

// Batch fetch for multiple coins
export async function fetchOpenInterests(coins: string[]): Promise<Record<string, OIData>> {
  const results: Record<string, OIData> = {}
  const promises = coins.map(async (coin) => {
    const symbol = `${coin}_USDT`
    const data = await fetchOpenInterest(symbol)
    if (data) results[coin] = data
  })
  await Promise.all(promises)
  return results
}
