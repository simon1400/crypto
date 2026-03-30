// Fetch funding rate from MEXC Futures API (free, no auth needed)

export interface FundingData {
  symbol: string
  fundingRate: number    // e.g. 0.0001 = 0.01%
  nextFundingTime: number
}

export async function fetchFundingRate(symbol: string): Promise<FundingData | null> {
  try {
    // MEXC futures funding rate endpoint
    const url = `https://contract.mexc.com/api/v1/contract/funding_rate/${symbol}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json() as any
    if (!json.success || !json.data) return null

    return {
      symbol,
      fundingRate: json.data.fundingRate ?? 0,
      nextFundingTime: json.data.nextSettleTime ?? 0,
    }
  } catch {
    return null
  }
}

// Batch fetch for multiple coins
export async function fetchFundingRates(coins: string[]): Promise<Record<string, FundingData>> {
  const results: Record<string, FundingData> = {}
  const promises = coins.map(async (coin) => {
    const symbol = `${coin}_USDT`
    const data = await fetchFundingRate(symbol)
    if (data) results[coin] = data
  })
  await Promise.all(promises)
  return results
}
