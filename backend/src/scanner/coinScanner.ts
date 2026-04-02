import { fetchOHLCV, fetchMarketOverview } from '../services/market'
import { computeIndicators, MultiTFIndicators } from '../services/indicators'
import { fetchFundingRates } from '../services/fundingRate'
import { fetchOpenInterests } from '../services/openInterest'
import { fetchAllCoinNews } from '../services/news'
import { detectMarketRegime, RegimeContext } from './marketRegime'
import { runStrategies } from './strategies/index'
import { scoreSignal, ScoredSignal } from './scoring'
import { calculateRisk, SignalWithRisk } from './riskCalc'
import { gptAnnotateSignal, GPTAnnotation } from './gptFilter'
import { prisma } from '../db/prisma'

// Default coins to scan
export const SCAN_COINS = [
  // Layer 1 (25)
  'SOL', 'BNB', 'XRP', 'ADA', 'AVAX',
  'DOT', 'NEAR', 'SUI', 'SEI', 'TIA',
  'INJ', 'APT', 'FTM', 'ATOM', 'ALGO',
  'HBAR', 'ICP', 'FIL', 'VET', 'EGLD',
  'KAS', 'TON', 'TRX', 'EOS', 'XLM',
  // Memes (20)
  'DOGE', 'PEPE', 'WIF', 'FLOKI', 'BONK',
  'SHIB', 'TURBO', 'MEME', 'NEIRO', 'PEOPLE',
  'ACT', 'PNUT', 'BOME', 'MYRO', 'MEW',
  'DOGS', 'NOT', 'BRETT', 'SPX', 'BABYDOGE',
  // AI & DePIN (15)
  'FET', 'RENDER', 'GRT', 'TAO', 'RNDR',
  'AKT', 'AR', 'AIOZ', 'IO', 'GLM',
  'OCEAN', 'THETA', 'IOTX', 'MOBILE', 'HNT',
  // DeFi (20)
  'LINK', 'AAVE', 'CRV', 'LDO', 'PENDLE',
  'JUP', 'ONDO', 'RUNE', 'UNI', 'MKR',
  'COMP', 'SNX', 'SUSHI', 'CAKE', 'RAY',
  'DYDX', 'GMX', 'BANANA', 'MORPHO', '1INCH',
  // Layer 2 & Infra (15)
  'ARB', 'OP', 'STRK', 'MANTA', 'BLAST',
  'IMX', 'MATIC', 'ZK', 'METIS', 'CELO',
  'ZRO', 'W', 'ALT', 'MODE', 'SCROLL',
  // Gaming & Metaverse (15)
  'GALA', 'SAND', 'AXS', 'ENJ', 'PIXEL',
  'PORTAL', 'SUPER', 'YGG', 'BIGTIME', 'PRIME',
  'RONIN', 'BEAM', 'XMON', 'GODS', 'ILV',
  // Mid-cap volatile (15)
  'STX', 'ENS', 'JASMY', 'CHZ', 'MASK',
  'TRB', 'ORDI', 'WLD', 'PYTH', 'JTO',
  'BLUR', 'AGI', 'ARKM', 'AEVO', 'ENA',
]

// Signal categories — not just "signal or nothing"
export type SignalCategory =
  | 'READY'              // Good setup, all models viable, can enter now
  | 'WATCHLIST'          // Decent setup but needs better entry or more confirmation
  | 'WAIT_CONFIRMATION'  // Setup detected but key level not yet broken/held
  | 'LATE_ENTRY'         // Setup was good but price moved, only aggressive entry left
  | 'CONFLICTED'         // Indicators conflict, risky
  | 'REJECTED'           // Setup too weak or all models non-viable

export interface ScanResult {
  signal: SignalWithRisk
  gptAnnotation: GPTAnnotation
  regime: RegimeContext
  category: SignalCategory
}

// Funnel analytics — track where signals get filtered
export interface ScanFunnel {
  coinsScanned: number
  fetchErrors: number
  strategyCandidates: number
  rejectedByVolume: number
  passedScoring: number
  rejectedByRR: number     // all 3 entry models non-viable
  passedRisk: number
  byStrategy: Record<string, number>
  byCategory: Record<SignalCategory, number>
  final: number
}

let isScanning = false

export function isScannerRunning(): boolean {
  return isScanning
}

// REJECTED = rare, structural/technical only. NOT for "weak setups".
// CONFLICTED = strong cross-layer contradictions (2+ between direction/structure/context)
function classifySignal(signal: SignalWithRisk, gpt: GPTAnnotation): SignalCategory {
  const viableModels = signal.entryModels.filter(m => m.viable)

  // === REJECTED: only structural/data issues ===
  // 1. No viable entry model at all (all R:R below strategy minimum)
  if (viableModels.length === 0) return 'REJECTED'
  // 2. Quality F = structurally broken (GPT found critical data/logic issue)
  if (gpt.setupQuality === 'F') return 'REJECTED'

  // === CONFLICTED: strong cross-layer contradictions only ===
  // Need 2+ STRONG conflicts between: direction vs 4h bias, strategy vs regime, entry vs structure
  // Weak conflicts (e.g. 15m doesn't match) are NOT conflicts — just lower score
  const strongConflicts = detectStrongConflicts(signal, gpt)
  if (strongConflicts >= 2) return 'CONFLICTED'

  // === WAIT_CONFIRMATION ===
  if (gpt.waitForConfirmation && gpt.recommendedEntryType === 'confirmation') {
    return 'WAIT_CONFIRMATION'
  }

  // === LATE_ENTRY: only aggressive viable, others failed ===
  if (viableModels.length === 1 && viableModels[0].type === 'aggressive') {
    return 'LATE_ENTRY'
  }

  // === READY: good setup with actionable entries ===
  if (signal.score >= 60 && viableModels.length >= 2 && (gpt.setupQuality === 'A' || gpt.setupQuality === 'B')) {
    return 'READY'
  }

  // === WATCHLIST: everything else that isn't broken ===
  return 'WATCHLIST'
}

// Detect strong cross-layer contradictions (not weak disagreements)
function detectStrongConflicts(signal: SignalWithRisk, gpt: GPTAnnotation): number {
  let conflicts = 0
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'

  // 1. Direction vs 4h bias: LONG but 4h clearly bearish (or vice versa)
  if (isLong && tf4h.trend === 'BEARISH' && tf4h.adx > 25) conflicts++
  if (!isLong && tf4h.trend === 'BULLISH' && tf4h.adx > 25) conflicts++

  // 2. Breakout LONG right into major resistance (or SHORT into support)
  if (signal.strategy === 'breakout') {
    if (isLong && tf1h.price > tf4h.resistance * 0.99) conflicts++
    if (!isLong && tf1h.price < tf4h.support * 1.01) conflicts++
  }

  // 3. Trend follow but funding/context strongly against
  if (signal.strategy === 'trend_follow') {
    const mc = signal.scoreBreakdown.marketContext
    if (mc <= 1) conflicts++ // market context is actively against this direction
  }

  // 4. Mean reversion but market isn't actually ranging (regime mismatch)
  // This shouldn't happen due to strategy filter, but catch edge cases
  if (signal.strategy === 'mean_revert' && tf4h.adx > 30) conflicts++

  // 5. GPT found 2+ explicit conflicts
  if (gpt.conflicts.length >= 2) conflicts++

  return conflicts
}

// Classify without GPT annotation (when GPT is off)
function classifySignalNoGPT(signal: SignalWithRisk): SignalCategory {
  const viableModels = signal.entryModels.filter(m => m.viable)

  // REJECTED: only if no viable models
  if (viableModels.length === 0) return 'REJECTED'

  // Check for strong structural conflicts without GPT
  const { tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'
  let conflicts = 0
  if (isLong && tf4h.trend === 'BEARISH' && tf4h.adx > 25) conflicts++
  if (!isLong && tf4h.trend === 'BULLISH' && tf4h.adx > 25) conflicts++
  if (signal.strategy === 'breakout') {
    if (isLong && signal.indicators.tf1h.price > tf4h.resistance * 0.99) conflicts++
    if (!isLong && signal.indicators.tf1h.price < tf4h.support * 1.01) conflicts++
  }
  if (conflicts >= 2) return 'CONFLICTED'

  if (viableModels.length === 1 && viableModels[0].type === 'aggressive') {
    return 'LATE_ENTRY'
  }

  if (signal.score >= 60 && viableModels.length >= 2) {
    return 'READY'
  }

  return 'WATCHLIST'
}

export async function runScan(
  coins: string[] = SCAN_COINS,
  minScore = 40, // lowered from 55 — we now show WATCHLIST/WAIT signals too
  useGPT = true,
): Promise<{ results: ScanResult[]; funnel: ScanFunnel }> {
  if (isScanning) throw new Error('Scanner already running')
  isScanning = true

  const funnel: ScanFunnel = {
    coinsScanned: coins.length,
    fetchErrors: 0,
    strategyCandidates: 0,
    rejectedByVolume: 0,
    passedScoring: 0,
    rejectedByRR: 0,
    passedRisk: 0,
    byStrategy: {},
    byCategory: { READY: 0, WATCHLIST: 0, WAIT_CONFIRMATION: 0, LATE_ENTRY: 0, CONFLICTED: 0, REJECTED: 0 },
    final: 0,
  }

  try {
    console.log(`[Scanner] Starting scan for ${coins.length} coins...`)

    // === Phase A: Discovery — Gather market data ===
    const [market, fundingMap, oiMap, newsMap] = await Promise.all([
      fetchMarketOverview(),
      fetchFundingRates(coins),
      fetchOpenInterests(coins),
      fetchAllCoinNews(coins.slice(0, 10)),
    ])

    // === Phase A cont: Fetch OHLCV and compute indicators ===
    const coinIndicators: Record<string, MultiTFIndicators> = {}
    const fetchErrors: string[] = []

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

      if (i + 5 < coins.length) {
        await new Promise(r => setTimeout(r, 500))
      }
    }

    funnel.fetchErrors = fetchErrors.length
    if (fetchErrors.length > 0) {
      console.warn(`[Scanner] Failed to fetch: ${fetchErrors.join(', ')}`)
    }

    // === Phase A cont: Detect market regime ===
    let btcInd = coinIndicators['BTC']
    if (!btcInd) {
      try {
        const [btc1h, btc4h] = await Promise.all([
          fetchOHLCV('BTCUSDT', '1h', 60),
          fetchOHLCV('BTCUSDT', '4h', 60),
        ])
        btcInd = { tf15m: computeIndicators(btc1h), tf1h: computeIndicators(btc1h), tf4h: computeIndicators(btc4h) }
      } catch {}
    }
    const regime = btcInd
      ? detectMarketRegime({ tf1h: btcInd.tf1h, tf4h: btcInd.tf4h }, market)
      : { regime: 'RANGING' as const, confidence: 50, btcTrend: 'SIDEWAYS' as const, fearGreedZone: 'NEUTRAL' as const, volatility: 'NORMAL' as const }

    console.log(`[Scanner] Market regime: ${regime.regime} (${regime.confidence}%), BTC: ${regime.btcTrend}`)

    // === Phase B: Quant Ranking — Score all setups ===
    const scoredSignals: ScoredSignal[] = []

    for (const [coin, indicators] of Object.entries(coinIndicators)) {
      const p = indicators.tf1h.price
      if (!p || p <= 0 || !isFinite(p) || indicators.tf1h.atr <= 0) continue

      const rawSignal = runStrategies(coin, indicators, regime.regime)
      if (!rawSignal) continue

      funnel.strategyCandidates++
      funnel.byStrategy[rawSignal.strategy] = (funnel.byStrategy[rawSignal.strategy] || 0) + 1

      const scored = scoreSignal(rawSignal, regime, fundingMap[coin], newsMap[coin], oiMap[coin])

      if (scored.volumeKill) {
        funnel.rejectedByVolume++
        console.log(`[Scanner] ${coin}: KILLED by volume (breakout, vol=${indicators.tf1h.volRatio}x)`)
        continue
      }

      if (scored.score < minScore) {
        console.log(`[Scanner] ${coin}: score ${scored.score} < ${minScore} — skipped`)
        continue
      }

      funnel.passedScoring++
      console.log(`[Scanner] ${coin}: ${rawSignal.strategy} ${rawSignal.type} score=${scored.score} vol=${indicators.tf1h.volRatio}x`)
      scoredSignals.push(scored)
    }

    scoredSignals.sort((a, b) => b.score - a.score)
    console.log(`[Scanner] ${scoredSignals.length} signals above score ${minScore}`)

    // === Phase C: Trade Construction — entry models for top signals ===
    const topSignals = scoredSignals.slice(0, 15) // increased from 10 — we show more categories now
    const signalsWithRisk = topSignals.map(s => {
      const r = calculateRisk(s)
      const anyViable = r.entryModels.some(m => m.viable)
      if (!anyViable) {
        funnel.rejectedByRR++
        console.log(`[Scanner] ${s.coin}: all entry models non-viable (best R:R = ${r.riskReward})`)
      } else {
        funnel.passedRisk++
      }
      return r
    })

    // === Phase D: AI Annotation ===
    const results: ScanResult[] = []

    for (const signal of signalsWithRisk) {
      let gptAnnotation: GPTAnnotation

      if (useGPT) {
        gptAnnotation = await gptAnnotateSignal(
          signal,
          regime,
          fundingMap[signal.coin],
          newsMap[signal.coin],
          oiMap[signal.coin],
        )
      } else {
        gptAnnotation = {
          setupQuality: 'C',
          commentary: 'AI аннотация отключена',
          risks: [],
          conflicts: [],
          suggestedEntry: null,
          suggestedSL: null,
          suggestedTP1: null,
          recommendedEntryType: 'confirmation',
          keyLevels: [],
          waitForConfirmation: null,
        }
      }

      // Apply GPT suggested adjustments to best entry model
      if (gptAnnotation.suggestedEntry) signal.entry = gptAnnotation.suggestedEntry
      if (gptAnnotation.suggestedSL) signal.stopLoss = gptAnnotation.suggestedSL
      if (gptAnnotation.suggestedTP1 && signal.takeProfits[0]) {
        signal.takeProfits[0].price = gptAnnotation.suggestedTP1
      }

      // Classify signal into category
      const category = useGPT
        ? classifySignal(signal, gptAnnotation)
        : classifySignalNoGPT(signal)

      funnel.byCategory[category]++
      results.push({ signal, gptAnnotation, regime, category })
    }

    funnel.final = results.length

    // === Save all non-REJECTED signals to DB ===
    const saveable = results.filter(r => r.category !== 'REJECTED')

    for (const r of saveable) {
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
              category: r.category,
              entryModels: r.signal.entryModels,
              bestEntryType: r.signal.bestEntryType,
              setupQuality: r.gptAnnotation.setupQuality,
            })),
            aiAnalysis: `[${r.gptAnnotation.setupQuality}] ${r.gptAnnotation.commentary}\n\nРиски: ${r.gptAnnotation.risks.join('; ')}\nКонфликты: ${r.gptAnnotation.conflicts.join('; ')}\nУровни: ${r.gptAnnotation.keyLevels.join('; ')}${r.gptAnnotation.waitForConfirmation ? `\n⏳ Ждать: ${r.gptAnnotation.waitForConfirmation}` : ''}`,
            status: r.category === 'READY' ? 'NEW' : 'NEW',
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
          },
        })
      } catch (err) {
        console.error(`[Scanner] Failed to save signal for ${r.signal.coin}:`, err)
      }
    }

    // === Funnel report ===
    console.log(`[Scanner] ===== FUNNEL REPORT =====`)
    console.log(`[Scanner] Coins scanned: ${funnel.coinsScanned}`)
    console.log(`[Scanner] Fetch errors: ${funnel.fetchErrors}`)
    console.log(`[Scanner] Strategy candidates: ${funnel.strategyCandidates}`)
    console.log(`[Scanner]   By strategy: ${JSON.stringify(funnel.byStrategy)}`)
    console.log(`[Scanner] Rejected by volume (breakout only): ${funnel.rejectedByVolume}`)
    console.log(`[Scanner] Passed scoring (>= ${minScore}): ${funnel.passedScoring}`)
    console.log(`[Scanner] Rejected by R:R (all models): ${funnel.rejectedByRR}`)
    console.log(`[Scanner] Passed risk calc: ${funnel.passedRisk}`)
    console.log(`[Scanner] Categories: ${JSON.stringify(funnel.byCategory)}`)
    console.log(`[Scanner] Saved to DB: ${saveable.length}`)
    console.log(`[Scanner] ========================`)

    return { results, funnel }
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