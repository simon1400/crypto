import { prisma } from '../db/prisma'
import { fetchOHLCV, fetchPricesBatch } from './market'
import { computeIndicators } from './indicators'
import { cancelPendingTrade } from './tradeClose'

// === Integrity lifecycle states ===
export type IntegrityLifecycle = 'ACTIVE' | 'STALKING' | 'STALE' | 'INVALIDATED'

export interface IntegrityState {
  enabled: boolean
  lifecycle: IntegrityLifecycle
  lastCheckedAt: string  // ISO datetime
  createdAt: string      // when monitoring started
  reason?: string        // invalidation reason
  checksRun: number      // counter
}

// === TTL constants ===
const TTL_DEFAULT_HOURS = 12
const TTL_A_PLUS_HOURS = 24
const DISTANCE_ATR_THRESHOLD = 1.2  // enable monitoring if preferred entry > 1.2 ATR
const STALKING_ATR_THRESHOLD = 0.5  // ACTIVE -> STALKING when price within 0.5 ATR of entry
const STALE_AGE_HOURS = 8           // ACTIVE/STALKING -> STALE after 8 hours
const RATE_LIMIT_DELAY_MS = 200     // delay between signals if > 5

/**
 * Main integrity monitoring function.
 * Runs every 15 minutes via setInterval in index.ts.
 * Checks all NEW LIMIT signals for setup validity.
 */
export async function checkSignalIntegrity(): Promise<void> {
  try {
    // Query all NEW LIMIT signals
    const signals = await prisma.generatedSignal.findMany({
      where: {
        status: 'NEW',
        executionType: { contains: 'LIMIT' },
      },
    })

    if (!signals.length) return

    console.log(`[IntegrityMonitor] Checking ${signals.length} pending LIMIT signal(s)...`)

    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i]

      try {
        // Rate-limit: add delay if > 5 signals
        if (i > 0 && signals.length > 5) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS))
        }

        await processSignalIntegrity(signal)
      } catch (err) {
        console.error(`[IntegrityMonitor] Error processing ${signal.coin} #${signal.id}:`, err)
      }
    }
  } catch (err) {
    console.error('[IntegrityMonitor] Fatal error in checkSignalIntegrity:', err)
  }
}

/**
 * Process integrity check for a single signal.
 */
async function processSignalIntegrity(signal: any): Promise<void> {
  const marketContext = (signal.marketContext as any) || {}
  let integrityState: IntegrityState = marketContext.integrity

  // === Step 1: Initialize integrity state if not present ===
  if (!integrityState) {
    const distanceAtr = getPreferredDistanceAtr(marketContext)

    if (distanceAtr === null) {
      // Cannot determine distance — skip this signal
      return
    }

    if (distanceAtr <= DISTANCE_ATR_THRESHOLD) {
      // Entry too close — no monitoring needed
      integrityState = {
        enabled: false,
        lifecycle: 'ACTIVE',
        lastCheckedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        checksRun: 0,
      }
      await updateMarketContext(signal.id, marketContext, integrityState)
      return
    }

    // Enable monitoring for far entries (> 1.2 ATR)
    integrityState = {
      enabled: true,
      lifecycle: 'ACTIVE',
      lastCheckedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      checksRun: 0,
    }
    console.log(`[IntegrityMonitor] Enabled monitoring for ${signal.coin} #${signal.id} (distance: ${distanceAtr} ATR)`)
    await updateMarketContext(signal.id, marketContext, integrityState)
  }

  // === Step 2: Skip disabled monitoring ===
  if (!integrityState.enabled) return

  // Already invalidated — skip
  if (integrityState.lifecycle === 'INVALIDATED') return

  // === Step 3: Fetch fresh 1H klines and compute indicators ===
  const candles = await fetchOHLCV(signal.coin + 'USDT', '1h', 60)
  if (!candles || candles.length < 20) {
    console.warn(`[IntegrityMonitor] Insufficient kline data for ${signal.coin} — skipping`)
    return
  }

  const indicators = computeIndicators(candles)

  // Fetch current price
  const prices = await fetchPricesBatch([signal.coin + 'USDT'])
  const currentPrice = prices[signal.coin + 'USDT'] || prices[signal.coin] || indicators.price

  const signalType = extractSignalType(signal)
  const entryPrice = signal.entryPrice || marketContext.limit_entry_plan?.preferred_limit_price

  // === Step 4: Lifecycle transitions ===
  const now = new Date()
  const signalAgeHours = (now.getTime() - new Date(signal.createdAt).getTime()) / (1000 * 60 * 60)
  const atr = indicators.atr || 1

  let newLifecycle = integrityState.lifecycle

  // Transition ACTIVE -> STALKING: price within 0.5 ATR of entry
  if (integrityState.lifecycle === 'ACTIVE' && entryPrice) {
    const distanceToEntry = Math.abs(currentPrice - entryPrice)
    if (distanceToEntry <= STALKING_ATR_THRESHOLD * atr) {
      newLifecycle = 'STALKING'
      console.log(`[IntegrityMonitor] ${signal.coin} #${signal.id} → STALKING (price ${currentPrice} within ${STALKING_ATR_THRESHOLD} ATR of entry ${entryPrice})`)
    }
  }

  // Transition ACTIVE/STALKING -> STALE: signal age > 8 hours
  if ((newLifecycle === 'ACTIVE' || newLifecycle === 'STALKING') && signalAgeHours > STALE_AGE_HOURS) {
    newLifecycle = 'STALE'
    console.log(`[IntegrityMonitor] ${signal.coin} #${signal.id} → STALE (age: ${signalAgeHours.toFixed(1)}h > ${STALE_AGE_HOURS}h)`)
  }

  // === Step 5: TTL enforcement (INTEG-04) ===
  const ttlHours = signal.setupCategory === 'A_PLUS_READY' ? TTL_A_PLUS_HOURS : TTL_DEFAULT_HOURS

  if (signalAgeHours > ttlHours) {
    await invalidateSignal(signal, integrityState, marketContext, 'TTL_EXPIRED', newLifecycle)
    return
  }

  // === Step 6: Integrity checks (INTEG-03) ===
  // Run for ACTIVE, STALKING, STALE — all non-invalidated states
  const invalidationReason = runIntegrityChecks(indicators, signalType)

  if (invalidationReason) {
    await invalidateSignal(signal, integrityState, marketContext, invalidationReason, newLifecycle)
    return
  }

  // === Step 7: Update state for passing signals ===
  const updatedState: IntegrityState = {
    ...integrityState,
    lifecycle: newLifecycle,
    lastCheckedAt: now.toISOString(),
    checksRun: integrityState.checksRun + 1,
  }

  await updateMarketContext(signal.id, marketContext, updatedState)
}

/**
 * Run integrity checks against fresh indicators.
 * Returns invalidation reason string or null if all checks pass.
 */
function runIntegrityChecks(
  indicators: ReturnType<typeof computeIndicators>,
  signalType: 'LONG' | 'SHORT',
): string | null {
  const isLong = signalType === 'LONG'

  // === HH/HL structure check ===
  // For LONG: fully bearish (LH_LL) structure = invalidate
  // For SHORT: fully bullish (HH_HL) structure = invalidate
  if (isLong && indicators.marketStructure === 'LH_LL') {
    return 'STRUCTURE_BREAK'
  }
  if (!isLong && indicators.marketStructure === 'HH_HL') {
    return 'STRUCTURE_BREAK'
  }

  // === RSI degradation check ===
  // For LONG: RSI > 75 = overextended, price ran away from entry zone
  // For SHORT: RSI < 25 = overextended, price ran away below entry zone
  if (isLong && indicators.rsi > 75) {
    return 'RSI_OVEREXTENSION'
  }
  if (!isLong && indicators.rsi < 25) {
    return 'RSI_OVEREXTENSION'
  }

  // === Volume anomaly check ===
  // volRatio < 0.5 indicates extreme volume drought — setup may not fill
  if (indicators.volRatio < 0.5) {
    return 'VOLUME_ANOMALY'
  }

  return null
}

/**
 * Invalidate a signal: update status to INVALIDATED, cancel linked PENDING_ENTRY trade.
 */
async function invalidateSignal(
  signal: any,
  integrityState: IntegrityState,
  marketContext: any,
  reason: string,
  lifecycle: IntegrityLifecycle,
): Promise<void> {
  console.log(`[IntegrityMonitor] INVALIDATED ${signal.coin} #${signal.id}: ${reason}`)

  const updatedState: IntegrityState = {
    ...integrityState,
    lifecycle: 'INVALIDATED',
    lastCheckedAt: new Date().toISOString(),
    checksRun: integrityState.checksRun + 1,
    reason,
  }

  // Update signal status to INVALIDATED
  await prisma.generatedSignal.update({
    where: { id: signal.id },
    data: {
      status: 'INVALIDATED',
      marketContext: {
        ...marketContext,
        integrity: updatedState,
      },
    },
  })

  // Find and cancel linked PENDING_ENTRY trade
  try {
    const linkedTrade = await prisma.trade.findFirst({
      where: {
        notes: { contains: `Scanner signal #${signal.id}` },
        status: 'PENDING_ENTRY',
      },
    })

    if (linkedTrade) {
      await cancelPendingTrade(linkedTrade, 'INTEGRITY_' + reason)
      console.log(`[IntegrityMonitor] Cancelled PENDING_ENTRY trade #${linkedTrade.id} for ${signal.coin} — reason: INTEGRITY_${reason}`)
    }
  } catch (err) {
    console.error(`[IntegrityMonitor] Error cancelling linked trade for ${signal.coin} #${signal.id}:`, err)
  }
}

/**
 * Update marketContext with new integrity state (non-invalidating update).
 */
async function updateMarketContext(
  signalId: number,
  marketContext: any,
  integrityState: IntegrityState,
): Promise<void> {
  await prisma.generatedSignal.update({
    where: { id: signalId },
    data: {
      marketContext: {
        ...marketContext,
        integrity: integrityState,
      },
    },
  })
}

/**
 * Extract preferred candidate distance_atr from marketContext.
 * Returns null if not available.
 */
function getPreferredDistanceAtr(marketContext: any): number | null {
  try {
    const plan = marketContext?.limit_entry_plan
    if (!plan) return null

    const preferred = plan.candidates?.preferred
    if (!preferred) return null

    const dist = preferred.distance_atr
    if (typeof dist !== 'number') return null

    return dist
  } catch {
    return null
  }
}

/**
 * Extract signal type (LONG or SHORT) from signal.
 * Falls back to 'LONG' if unclear.
 */
function extractSignalType(signal: any): 'LONG' | 'SHORT' {
  if (signal.type === 'LONG' || signal.type === 'SHORT') return signal.type
  if (signal.executionType?.includes('LONG')) return 'LONG'
  if (signal.executionType?.includes('SHORT')) return 'SHORT'
  return 'LONG'
}
