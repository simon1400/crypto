import { fetchOHLCV, fetchMarketOverview } from '../services/market'
import { computeIndicators, MultiTFIndicators } from '../services/indicators'
import { fetchFundingRates } from '../services/fundingRate'
import { fetchOpenInterests } from '../services/openInterest'
import { fetchAllCoinNews } from '../services/news'
import { detectMarketRegime, RegimeContext } from './marketRegime'
import { runStrategies } from './strategies/index'
import { scoreSignal, ScoredSignal } from './scoring'
import { calculateRisk, SignalWithRisk } from './riskCalc'
import { gptFilterSignal, GPTReview } from './gptFilter'
import { prisma } from '../db/prisma'

// Default coins to scan
export const SCAN_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP',
  'ADA', 'AVAX', 'DOT', 'LINK', 'DOGE',
  'SUI', 'PEPE', 'WIF', 'ARB', 'OP',
  'NEAR', 'FET', 'RENDER', 'INJ', 'TIA',
]

export interface ScanResult {
  signal: SignalWithRisk
  gptReview: GPTReview
  regime: RegimeContext
}

let isScanning = false

export function isScannerRunning(): boolean {
  return isScanning
}

export async function runScan(
  coins: string[] = SCAN_COINS,
  minScore = 55,
  useGPT = true,
): Promise<ScanResult[]> {
  if (isScanning) throw new Error('Scanner already running')
  isScanning = true

  try {
    console.log(`[Scanner] Starting scan for ${coins.length} coins...`)

    // === Phase 1: Gather market data in parallel ===
    const [market, fundingMap, oiMap, newsMap] = await Promise.all([
      fetchMarketOverview(),
      fetchFundingRates(coins),
      fetchOpenInterests(coins),
      fetchAllCoinNews(coins.slice(0, 10)), // News only for top 10 to save rate limit
    ])

    // === Phase 2: Fetch OHLCV and compute indicators for all coins ===
    const coinIndicators: Record<string, MultiTFIndicators> = {}
    const fetchErrors: string[] = []

    // Process in batches of 5 to avoid rate limiting
    for (let i = 0; i < coins.length; i += 5) {
      const batch = coins.slice(i, i + 5)
      const results = await Promise.all(
        batch.map(async (coin) => {
          try {
            const symbol = `${coin}USDT`
            const [candles15m, candles1h, candles4h] = await Promise.all([
              fetchOHLCV(symbol, '15m', 60),
              fetchOHLCV(symbol, '1h', 60),
              fetchOHLCV(symbol, '4h', 60),
            ])
            return {
              coin,
              indicators: {
                tf15m: computeIndicators(candles15m),
                tf1h: computeIndicators(candles1h),
                tf4h: computeIndicators(candles4h),
              } as MultiTFIndicators,
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

      // Small delay between batches
      if (i + 5 < coins.length) {
        await new Promise(r => setTimeout(r, 500))
      }
    }

    if (fetchErrors.length > 0) {
      console.warn(`[Scanner] Failed to fetch: ${fetchErrors.join(', ')}`)
    }

    // === Phase 3: Detect market regime from BTC ===
    const btcInd = coinIndicators['BTC']
    const regime = btcInd
      ? detectMarketRegime({ tf1h: btcInd.tf1h, tf4h: btcInd.tf4h }, market)
      : { regime: 'RANGING' as const, confidence: 50, btcTrend: 'SIDEWAYS' as const, fearGreedZone: 'NEUTRAL' as const, volatility: 'NORMAL' as const }

    console.log(`[Scanner] Market regime: ${regime.regime} (${regime.confidence}%), BTC: ${regime.btcTrend}`)

    // === Phase 4: Run strategies on each coin ===
    const scoredSignals: ScoredSignal[] = []

    for (const [coin, indicators] of Object.entries(coinIndicators)) {
      const rawSignal = runStrategies(coin, indicators, regime.regime)
      if (!rawSignal) {
        console.log(`[Scanner] ${coin}: no strategy matched`)
        continue
      }

      const scored = scoreSignal(rawSignal, regime, fundingMap[coin], newsMap[coin])
      console.log(`[Scanner] ${coin}: ${rawSignal.strategy} ${rawSignal.type} confidence=${rawSignal.confidence}/${rawSignal.maxConfidence} score=${scored.score}`)

      if (scored.score >= minScore) {
        scoredSignals.push(scored)
      }
    }

    // Sort by score descending
    scoredSignals.sort((a, b) => b.score - a.score)
    console.log(`[Scanner] Found ${scoredSignals.length} signals above score ${minScore}`)

    // === Phase 5: Calculate risk for top signals ===
    const topSignals = scoredSignals.slice(0, 10) // Max 10 signals
    const signalsWithRisk = topSignals.map(s => calculateRisk(s))

    // Filter out signals with bad R:R
    const validSignals = signalsWithRisk.filter(s => {
      if (s.riskReward < 1.0) {
        console.log(`[Scanner] ${s.coin}: filtered out, R:R = ${s.riskReward}`)
        return false
      }
      return true
    })

    // === Phase 6: GPT filter (optional) ===
    const results: ScanResult[] = []

    for (const signal of validSignals) {
      let gptReview: GPTReview

      if (useGPT) {
        gptReview = await gptFilterSignal(
          signal,
          regime,
          fundingMap[signal.coin],
          newsMap[signal.coin],
          oiMap[signal.coin],
        )
      } else {
        gptReview = {
          verdict: 'CONFIRM',
          confidence: 5,
          adjustedEntry: null,
          adjustedSL: null,
          adjustedTP1: null,
          reasoning: 'GPT фильтр отключен',
          risks: [],
          keyLevels: [],
        }
      }

      // Apply GPT adjustments
      if (gptReview.adjustedEntry) signal.entry = gptReview.adjustedEntry
      if (gptReview.adjustedSL) signal.stopLoss = gptReview.adjustedSL
      if (gptReview.adjustedTP1 && signal.takeProfits[0]) {
        signal.takeProfits[0].price = gptReview.adjustedTP1
      }

      results.push({ signal, gptReview, regime })
    }

    // === Phase 7: Save confirmed signals to DB ===
    const confirmedResults = results.filter(r => r.gptReview.verdict === 'CONFIRM')

    for (const r of confirmedResults) {
      try {
        await prisma.generatedSignal.create({
          data: {
            coin: r.signal.coin,
            type: r.signal.type,
            strategy: r.signal.strategy,
            score: r.signal.score,
            entry: r.signal.entry,
            stopLoss: r.signal.stopLoss,
            takeProfits: r.signal.takeProfits as any,
            leverage: r.signal.leverage,
            positionPct: r.signal.positionPct,
            indicators: JSON.parse(JSON.stringify(coinIndicators[r.signal.coin])),
            marketContext: JSON.parse(JSON.stringify({
              regime: regime.regime,
              regimeConfidence: regime.confidence,
              btcTrend: regime.btcTrend,
              fearGreedZone: regime.fearGreedZone,
              volatility: regime.volatility,
              scoreBreakdown: r.signal.scoreBreakdown,
              funding: fundingMap[r.signal.coin] ?? null,
              oi: oiMap[r.signal.coin] ?? null,
              news: newsMap[r.signal.coin] ?? null,
            })),
            aiAnalysis: `${r.gptReview.reasoning}\n\nРиски: ${r.gptReview.risks.join('; ')}\nУровни: ${r.gptReview.keyLevels.join('; ')}`,
            status: 'NEW',
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
          },
        })
      } catch (err) {
        console.error(`[Scanner] Failed to save signal for ${r.signal.coin}:`, err)
      }
    }

    console.log(`[Scanner] Scan complete. ${confirmedResults.length} signals confirmed by GPT, ${results.length - confirmedResults.length} rejected`)

    return results
  } finally {
    isScanning = false
  }
}

// Expire old signals
export async function expireOldSignals(): Promise<number> {
  const result = await prisma.generatedSignal.updateMany({
    where: {
      status: 'NEW',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  })
  return result.count
}
