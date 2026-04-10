// Long/Short account ratio с Bybit.
// Используется как contrarian-фактор: когда крайности (>70% лонгов) — повод для шорта.

import { fetchBybitLongShortRatio, BybitLongShortRatio } from './bybitMarket'

export type LSRData = BybitLongShortRatio

export async function fetchLongShortRatios(coins: string[]): Promise<Record<string, LSRData>> {
  const results: Record<string, LSRData> = {}
  const BATCH_SIZE = 15
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (coin) => {
        const data = await fetchBybitLongShortRatio(`${coin}USDT`, '1h')
        if (data) results[coin] = data
      }),
    )
  }
  return results
}
