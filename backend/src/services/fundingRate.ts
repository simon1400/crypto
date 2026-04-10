// Funding rate из Bybit linear perpetual.
// Раньше был MEXC — переведено на Bybit чтобы данные совпадали с биржей торговли.

import { fetchBybitTicker } from './bybitMarket'

export interface FundingData {
  symbol: string
  fundingRate: number    // например 0.0001 = 0.01% за 8 часов
  nextFundingTime: number
}

export async function fetchFundingRate(symbol: string): Promise<FundingData | null> {
  // symbol может прийти как 'BTCUSDT' или 'BTC' — нормализуем
  const sym = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`
  const ticker = await fetchBybitTicker(sym)
  if (!ticker) return null
  return {
    symbol: sym,
    fundingRate: ticker.fundingRate,
    nextFundingTime: ticker.nextFundingTime,
  }
}

// Batch fetch для всех монет сканера за один проход
export async function fetchFundingRates(coins: string[]): Promise<Record<string, FundingData>> {
  const results: Record<string, FundingData> = {}
  // Делаем параллельно, но батчами чтобы не упереться в rate limit
  const BATCH_SIZE = 20
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (coin) => {
        const data = await fetchFundingRate(coin)
        if (data) results[coin] = data
      }),
    )
  }
  return results
}
