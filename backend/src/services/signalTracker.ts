import { prisma } from '../db/prisma'
import { fetchOHLCV_MEXC } from './market'

/**
 * Check prices for all active signals and update their status.
 * Called every hour via setInterval.
 */
export async function trackActiveSignals() {
  const signals = await prisma.signal.findMany({
    where: {
      status: { in: ['ENTRY_WAIT', 'ACTIVE'] },
      publishedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }, // last 2 weeks
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
  const symbol = signal.coin + 'USDT'
  const takeProfits = signal.takeProfits as number[]
  const priceHistory = (signal.priceHistory as { time: number; price: number }[]) || []

  // Fetch 1h candles since signal was published
  const hoursSince = Math.ceil((Date.now() - signal.publishedAt.getTime()) / (60 * 60 * 1000))
  const limit = Math.min(hoursSince + 2, 500)

  let candles
  try {
    candles = await fetchOHLCV_MEXC(symbol, '1h', limit)
  } catch {
    console.log(`[SignalTracker] Cannot fetch ${symbol} on MEXC, skipping`)
    return
  }

  // Filter candles after signal publication
  const signalTime = signal.publishedAt.getTime()
  const relevantCandles = candles.filter(c => c.time >= signalTime)

  if (relevantCandles.length === 0) return

  const currentPrice = relevantCandles[relevantCandles.length - 1].close

  // Update price history (keep hourly snapshots)
  const lastHistoryTime = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].time : 0
  for (const candle of relevantCandles) {
    if (candle.time > lastHistoryTime) {
      priceHistory.push({ time: candle.time, price: candle.close })
    }
  }

  let newStatus = signal.status
  let entryFilledAt = signal.entryFilledAt

  if (signal.status === 'ENTRY_WAIT') {
    // Check if price entered the entry zone
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
    // Check candles after entry for SL/TP hits
    const entryTime = entryFilledAt?.getTime() || signalTime
    const postEntryCandles = relevantCandles.filter(c => c.time >= entryTime)

    // Determine what was hit first and track max TP
    let maxTpHit = 0
    let slHit = false
    let slHitTime = Infinity

    // Find when SL was first hit
    for (const candle of postEntryCandles) {
      const slTriggered = signal.type === 'LONG'
        ? candle.low <= signal.stopLoss
        : candle.high >= signal.stopLoss

      if (slTriggered) {
        slHitTime = candle.time
        slHit = true
        break
      }
    }

    // Find max TP hit (only before SL was hit)
    for (const candle of postEntryCandles) {
      if (candle.time > slHitTime) break // stop checking TPs after SL

      for (let i = maxTpHit; i < takeProfits.length; i++) {
        const tpTriggered = signal.type === 'LONG'
          ? candle.high >= takeProfits[i]
          : candle.low <= takeProfits[i]

        if (tpTriggered) {
          maxTpHit = i + 1
        } else {
          break // TPs must be hit sequentially
        }
      }
    }

    if (maxTpHit > 0) {
      newStatus = `TP${maxTpHit}_HIT`
    } else if (slHit) {
      newStatus = 'SL_HIT'
    }
  }

  // Update DB
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
