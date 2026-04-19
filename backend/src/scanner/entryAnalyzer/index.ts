import { fetchMarketOverview, OHLCV } from '../../services/market'
import { fetchKlines } from '../../services/klines'
import { computeIndicators, MultiTFIndicators } from '../../services/indicators'
import { fetchFundingRates, FundingData } from '../../services/fundingRate'
import { fetchOpenInterests, OIData } from '../../services/openInterest'
import { fetchAllCoinNews, NewsSentiment } from '../../services/news'
import { detectMarketRegime, RegimeContext } from '../marketRegime'
import { detectCoinRegime, CoinRegimeContext } from '../coinRegime'
import { runStrategies } from '../strategies/index'
import { runScoringPipeline } from '../scoring/index'
import { getLiquidationStats, LiquidationStats } from '../../services/liquidations'
import { fetchLongShortRatios, LSRData } from '../../services/longShortRatio'
import { round } from '../utils/round'
import {
  collectLevels,
  clusterLevels,
  calcFillProbability,
  LevelCluster,
} from './levelClusterer'
import { determineDirection } from './directionDetector'
import { calculateEntryRisk } from './entryRisk'

export interface EntryPoint {
  price: number
  cluster: LevelCluster
  positionPercent: number // 60 or 40
  label: string           // 'Основной вход' | 'Усреднение'
}

export interface EntryAnalysisResult {
  coin: string
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  currentPrice: number
  entry1: EntryPoint
  entry2: EntryPoint
  avgEntry: number
  stopLoss: number
  slPercent: number
  takeProfits: { price: number; rr: number; percent?: number }[]
  leverage: number
  positionPct: number
  riskReward: number
  reasons: string[]
  indicators: MultiTFIndicators
  regime: RegimeContext
  coinRegime: CoinRegimeContext
  funding: FundingData | null
  oi: OIData | null
  news: NewsSentiment | null
  liquidations: LiquidationStats | null
  lsr: LSRData | null
  // New scoring fields
  setupCategory?: string
  executionType?: string
}

let isAnalyzing = false

export function isEntryAnalyzerRunning(): boolean {
  return isAnalyzing
}

const DEFAULT_REGIME: RegimeContext = {
  regime: 'RANGING',
  confidence: 50,
  btcTrend: 'SIDEWAYS',
  fearGreedZone: 'NEUTRAL',
  volatility: 'NORMAL',
}

/**
 * Главный entry-point: анализирует список монет и для каждой
 * определяет 2 оптимальные точки лимитного входа + SL/TP/leverage.
 */
export async function analyzeEntries(
  coins: string[],
): Promise<{ results: EntryAnalysisResult[]; errors: string[] }> {
  if (isAnalyzing) throw new Error('Entry analyzer already running')
  isAnalyzing = true

  const errors: string[] = []
  const results: EntryAnalysisResult[] = []

  try {
    console.log(`[EntryAnalyzer] Analyzing ${coins.length} coins...`)

    // Fetch market data + LSR
    const [market, fundingMap, oiMap, newsMap, lsrMap] = await Promise.all([
      fetchMarketOverview(),
      fetchFundingRates(coins),
      fetchOpenInterests(coins),
      fetchAllCoinNews(coins),
      fetchLongShortRatios(coins),
    ])

    // Fetch indicators for all coins + BTC
    const allCoins = [...new Set([...coins, 'BTC'])]
    const coinIndicators: Record<string, MultiTFIndicators> = {}

    for (const coin of allCoins) {
      try {
        const symbol = `${coin}USDT`
        const [candles15m, candles1h, candles4h] = await Promise.all([
          fetchKlines(symbol, '15m', 60),
          fetchKlines(symbol, '1h', 60),
          fetchKlines(symbol, '4h', 200),
        ])
        // BybitKline → OHLCV (same shape, time in seconds → ms)
        const toOHLCV = (k: typeof candles15m): OHLCV[] => k.map((c) => ({ ...c, time: c.time * 1000 }))
        coinIndicators[coin] = {
          tf15m: computeIndicators(toOHLCV(candles15m)),
          tf1h: computeIndicators(toOHLCV(candles1h)),
          tf4h: computeIndicators(toOHLCV(candles4h)),
        }
        console.log(`[EntryAnalyzer] ${coin}: fetched OK, price=$${coinIndicators[coin].tf1h.price}`)
      } catch (err: any) {
        errors.push(coin)
        console.warn(`[EntryAnalyzer] Failed to fetch ${coin}: ${err.message || err}`)
      }
    }

    // Market regime from BTC
    const btcInd = coinIndicators['BTC']
    const regime = btcInd
      ? detectMarketRegime({ tf1h: btcInd.tf1h, tf4h: btcInd.tf4h }, market)
      : DEFAULT_REGIME

    console.log(`[EntryAnalyzer] Regime: ${regime.regime}, BTC: ${regime.btcTrend}`)

    // Analyze each requested coin
    for (const coin of coins) {
      const ind = coinIndicators[coin]
      if (!ind) continue

      try {
        const liquidations = getLiquidationStats(coin, 15)
        const result = analyzeCoin(
          coin,
          ind,
          btcInd || null,
          regime,
          fundingMap[coin] || null,
          oiMap[coin] || null,
          newsMap[coin] || null,
          liquidations.totalUsd > 0 ? liquidations : null,
          lsrMap[coin] || null,
        )
        if (!result) {
          console.log(`[EntryAnalyzer] ${coin}: no valid entry levels found`)
          continue
        }

        results.push(result)
        console.log(`[EntryAnalyzer] ${coin}: ${result.type} | Entry1=$${result.entry1.price} Entry2=$${result.entry2.price} SL=$${result.stopLoss} | Score=${result.score}`)
      } catch (err) {
        console.error(`[EntryAnalyzer] Error analyzing ${coin}:`, err)
        errors.push(coin)
      }
    }

    return { results, errors }
  } finally {
    isAnalyzing = false
  }
}

function analyzeCoin(
  coin: string,
  ind: MultiTFIndicators,
  btcInd: MultiTFIndicators | null,
  regime: RegimeContext,
  funding: FundingData | null,
  oi: OIData | null,
  news: NewsSentiment | null,
  liquidations: LiquidationStats | null,
  lsr: LSRData | null,
): EntryAnalysisResult | null {
  const price = ind.tf1h.price
  // ATR may be 0 for cheap coins due to rounding — fallback to 2% of price
  let atr = ind.tf1h.atr
  if (atr <= 0) {
    atr = price * 0.02
    console.log(`[EntryAnalyzer] ${coin}: ATR was 0 from indicators, using fallback ${atr}`)
  }
  if (!price || price <= 0 || !isFinite(price)) {
    console.log(`[EntryAnalyzer] ${coin}: invalid price=$${price}`)
    return null
  }

  const coinRegime = detectCoinRegime(ind, btcInd)
  const type = determineDirection(ind, regime, coinRegime)

  // Run strategies for scoring
  const rawSignal = runStrategies(coin, ind, regime.regime, coinRegime)
  let score = 40
  let strategy = 'entry_analysis'
  let reasons: string[] = []

  let setupCategory: string | undefined
  let executionType: string | undefined

  if (rawSignal) {
    const enriched = runScoringPipeline(rawSignal, regime, coinRegime, funding, oi, news, liquidations, lsr)
    if (enriched) {
      score = enriched.setup_score
      strategy = rawSignal.strategy
      reasons = rawSignal.reasons
      setupCategory = enriched.category
      executionType = enriched.execution_type
    }
  }

  // Collect and cluster levels
  const allLevels = collectLevels(ind, type)
  if (allLevels.length === 0) {
    console.log(`[EntryAnalyzer] ${coin}: no levels found at all`)
    return null
  }

  const clusters = clusterLevels(allLevels, price)
  console.log(`[EntryAnalyzer] ${coin}: ${allLevels.length} levels → ${clusters.length} clusters (min weight 3: ${clusters.filter(c => c.totalWeight >= 3).length})`)

  // Calculate fill probabilities
  for (const cluster of clusters) {
    cluster.fillProbability = calcFillProbability(cluster, atr, price)
  }

  // Select best 2 clusters for entries
  const ranked = clusters
    .filter((c) => c.totalWeight >= 3)
    .sort((a, b) => b.totalWeight * b.fillProbability - a.totalWeight * a.fillProbability)

  if (ranked.length === 0) {
    console.log(`[EntryAnalyzer] ${coin}: no clusters with weight >= 3`)
    return null
  }

  // Entry 1: best cluster
  const cluster1 = ranked[0]

  // Entry 2: next cluster that is deeper (further from price)
  let cluster2: LevelCluster | null = null
  for (const c of ranked.slice(1)) {
    if (type === 'LONG' && c.price < cluster1.price * 0.995) {
      cluster2 = c
      break
    }
    if (type === 'SHORT' && c.price > cluster1.price * 1.005) {
      cluster2 = c
      break
    }
  }

  // If no second cluster, fabricate one from ATR offset
  if (!cluster2) {
    const offset = atr * 1.5
    const fallbackPrice = type === 'LONG' ? round(cluster1.price - offset) : round(cluster1.price + offset)
    cluster2 = {
      price: fallbackPrice,
      levels: [{ price: fallbackPrice, source: 'ATR fallback', weight: 3, timeframe: '1h' }],
      totalWeight: 3,
      sources: ['ATR fallback (1.5x ATR от Entry 1)'],
      distancePercent: round((Math.abs(fallbackPrice - price) / price) * 100),
      fillProbability: calcFillProbability({ price: fallbackPrice } as LevelCluster, atr, price),
    }
  }

  // For LONG: entry1 closer (higher), entry2 deeper (lower); SHORT — наоборот
  let e1 = cluster1
  let e2 = cluster2
  if (type === 'LONG') {
    if (e1.price < e2.price) [e1, e2] = [e2, e1]
  } else {
    if (e1.price > e2.price) [e1, e2] = [e2, e1]
  }

  const entry1: EntryPoint = { price: e1.price, cluster: e1, positionPercent: 60, label: 'Основной вход' }
  const entry2: EntryPoint = { price: e2.price, cluster: e2, positionPercent: 40, label: 'Усреднение' }

  // Calculate risk from entry2 (SL below entry2)
  const risk = calculateEntryRisk(type, entry1.price, entry2.price, ind, score)

  if (risk.riskReward < 1.0) {
    console.log(`[EntryAnalyzer] ${coin}: R:R ${risk.riskReward} too low (min 1.0), skipping`)
    return null
  }

  return {
    coin,
    type,
    strategy,
    score,
    currentPrice: price,
    entry1,
    entry2,
    avgEntry: risk.avgEntry,
    stopLoss: risk.stopLoss,
    slPercent: risk.slPercent,
    takeProfits: risk.takeProfits,
    leverage: risk.leverage,
    positionPct: risk.positionPct,
    riskReward: risk.riskReward,
    reasons,
    indicators: ind,
    regime,
    coinRegime,
    funding,
    oi,
    news,
    liquidations,
    lsr,
    setupCategory,
    executionType,
  }
}
