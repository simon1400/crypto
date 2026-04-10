import { fetchMarketOverview, OHLCV } from '../services/market'
import { fetchKlines } from '../services/klines'
import { computeIndicators, MultiTFIndicators, CoinIndicators } from '../services/indicators'
import { fetchFundingRates } from '../services/fundingRate'
import { fetchOpenInterests } from '../services/openInterest'
import { fetchAllCoinNews } from '../services/news'
import { detectMarketRegime, RegimeContext } from './marketRegime'
import { detectCoinRegime, CoinRegimeContext } from './coinRegime'
import { runStrategies } from './strategies/index'
import { scoreSignal } from './scoring'
import { gptAnnotateEntrySignal, EntryGPTAnnotation } from './gptEntryFilter'
import { FundingData } from '../services/fundingRate'
import { OIData } from '../services/openInterest'
import { NewsSentiment } from '../services/news'
import { getLiquidationStats, LiquidationStats } from '../services/liquidations'
import { fetchLongShortRatios, LSRData } from '../services/longShortRatio'

// === Level clustering for optimal limit order placement ===

interface PriceLevel {
  price: number
  source: string    // e.g. 'EMA20_1h', 'Fib_61.8', 'support_4h'
  weight: number    // 1-10, how reliable the level is
  timeframe: string // '15m' | '1h' | '4h'
}

interface LevelCluster {
  price: number          // weighted average price of cluster
  levels: PriceLevel[]   // all levels in this cluster
  totalWeight: number    // sum of weights
  sources: string[]      // human-readable list
  distancePercent: number // distance from current price in %
  fillProbability: number // 0-1, chance price reaches this level
}

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
  avgEntry: number        // weighted average of both entries
  stopLoss: number
  slPercent: number       // SL distance from avgEntry
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number     // % of deposit
  riskReward: number      // TP1 R:R from avgEntry
  reasons: string[]
  indicators: MultiTFIndicators
  regime: RegimeContext
  coinRegime: CoinRegimeContext
  gpt: EntryGPTAnnotation | null
  funding: FundingData | null
  oi: OIData | null
  news: NewsSentiment | null
  liquidations: LiquidationStats | null
  lsr: LSRData | null
}

let isAnalyzing = false

export function isEntryAnalyzerRunning(): boolean {
  return isAnalyzing
}

// === Collect all price levels from indicators ===
function collectLevels(ind: MultiTFIndicators, type: 'LONG' | 'SHORT'): PriceLevel[] {
  const levels: PriceLevel[] = []
  const price = ind.tf1h.price

  function addLevel(p: number, source: string, weight: number, tf: string) {
    if (!p || !isFinite(p) || p <= 0) return
    // For LONG — only levels below price; for SHORT — only above
    if (type === 'LONG' && p >= price) return
    if (type === 'SHORT' && p <= price) return
    levels.push({ price: p, source, weight, timeframe: tf })
  }

  // === 4h levels (strongest) ===
  const tf4h = ind.tf4h
  addLevel(tf4h.support, 'Поддержка 4h', 9, '4h')
  addLevel(tf4h.ema20, 'EMA20 4h', 8, '4h')
  addLevel(tf4h.ema50, 'EMA50 4h', 7, '4h')
  addLevel(tf4h.vwap, 'VWAP 4h', 7, '4h')
  addLevel(tf4h.bbLower, 'BB Lower 4h', 6, '4h')
  addLevel(tf4h.bbMiddle, 'BB Mid 4h', 5, '4h')
  addLevel(tf4h.pivotS1, 'Pivot S1 4h', 7, '4h')
  addLevel(tf4h.pivotS2, 'Pivot S2 4h', 6, '4h')
  addLevel(tf4h.resistance, 'Сопротивление 4h', 9, '4h')
  addLevel(tf4h.bbUpper, 'BB Upper 4h', 6, '4h')
  addLevel(tf4h.pivotR1, 'Pivot R1 4h', 7, '4h')
  addLevel(tf4h.pivotR2, 'Pivot R2 4h', 6, '4h')

  // Fib levels 4h
  for (const fib of tf4h.fibLevels) {
    const fibWeight = fib.level === '0.618' ? 9 : fib.level === '0.5' ? 7 : fib.level === '0.382' ? 8 : fib.level === '0.786' ? 6 : 4
    addLevel(fib.price, `Fib ${fib.level} 4h`, fibWeight, '4h')
  }

  // === 1h levels (medium) ===
  const tf1h = ind.tf1h
  addLevel(tf1h.support, 'Поддержка 1h', 7, '1h')
  addLevel(tf1h.ema20, 'EMA20 1h', 6, '1h')
  addLevel(tf1h.ema50, 'EMA50 1h', 5, '1h')
  addLevel(tf1h.vwap, 'VWAP 1h', 6, '1h')
  addLevel(tf1h.bbLower, 'BB Lower 1h', 5, '1h')
  addLevel(tf1h.pivotS1, 'Pivot S1 1h', 5, '1h')
  addLevel(tf1h.resistance, 'Сопротивление 1h', 7, '1h')
  addLevel(tf1h.bbUpper, 'BB Upper 1h', 5, '1h')
  addLevel(tf1h.pivotR1, 'Pivot R1 1h', 5, '1h')

  // Fib levels 1h
  for (const fib of tf1h.fibLevels) {
    const fibWeight = fib.level === '0.618' ? 7 : fib.level === '0.5' ? 5 : fib.level === '0.382' ? 6 : 3
    addLevel(fib.price, `Fib ${fib.level} 1h`, fibWeight, '1h')
  }

  // === 15m levels (weakest, for fine-tuning) ===
  const tf15m = ind.tf15m
  addLevel(tf15m.support, 'Поддержка 15m', 4, '15m')
  addLevel(tf15m.ema20, 'EMA20 15m', 3, '15m')
  addLevel(tf15m.vwap, 'VWAP 15m', 4, '15m')
  addLevel(tf15m.resistance, 'Сопротивление 15m', 4, '15m')

  return levels
}

// === Cluster nearby levels (within threshold %) ===
function clusterLevels(levels: PriceLevel[], price: number, thresholdPct = 0.5): LevelCluster[] {
  if (levels.length === 0) return []

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price)
  const clusters: LevelCluster[] = []
  let currentCluster: PriceLevel[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentCluster[currentCluster.length - 1]
    const diff = Math.abs(sorted[i].price - prev.price) / prev.price * 100

    if (diff <= thresholdPct) {
      currentCluster.push(sorted[i])
    } else {
      clusters.push(buildCluster(currentCluster, price))
      currentCluster = [sorted[i]]
    }
  }
  clusters.push(buildCluster(currentCluster, price))

  // Sort by total weight descending
  clusters.sort((a, b) => b.totalWeight - a.totalWeight)
  return clusters
}

function buildCluster(levels: PriceLevel[], currentPrice: number): LevelCluster {
  const totalWeight = levels.reduce((s, l) => s + l.weight, 0)
  const weightedPrice = levels.reduce((s, l) => s + l.price * l.weight, 0) / totalWeight
  const distancePercent = round(Math.abs(weightedPrice - currentPrice) / currentPrice * 100)

  return {
    price: round(weightedPrice),
    levels,
    totalWeight,
    sources: levels.map(l => l.source),
    distancePercent,
    fillProbability: 0, // calculated later
  }
}

// === Calculate fill probability based on ATR ===
function calcFillProbability(cluster: LevelCluster, atr: number, price: number): number {
  const distance = Math.abs(cluster.price - price)
  const atrRatio = distance / atr

  // Within 1 ATR → high probability
  if (atrRatio <= 0.5) return 0.9
  if (atrRatio <= 1.0) return 0.75
  if (atrRatio <= 1.5) return 0.55
  if (atrRatio <= 2.0) return 0.35
  if (atrRatio <= 3.0) return 0.2
  return 0.1
}

// === Determine direction from multi-TF analysis ===
function determineDirection(ind: MultiTFIndicators, regime: RegimeContext, coinRegime: CoinRegimeContext): 'LONG' | 'SHORT' {
  let longScore = 0
  let shortScore = 0

  const { tf1h, tf4h } = ind

  // 4h trend (strongest signal)
  if (tf4h.trend === 'BULLISH') longScore += 3
  else if (tf4h.trend === 'BEARISH') shortScore += 3

  // 1h trend
  if (tf1h.trend === 'BULLISH') longScore += 2
  else if (tf1h.trend === 'BEARISH') shortScore += 2

  // EMA alignment
  if (tf4h.ema20 > tf4h.ema50) longScore += 2
  else shortScore += 2

  // RSI bias
  if (tf4h.rsi > 55) longScore += 1
  if (tf4h.rsi < 45) shortScore += 1
  if (tf1h.rsi > 55) longScore += 1
  if (tf1h.rsi < 45) shortScore += 1

  // MACD
  if (tf4h.macdHistogram > 0) longScore += 1
  else shortScore += 1
  if (tf1h.macdHistogram > 0) longScore += 1
  else shortScore += 1

  // Market regime
  if (regime.regime === 'TRENDING_UP') longScore += 2
  else if (regime.regime === 'TRENDING_DOWN') shortScore += 2

  // ADX + directional
  if (tf4h.adx > 25) {
    if (tf4h.plusDI > tf4h.minusDI) longScore += 1
    else shortScore += 1
  }

  return longScore >= shortScore ? 'LONG' : 'SHORT'
}

// === Calculate SL/TP for entry analysis ===
function calculateEntryRisk(
  type: 'LONG' | 'SHORT',
  entry1Price: number,
  entry2Price: number,
  ind: MultiTFIndicators,
  score: number,
) {
  const atr = ind.tf1h.atr
  const minSL = 0.01 // 1% minimum

  // SL below entry2 (for LONG) or above entry2 (for SHORT)
  let stopLoss: number
  if (type === 'LONG') {
    const slDistance = Math.max(atr * 1.2, entry2Price * minSL)
    stopLoss = round(entry2Price - slDistance)
    // Also consider 4h support as floor
    const hardFloor = ind.tf4h.support - atr * 0.3
    if (hardFloor > 0 && hardFloor < stopLoss) stopLoss = round(hardFloor)
  } else {
    const slDistance = Math.max(atr * 1.2, entry2Price * minSL)
    stopLoss = round(entry2Price + slDistance)
    const hardCeiling = ind.tf4h.resistance + atr * 0.3
    if (hardCeiling > stopLoss) stopLoss = round(hardCeiling)
  }

  // Weighted average entry (60/40 split)
  const avgEntry = round(entry1Price * 0.6 + entry2Price * 0.4)

  const riskAmount = Math.abs(avgEntry - stopLoss)
  const slPercent = round(riskAmount / avgEntry * 100)

  // TP from average entry using structural levels
  const takeProfits: { price: number; rr: number }[] = []
  const { tf1h, tf4h } = ind

  if (type === 'LONG') {
    // TP1: 2x risk or nearest resistance
    const tp1Raw = avgEntry + riskAmount * 2
    const tp1Candidates = [tp1Raw, tf1h.resistance, tf1h.pivotR1].filter(p => p > avgEntry + riskAmount * 1.5)
    const tp1 = tp1Candidates.length > 0 ? round(Math.min(...tp1Candidates)) : round(tp1Raw)

    // TP2: 4x risk or higher level
    const tp2Raw = avgEntry + riskAmount * 4
    const tp2Candidates = [tp2Raw, tf4h.resistance, tf1h.pivotR2].filter(p => p > tp1)
    const tp2 = tp2Candidates.length > 0 ? round(Math.min(...tp2Candidates)) : round(tp2Raw)

    // TP3: 6x risk
    const tp3 = round(avgEntry + riskAmount * 6)

    takeProfits.push(
      { price: tp1, rr: round((tp1 - avgEntry) / riskAmount) },
      { price: tp2, rr: round((tp2 - avgEntry) / riskAmount) },
      { price: tp3, rr: round((tp3 - avgEntry) / riskAmount) },
    )
  } else {
    const tp1Raw = avgEntry - riskAmount * 2
    const tp1Candidates = [tp1Raw, tf1h.support, tf1h.pivotS1].filter(p => p < avgEntry - riskAmount * 1.5 && p > 0)
    const tp1 = tp1Candidates.length > 0 ? round(Math.max(...tp1Candidates)) : round(tp1Raw)

    const tp2Raw = avgEntry - riskAmount * 4
    const tp2Candidates = [tp2Raw, tf4h.support, tf1h.pivotS2].filter(p => p < tp1 && p > 0)
    const tp2 = tp2Candidates.length > 0 ? round(Math.max(...tp2Candidates)) : round(tp2Raw)

    const tp3 = round(Math.max(avgEntry - riskAmount * 6, 0.0001))

    takeProfits.push(
      { price: tp1, rr: round((avgEntry - tp1) / riskAmount) },
      { price: tp2, rr: round((avgEntry - tp2) / riskAmount) },
      { price: tp3, rr: round((avgEntry - tp3) / riskAmount) },
    )
  }

  // Leverage (ATR-based)
  const atrPercent = (atr / avgEntry) * 100
  let leverage: number
  if (atrPercent > 5) leverage = 2
  else if (atrPercent > 3) leverage = 3
  else if (atrPercent > 2) leverage = 5
  else if (atrPercent > 1) leverage = 8
  else leverage = 10

  if (score < 60) leverage = Math.max(1, Math.floor(leverage * 0.5))
  else if (score < 75) leverage = Math.max(1, Math.floor(leverage * 0.75))

  // Position size
  let positionPct: number
  if (score >= 80) positionPct = 3
  else if (score >= 70) positionPct = 2.5
  else if (score >= 60) positionPct = 2
  else positionPct = 1.5

  const riskReward = takeProfits.length > 0 ? takeProfits[0].rr : 0

  return { stopLoss, avgEntry, slPercent, takeProfits, leverage, positionPct, riskReward }
}

// === Main entry analysis ===
export async function analyzeEntries(
  coins: string[],
  useGPT = true,
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
          fetchKlines(symbol, '4h', 60),
        ])
        // BybitKline → OHLCV (same shape, time in seconds → ms)
        const toOHLCV = (k: typeof candles15m): OHLCV[] => k.map(c => ({ ...c, time: c.time * 1000 }))
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
      : { regime: 'RANGING' as const, confidence: 50, btcTrend: 'SIDEWAYS' as const, fearGreedZone: 'NEUTRAL' as const, volatility: 'NORMAL' as const }

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

        // GPT annotation
        if (useGPT) {
          try {
            result.gpt = await gptAnnotateEntrySignal(result, regime)
          } catch (err) {
            console.warn(`[EntryAnalyzer] GPT failed for ${coin}:`, err)
          }
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
  // ATR from indicators may be 0 for cheap coins due to rounding — recalculate with full precision
  let atr = ind.tf1h.atr
  if (atr <= 0) {
    // Fallback: estimate ATR as ~2% of price (typical for altcoins)
    atr = price * 0.02
    console.log(`[EntryAnalyzer] ${coin}: ATR was 0 from indicators, using fallback ${atr}`)
  }
  if (!price || price <= 0 || !isFinite(price)) {
    console.log(`[EntryAnalyzer] ${coin}: invalid price=$${price}`)
    return null
  }

  const coinRegime = detectCoinRegime(ind, btcInd)

  // Determine direction
  const type = determineDirection(ind, regime, coinRegime)

  // Run strategies for scoring
  const rawSignal = runStrategies(coin, ind, regime.regime, coinRegime)
  let score = 40 // default if no strategy matches
  let strategy = 'entry_analysis'
  let reasons: string[] = []

  if (rawSignal) {
    const scored = scoreSignal(rawSignal, regime, funding, news, oi, liquidations, lsr)
    score = scored.score
    strategy = rawSignal.strategy
    reasons = rawSignal.reasons
  }

  // Collect and cluster levels
  const allLevels = collectLevels(ind, type)
  if (allLevels.length === 0) return null

  const clusters = clusterLevels(allLevels, price)

  // Calculate fill probabilities
  for (const cluster of clusters) {
    cluster.fillProbability = calcFillProbability(cluster, atr, price)
  }

  // Select best 2 clusters for entries
  // Entry 1: closest strong cluster (balance of weight + proximity)
  // Entry 2: next deeper cluster
  const ranked = clusters
    .filter(c => c.totalWeight >= 3) // minimum strength (relaxed for less liquid coins)
    .sort((a, b) => {
      const scoreA = a.totalWeight * a.fillProbability
      const scoreB = b.totalWeight * b.fillProbability
      return scoreB - scoreA
    })

  if (ranked.length === 0) return null

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

  // If no second cluster, create one from ATR
  if (!cluster2) {
    const offset = atr * 1.5
    const fallbackPrice = type === 'LONG' ? round(cluster1.price - offset) : round(cluster1.price + offset)
    cluster2 = {
      price: fallbackPrice,
      levels: [{ price: fallbackPrice, source: 'ATR fallback', weight: 3, timeframe: '1h' }],
      totalWeight: 3,
      sources: ['ATR fallback (1.5x ATR от Entry 1)'],
      distancePercent: round(Math.abs(fallbackPrice - price) / price * 100),
      fillProbability: calcFillProbability({ price: fallbackPrice } as LevelCluster, atr, price),
    }
  }

  // For LONG: entry1 is closer (higher), entry2 is deeper (lower)
  // For SHORT: entry1 is closer (lower), entry2 is deeper (higher)
  let e1 = cluster1
  let e2 = cluster2
  if (type === 'LONG') {
    if (e1.price < e2.price) [e1, e2] = [e2, e1]
  } else {
    if (e1.price > e2.price) [e1, e2] = [e2, e1]
  }

  const entry1: EntryPoint = {
    price: e1.price,
    cluster: e1,
    positionPercent: 60,
    label: 'Основной вход',
  }

  const entry2: EntryPoint = {
    price: e2.price,
    cluster: e2,
    positionPercent: 40,
    label: 'Усреднение',
  }

  // Calculate risk from entry2 (SL below entry2)
  const risk = calculateEntryRisk(type, entry1.price, entry2.price, ind, score)

  if (risk.riskReward < 1.3) {
    console.log(`[EntryAnalyzer] ${coin}: R:R ${risk.riskReward} too low, skipping`)
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
    gpt: null,
    funding,
    oi,
    news,
    liquidations,
    lsr,
  }
}

function round(v: number): number {
  if (v > 100) return Math.round(v * 100) / 100
  if (v > 1) return Math.round(v * 10000) / 10000
  return Math.round(v * 1000000) / 1000000
}
