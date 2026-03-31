import { RestClientV5 } from 'bybit-api'
import { InstrumentInfo } from './types'

const cache = new Map<string, InstrumentInfo>()

export async function getInstrumentInfo(
  client: RestClientV5,
  symbol: string
): Promise<InstrumentInfo> {
  const cached = cache.get(symbol)
  if (cached) return cached

  const response = await client.getInstrumentsInfo({
    category: 'linear',
    symbol,
  })

  if (response.retCode !== 0 || !response.result.list.length) {
    throw new Error(
      `Failed to fetch instrument info for ${symbol}: ${(response as any).retMsg || 'empty result'}`
    )
  }

  const instrument = response.result.list[0] as any
  const info: InstrumentInfo = {
    symbol,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    tickSize: instrument.priceFilter.tickSize,
  }

  cache.set(symbol, info)
  return info
}

export function clearInstrumentCache(): void {
  cache.clear()
}
