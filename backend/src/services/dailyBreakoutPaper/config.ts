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
  return loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
}
