import { prisma } from '../db/prisma'
import { computeIndicators } from '../services/indicators'
import { sendNotification } from '../services/notifier'
import { fetchForexOHLCV, isForexProviderConfigured } from './dataProvider'
import { currentSession, isForexMarketOpen } from './sessions'
import { scoreForexSetup, computeForexLevels } from './scoring'

export const FOREX_INSTRUMENTS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'XAUUSD',
  'US30',
  'NAS100',
  'GBPJPY',
] as const

export type ForexInstrument = (typeof FOREX_INSTRUMENTS)[number]

interface ScanState {
  isRunning: boolean
  lastRunAt: Date | null
  lastRunDurationMs: number | null
  lastError: string | null
  lastSignalsCount: number
}

const state: ScanState = {
  isRunning: false,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastError: null,
  lastSignalsCount: 0,
}

export function getForexScanState(): ScanState {
  return { ...state }
}

export interface ForexScanResult {
  instrumentsScanned: number
  signalsCreated: number
  errors: { instrument: string; message: string }[]
  skipped: boolean
  skipReason?: string
}

// Expire forex signals older than 4 hours (intraday setups go stale fast)
const SIGNAL_EXPIRY_MS = 4 * 60 * 60 * 1000

export async function runForexScan(opts: { force?: boolean } = {}): Promise<ForexScanResult> {
  if (state.isRunning) {
    return {
      instrumentsScanned: 0,
      signalsCreated: 0,
      errors: [],
      skipped: true,
      skipReason: 'Scan already running',
    }
  }

  if (!isForexProviderConfigured()) {
    return {
      instrumentsScanned: 0,
      signalsCreated: 0,
      errors: [],
      skipped: true,
      skipReason: 'TWELVE_DATA_API_KEY not configured',
    }
  }

  if (!opts.force && !isForexMarketOpen()) {
    return {
      instrumentsScanned: 0,
      signalsCreated: 0,
      errors: [],
      skipped: true,
      skipReason: 'Forex market closed (weekend)',
    }
  }

  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  const minScore = config?.forexScanMinScore ?? 70

  state.isRunning = true
  state.lastError = null
  const startedAt = Date.now()
  const errors: { instrument: string; message: string }[] = []
  let signalsCreated = 0

  try {
    const session = currentSession()

    for (const instrument of FOREX_INSTRUMENTS) {
      try {
        // Fetch all 3 TFs for this instrument
        const [m30Candles, h1Candles, h4Candles] = await Promise.all([
          fetchForexOHLCV(instrument, '30m', 100),
          fetchForexOHLCV(instrument, '1h', 200),
          fetchForexOHLCV(instrument, '4h', 200),
        ])

        if (m30Candles.length < 50 || h1Candles.length < 50 || h4Candles.length < 50) {
          errors.push({ instrument, message: 'Недостаточно свечей для анализа' })
          continue
        }

        const m30 = computeIndicators(m30Candles)
        const h1 = computeIndicators(h1Candles)
        const h4 = computeIndicators(h4Candles)

        const score = scoreForexSetup({ m30, h1, h4 })

        if (score.setupType === null || score.total < minScore) {
          continue
        }

        const levels = computeForexLevels(score.setupType, { m30, h1, h4 })

        // Validate R:R and price sanity
        if (!Number.isFinite(levels.entry) || !Number.isFinite(levels.stopLoss)) {
          errors.push({ instrument, message: 'Некорректные уровни (NaN)' })
          continue
        }
        if (levels.rr < 1.2) continue // skip poor R:R

        // Dedupe: skip if NEW signal already exists for this instrument in the last 4 hours
        const cutoff = new Date(Date.now() - SIGNAL_EXPIRY_MS)
        const existing = await prisma.generatedSignal.findFirst({
          where: {
            coin: instrument,
            market: 'FOREX',
            status: 'NEW',
            createdAt: { gte: cutoff },
          },
        })
        if (existing) continue

        const expiresAt = new Date(Date.now() + SIGNAL_EXPIRY_MS)

        const signal = await prisma.generatedSignal.create({
          data: {
            coin: instrument,
            type: score.setupType,
            strategy: 'trend_follow',
            score: score.total,
            entry: levels.entry,
            stopLoss: levels.stopLoss,
            takeProfits: levels.takeProfits as any,
            leverage: 1, // MT5 lot sizing handled on frontend
            positionPct: 0,
            amount: 0,
            indicators: {
              m30: { trendDetail: m30.trendDetail, rsi: m30.rsi, adx: m30.adx },
              h1: {
                trendDetail: h1.trendDetail,
                rsi: h1.rsi,
                adx: h1.adx,
                atr: h1.atr,
                macd: h1.macd,
                macdSignal: h1.macdSignal,
                stochK: h1.stochK,
                stochD: h1.stochD,
                ema20: h1.ema20,
                ema50: h1.ema50,
                ema200: h1.ema200,
                support: h1.support,
                resistance: h1.resistance,
                pivot: h1.pivot,
                marketStructure: h1.marketStructure,
              },
              h4: { trendDetail: h4.trendDetail, rsi: h4.rsi, ema200: h4.ema200 },
            } as any,
            marketContext: {
              session,
              scoreBreakdown: {
                trend: score.trend,
                momentum: score.momentum,
                structure: score.structure,
              },
              reasons: score.reasons,
            } as any,
            status: 'NEW',
            expiresAt,
            market: 'FOREX',
            session,
          },
        })

        signalsCreated++

        // Telegram push
        try {
          await sendNotification('FOREX_SIGNAL_NEW' as any, {
            instrument,
            type: score.setupType,
            score: score.total,
            entry: levels.entry,
            stopLoss: levels.stopLoss,
            takeProfits: levels.takeProfits,
            rr: levels.rr,
            session,
            reasons: score.reasons,
            atr: h1.atr,
            signalId: signal.id,
          })
        } catch (notifyErr: any) {
          console.warn(`[ForexScanner] Notification failed: ${notifyErr.message}`)
        }

        console.log(
          `[ForexScanner] Signal #${signal.id} ${instrument} ${score.setupType} score=${score.total} rr=${levels.rr}`,
        )
      } catch (err: any) {
        const msg = err?.message || String(err)
        errors.push({ instrument, message: msg })
        console.warn(`[ForexScanner] ${instrument} failed: ${msg}`)
      }
    }

    state.lastRunAt = new Date()
    state.lastRunDurationMs = Date.now() - startedAt
    state.lastSignalsCount = signalsCreated

    // Update BotConfig.forexLastScanAt
    await prisma.botConfig.update({
      where: { id: 1 },
      data: { forexLastScanAt: state.lastRunAt },
    }).catch(() => {}) // BotConfig may not exist on first boot

    console.log(
      `[ForexScanner] Scan complete: ${signalsCreated} signals, ${errors.length} errors, ${state.lastRunDurationMs}ms`,
    )

    return {
      instrumentsScanned: FOREX_INSTRUMENTS.length,
      signalsCreated,
      errors,
      skipped: false,
    }
  } catch (err: any) {
    state.lastError = err?.message || String(err)
    console.error('[ForexScanner] Scan failed:', err)
    throw err
  } finally {
    state.isRunning = false
  }
}

// Expire old forex signals (older than 4h and still NEW)
export async function expireForexSignals() {
  const cutoff = new Date(Date.now() - SIGNAL_EXPIRY_MS)
  const { count } = await prisma.generatedSignal.updateMany({
    where: {
      market: 'FOREX',
      status: 'NEW',
      createdAt: { lt: cutoff },
    },
    data: { status: 'EXPIRED' },
  })
  if (count > 0) {
    console.log(`[ForexScanner] Expired ${count} stale signals`)
  }
}

let scanInterval: NodeJS.Timeout | null = null
let expireInterval: NodeJS.Timeout | null = null

// Called from backend/src/index.ts on boot
export function startForexScanner() {
  if (!isForexProviderConfigured()) {
    console.warn('[ForexScanner] TWELVE_DATA_API_KEY not set — scanner disabled')
    return
  }

  // Run once on boot (async, don't block)
  runForexScan().catch((err) => console.error('[ForexScanner] Boot scan failed:', err))

  // Hourly scans
  scanInterval = setInterval(
    () => {
      runForexScan().catch((err) => console.error('[ForexScanner] Interval scan failed:', err))
    },
    60 * 60 * 1000,
  )

  // Expire old signals every 30 min
  expireInterval = setInterval(
    () => {
      expireForexSignals().catch((err) => console.error('[ForexScanner] Expire failed:', err))
    },
    30 * 60 * 1000,
  )

  console.log('[ForexScanner] Started: hourly scans + 30min expiration check')
}

export function stopForexScanner() {
  if (scanInterval) clearInterval(scanInterval)
  if (expireInterval) clearInterval(expireInterval)
  scanInterval = null
  expireInterval = null
}
