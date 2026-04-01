import Decimal from 'decimal.js'
import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'
import { getInstrumentInfo } from './instrumentCache'

interface TickerResolution {
  bybitSymbol: string
  priceMultiplier: number
  mapped: boolean
}

const SEED_MAPPINGS = [
  { fromTicker: 'PEPE',  toSymbol: '1000PEPEUSDT',  priceMultiplier: 1000, notes: '1000x bundle' },
  { fromTicker: 'BONK',  toSymbol: '1000BONKUSDT',  priceMultiplier: 1000, notes: '1000x bundle' },
  { fromTicker: 'FLOKI', toSymbol: '1000FLOKIUSDT', priceMultiplier: 1000, notes: '1000x bundle' },
  { fromTicker: 'PLAY',  toSymbol: 'PLAYSOUTUSDT',  priceMultiplier: 1,    notes: 'Different name on Bybit' },
]

export async function seedTickerMappings(): Promise<void> {
  for (const seed of SEED_MAPPINGS) {
    await prisma.tickerMapping.upsert({
      where: { fromTicker: seed.fromTicker },
      update: {},
      create: seed,
    })
  }
  console.log('[TickerMapper] Seed mappings loaded')
}

export async function resolveBybitSymbol(signalCoin: string): Promise<TickerResolution | null> {
  // 1. Check DB for explicit mapping
  const mapping = await prisma.tickerMapping.findUnique({
    where: { fromTicker: signalCoin },
  })

  if (mapping) {
    return {
      bybitSymbol: mapping.toSymbol,
      priceMultiplier: mapping.priceMultiplier,
      mapped: true,
    }
  }

  // 2. Default: coin + 'USDT'
  const defaultSymbol = signalCoin + 'USDT'

  // 3. Validate against Bybit instrument cache
  try {
    const client = await createBybitClient()
    await getInstrumentInfo(client, defaultSymbol)
    return { bybitSymbol: defaultSymbol, priceMultiplier: 1, mapped: false }
  } catch {
    // Symbol not on Bybit
    return null
  }
}

export function adjustSignalPrices(signal: any, multiplier: number): void {
  if (multiplier === 1) return
  signal.entryMin = new Decimal(signal.entryMin).times(multiplier).toNumber()
  signal.entryMax = new Decimal(signal.entryMax).times(multiplier).toNumber()
  signal.stopLoss = new Decimal(signal.stopLoss).times(multiplier).toNumber()
  signal.takeProfits = (signal.takeProfits as number[]).map(
    tp => new Decimal(tp).times(multiplier).toNumber()
  )
}
