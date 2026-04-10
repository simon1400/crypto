// Open Interest из Bybit linear perpetual.
// Раньше был MEXC, без change %. Теперь — Bybit с историей за последний час.

import { fetchBybitTicker, fetchBybitOIHistory } from './bybitMarket'

export interface OIData {
  symbol: string
  openInterest: number       // в base coins (например, BTC)
  openInterestUsd: number    // в USDT (notional)
  oiChangePct1h: number      // изменение OI за последний час, %
  oiChangePct4h: number      // изменение OI за последние 4 часа, %
}

/**
 * Получаем текущий OI + историю за 4 часа (1h интервал).
 * Считаем дельту: текущая точка vs точка 1h/4h назад.
 */
export async function fetchOpenInterest(symbol: string): Promise<OIData | null> {
  const sym = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`

  const [ticker, history] = await Promise.all([
    fetchBybitTicker(sym),
    fetchBybitOIHistory(sym, '1h', 5),
  ])

  if (!ticker) return null

  let oiChange1h = 0
  let oiChange4h = 0
  if (history.length >= 2) {
    const current = history[history.length - 1].oi
    const prev1h = history[history.length - 2].oi
    if (prev1h > 0) {
      oiChange1h = ((current - prev1h) / prev1h) * 100
    }
    if (history.length >= 5) {
      const prev4h = history[history.length - 5].oi
      if (prev4h > 0) {
        oiChange4h = ((current - prev4h) / prev4h) * 100
      }
    }
  }

  return {
    symbol: sym,
    openInterest: ticker.openInterest,
    openInterestUsd: ticker.openInterestValue,
    oiChangePct1h: Math.round(oiChange1h * 100) / 100,
    oiChangePct4h: Math.round(oiChange4h * 100) / 100,
  }
}

// Batch fetch для сканера
export async function fetchOpenInterests(coins: string[]): Promise<Record<string, OIData>> {
  const results: Record<string, OIData> = {}
  const BATCH_SIZE = 10 // OI history endpoint медленнее, держим меньше параллелизма
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (coin) => {
        const data = await fetchOpenInterest(coin)
        if (data) results[coin] = data
      }),
    )
  }
  return results
}
