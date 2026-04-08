import { fetchOHLCV } from '../../services/market'
import { computeIndicators } from '../../services/indicators'
import { SCAN_COINS } from '../coinScanner'
import { runScalpStrategies, ScalpIndicators } from './strategies'
import { scoreScalpSignal } from './scoring'
import { calculateScalpRisk, ScalpSignalWithRisk } from './riskCalc'
import { ScalpScoreBreakdown } from './scoring'

// Scalp scanner — micro-timeframe mean reversion
// TFs: 1m (trigger), 5m (setup), 15m (context)
// Hold time: minutes (within 1h candle)
// Strategies: BB bounce, RSI snap, VWAP reversion

// Top coins for scalping — high liquidity, tight spread
// Subset of SCAN_COINS: only major coins with deep order books
const SCALP_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE',
  'ADA', 'AVAX', 'DOT', 'LINK', 'SUI', 'NEAR',
  'APT', 'INJ', 'TIA', 'SEI', 'ARB', 'OP',
  'PEPE', 'WIF', 'RENDER', 'FIL', 'AAVE',
  'ATOM', 'UNI', 'TON', 'HBAR', 'ICP',
  'TRX', 'ONDO',
]

export interface ScalpResult {
  signal: ScalpSignalWithRisk
  category: ScalpCategory
}

export type ScalpCategory =
  | 'SCALP_READY'      // Good setup, viable R:R, enter now
  | 'SCALP_WATCH'      // Setup forming, not yet at extreme
  | 'SCALP_RISKY'      // Setup present but conflicting signals or low volume
  | 'SCALP_REJECTED'   // Non-viable

export interface ScalpFunnel {
  coinsScanned: number
  fetchErrors: number
  strategyCandidates: number
  passedScoring: number
  passedRisk: number
  byStrategy: Record<string, number>
  byCategory: Record<string, number>
  final: number
}

let isScalpScanning = false

export function isScalpScannerRunning(): boolean {
  return isScalpScanning
}

function classifyScalp(signal: ScalpSignalWithRisk): ScalpCategory {
  if (!signal.viable) return 'SCALP_REJECTED'

  // Low volume = risky (can't exit fast)
  if (signal.scoreBreakdown.volume < 4) return 'SCALP_RISKY'

  // Setup forming but not extreme enough
  if (signal.score < 45) return 'SCALP_WATCH'

  // Context against us
  if (signal.scoreBreakdown.context < 3) return 'SCALP_RISKY'

  // Good to go
  if (signal.score >= 55 && signal.scoreBreakdown.alignment >= 8) return 'SCALP_READY'
  if (signal.score >= 50) return 'SCALP_WATCH'

  return 'SCALP_WATCH'
}

export async function runScalpScan(
  coins: string[] = SCALP_COINS,
  minScore = 35,
): Promise<{ results: ScalpResult[]; funnel: ScalpFunnel }> {
  if (isScalpScanning) throw new Error('Scalp scanner already running')
  isScalpScanning = true

  const funnel: ScalpFunnel = {
    coinsScanned: coins.length,
    fetchErrors: 0,
    strategyCandidates: 0,
    passedScoring: 0,
    passedRisk: 0,
    byStrategy: {},
    byCategory: {},
    final: 0,
  }

  try {
    console.log(`[ScalpScanner] Starting scan for ${coins.length} coins...`)

    // Fetch micro-TF candles
    const coinIndicators: Record<string, ScalpIndicators> = {}
    const fetchErrors: string[] = []

    // Batch 5 coins at a time with 300ms delay (faster than swing)
    for (let i = 0; i < coins.length; i += 5) {
      const batch = coins.slice(i, i + 5)
      const results = await Promise.all(
        batch.map(async (coin) => {
          try {
            const symbol = `${coin}USDT`
            const [candles1m, candles5m, candles15m] = await Promise.all([
              fetchOHLCV(symbol, '1m', 60),
              fetchOHLCV(symbol, '5m', 60),
              fetchOHLCV(symbol, '15m', 60),
            ])
            return {
              coin,
              indicators: {
                tf1m: computeIndicators(candles1m),
                tf5m: computeIndicators(candles5m),
                tf15m: computeIndicators(candles15m),
              } as ScalpIndicators,
            }
          } catch (err) {
            fetchErrors.push(coin)
            return null
          }
        })
      )

      for (const r of results) {
        if (r) coinIndicators[r.coin] = r.indicators
      }

      if (i + 5 < coins.length) {
        await new Promise(r => setTimeout(r, 300))
      }
    }

    funnel.fetchErrors = fetchErrors.length
    if (fetchErrors.length > 0) {
      console.warn(`[ScalpScanner] Failed to fetch: ${fetchErrors.join(', ')}`)
    }

    // Run strategies + scoring
    const scoredSignals: ReturnType<typeof scoreScalpSignal>[] = []

    for (const [coin, indicators] of Object.entries(coinIndicators)) {
      const p = indicators.tf5m.price
      if (!p || p <= 0 || !isFinite(p) || indicators.tf5m.atr <= 0) continue

      const rawSignal = runScalpStrategies(coin, indicators)
      if (!rawSignal) continue

      funnel.strategyCandidates++
      funnel.byStrategy[rawSignal.strategy] = (funnel.byStrategy[rawSignal.strategy] || 0) + 1

      const scored = scoreScalpSignal(rawSignal)

      if (scored.score < minScore) {
        continue
      }

      funnel.passedScoring++
      scoredSignals.push(scored)
    }

    scoredSignals.sort((a, b) => b.score - a.score)
    console.log(`[ScalpScanner] ${scoredSignals.length} signals above ${minScore}`)

    // Risk calc + classification
    const results: ScalpResult[] = []

    for (const scored of scoredSignals.slice(0, 15)) {
      const withRisk = calculateScalpRisk(scored)

      if (!withRisk.viable) {
        continue
      }

      funnel.passedRisk++
      const category = classifyScalp(withRisk)
      funnel.byCategory[category] = (funnel.byCategory[category] || 0) + 1

      if (category !== 'SCALP_REJECTED') {
        results.push({ signal: withRisk, category })
      }
    }

    funnel.final = results.length

    console.log(`[ScalpScanner] ===== SCALP FUNNEL =====`)
    console.log(`[ScalpScanner] Coins: ${funnel.coinsScanned} | Errors: ${funnel.fetchErrors}`)
    console.log(`[ScalpScanner] Candidates: ${funnel.strategyCandidates} | Scored: ${funnel.passedScoring}`)
    console.log(`[ScalpScanner] Viable: ${funnel.passedRisk} | Final: ${funnel.final}`)
    console.log(`[ScalpScanner] Strategies: ${JSON.stringify(funnel.byStrategy)}`)
    console.log(`[ScalpScanner] Categories: ${JSON.stringify(funnel.byCategory)}`)
    console.log(`[ScalpScanner] ========================`)

    return { results, funnel }
  } finally {
    isScalpScanning = false
  }
}
