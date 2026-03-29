import { prisma } from '../db/prisma'
import { fetchOHLCV_MEXC, fetchCurrentPrice } from './market'

// Cache resolved symbols to avoid repeated lookups
const symbolCache: Record<string, string | null> = {}

/**
 * Auto-resolve the correct MEXC symbol for a coin ticker.
 * Tries COINUSDT first, then common suffixes (SOL, ETH, BASE, etc.)
 * Validates price is in the same ballpark as the signal entry.
 */
async function autoResolveSymbol(coin: string, entryPrice: number): Promise<string | null> {
  // Check cache first
  const cacheKey = coin
  if (cacheKey in symbolCache) return symbolCache[cacheKey]

  // Try direct symbol first
  const direct = coin + 'USDT'
  const directPrice = await fetchCurrentPrice(direct)
  if (directPrice != null) {
    const ratio = directPrice / entryPrice
    if (ratio >= 0.2 && ratio <= 5) {
      symbolCache[cacheKey] = direct
      console.log(`[SymbolResolver] ${coin} → ${direct} (price ${directPrice})`)
      return direct
    }
  }

  // Try common suffixes
  const suffixes = ['SOL', 'ETH', 'BASE', 'BNB', 'ARB', 'OP', 'AVAX', 'MATIC', 'SUI']
  for (const suffix of suffixes) {
    const candidate = coin + suffix + 'USDT'
    const price = await fetchCurrentPrice(candidate)
    if (price != null) {
      const ratio = price / entryPrice
      if (ratio >= 0.2 && ratio <= 5) {
        symbolCache[cacheKey] = candidate
        console.log(`[SymbolResolver] ${coin} → ${candidate} (price ${price})`)
        return candidate
      }
    }
  }

  // Nothing found
  symbolCache[cacheKey] = null
  console.log(`[SymbolResolver] ${coin} → no matching symbol found on MEXC`)
  return null
}

export function resolveSymbolFromCache(coin: string): string {
  return symbolCache[coin] || coin + 'USDT'
}

/**
 * Check prices for all active signals and update their status.
 * Called every hour via setInterval and after sync.
 */
export async function trackActiveSignals() {
  const signals = await prisma.signal.findMany({
    where: {
      status: { in: ['ENTRY_WAIT', 'ACTIVE'] },
    },
  })

  console.log(`[SignalTracker] Checking ${signals.length} active signals...`)

  for (const signal of signals) {
    try {
      await updateSignalStatus(signal)
    } catch (err) {
      console.error(`[SignalTracker] Error updating ${signal.coin}:`, err)
    }
  }
}

async function updateSignalStatus(signal: {
  id: number
  coin: string
  type: string
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: unknown
  status: string
  publishedAt: Date
  entryFilledAt: Date | null
  priceHistory: unknown
}) {
  const avgEntry = (signal.entryMin + signal.entryMax) / 2
  const symbol = await autoResolveSymbol(signal.coin, avgEntry)
  if (!symbol) return

  const takeProfits = signal.takeProfits as number[]
  const priceHistory = (signal.priceHistory as { time: number; price: number }[]) || []

  const hoursSince = Math.ceil((Date.now() - signal.publishedAt.getTime()) / (60 * 60 * 1000))

  // Use 4h candles for signals older than 18 days (to fit in 500 limit), otherwise 1h
  const use4h = hoursSince > 18 * 24
  const interval = use4h ? '4h' : '1h'
  const candlesSince = use4h ? Math.ceil(hoursSince / 4) : hoursSince
  const limit = Math.min(candlesSince + 2, 500)

  let candles
  try {
    candles = await fetchOHLCV_MEXC(symbol, interval, limit)
  } catch {
    console.log(`[SignalTracker] Cannot fetch ${symbol} on MEXC, skipping`)
    return
  }

  // Filter candles after signal publication
  const signalTime = signal.publishedAt.getTime()
  const relevantCandles = candles.filter(c => c.time >= signalTime)

  if (relevantCandles.length === 0) return

  // Double-check price sanity with actual candle data
  const candlePrice = relevantCandles[0].close
  const priceRatio = candlePrice / avgEntry
  if (priceRatio > 5 || priceRatio < 0.2) {
    console.log(`[SignalTracker] ${symbol} candle price mismatch: ${candlePrice} vs entry ${avgEntry}, skipping`)
    // Invalidate cache so it retries next time
    delete symbolCache[signal.coin]
    return
  }

  // Update price history (keep snapshots for chart)
  const lastHistoryTime = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].time : 0
  for (const candle of relevantCandles) {
    if (candle.time > lastHistoryTime) {
      priceHistory.push({ time: candle.time, price: candle.close })
    }
  }

  let newStatus = signal.status
  let entryFilledAt = signal.entryFilledAt

  if (signal.status === 'ENTRY_WAIT') {
    const entryCandle = relevantCandles.find(c => {
      if (signal.type === 'LONG') {
        return c.low <= signal.entryMax
      } else {
        return c.high >= signal.entryMin
      }
    })

    if (entryCandle) {
      newStatus = 'ACTIVE'
      entryFilledAt = new Date(entryCandle.time)
    }
  }

  if (newStatus === 'ACTIVE') {
    const entryTime = entryFilledAt?.getTime() || signalTime
    const postEntryCandles = relevantCandles.filter(c => c.time >= entryTime)

    let maxTpHit = 0
    let slHitTime = Infinity

    for (const candle of postEntryCandles) {
      const slTriggered = signal.type === 'LONG'
        ? candle.low <= signal.stopLoss
        : candle.high >= signal.stopLoss

      if (slTriggered) {
        slHitTime = candle.time
        break
      }
    }

    for (const candle of postEntryCandles) {
      if (candle.time > slHitTime) break

      for (let i = maxTpHit; i < takeProfits.length; i++) {
        const tpTriggered = signal.type === 'LONG'
          ? candle.high >= takeProfits[i]
          : candle.low <= takeProfits[i]

        if (tpTriggered) {
          maxTpHit = i + 1
        } else {
          break
        }
      }
    }

    if (maxTpHit > 0) {
      newStatus = `TP${maxTpHit}_HIT`
    } else if (slHitTime < Infinity) {
      newStatus = 'SL_HIT'
    }
  }

  await prisma.signal.update({
    where: { id: signal.id },
    data: {
      status: newStatus,
      entryFilledAt,
      statusUpdatedAt: new Date(),
      priceHistory,
    },
  })

  if (newStatus !== signal.status) {
    console.log(`[SignalTracker] ${signal.coin} ${signal.type}: ${signal.status} → ${newStatus}`)
  }
}
