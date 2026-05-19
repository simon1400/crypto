import type { BinanceFuturesClient, SymbolFilter } from '../exchanges/binanceFutures'
import { filtersCache, FILTERS_TTL_MS } from './state'

// Cache exchangeInfo filters for 1h — they don't change intraday and we'd
// otherwise hit /fapi/v1/exchangeInfo (weight 1) on every placement cycle.
export async function getFilters(client: BinanceFuturesClient): Promise<Map<string, SymbolFilter>> {
  const cached = filtersCache.current
  if (cached && Date.now() - cached.at < FILTERS_TTL_MS) return cached.map
  const map = await client.getSymbolFilters()
  filtersCache.current = { at: Date.now(), map }
  return map
}
