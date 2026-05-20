import { BreakoutVariant, configModel } from '../breakoutVariant'
import { OHLCV } from '../market'
import { loadHistorical } from '../../scalper/historicalLoader'
import { PaperConfig } from './types'

export async function getOrCreateConfig(variant: BreakoutVariant): Promise<PaperConfig | null> {
  try {
    const c = await (configModel(variant) as any).upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    return c as PaperConfig
  } catch (e: any) {
    if (e?.message?.includes('does not exist')) return null
    throw e
  }
}

export async function loadRecent5m(symbol: string): Promise<OHLCV[]> {
  // Mark Price klines — Binance triggers TP/SL on mark price, not on last
  // price. Paper tracker uses these so its TP/SL checks (c.high >= tp / c.low
  // <= sl) match what the exchange actually does on the live side. Note:
  // volume is always 0 on this endpoint; A/B/C scanners must not gate on vol.
  return loadHistorical(symbol, '5m', 1, 'binance-futures-mark')
}
