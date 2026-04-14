import { fetchOHLCV, fetchOHLCVWithExchange, fetchMarketOverview, ExchangeSource } from '../../services/market'
import { computeIndicators, MultiTFIndicators } from '../../services/indicators'
import { fetchFundingRates } from '../../services/fundingRate'
import { fetchOpenInterests } from '../../services/openInterest'
import { fetchAllCoinNews } from '../../services/news'
import { fetchLongShortRatios } from '../../services/longShortRatio'
import { getLiquidationStats } from '../../services/liquidations'
import { detectMarketRegime } from '../marketRegime'
import { detectCoinRegime, CoinRegimeContext } from '../coinRegime'
import { runStrategies } from '../strategies/index'
import { SignalWithRisk, EntryModel, ScoreBreakdown } from '../scoring/types'
import { gptAnnotateSignal, GPTAnnotation } from '../gptFilter'
import { scannerProgress } from '../scannerProgress'
import { prisma } from '../../db/prisma'
import { SCAN_COINS } from './coins'
import { ScanResult, ScanFunnel } from './types'
import { getTopN } from './classifier'
import { runScoringPipeline, EnrichedSignal } from '../scoring/index'
import { round2 } from '../utils/round'

// Re-exports
export { SCAN_COINS } from './coins'
export type {
  SignalCategory,
  ScoreBand,
  EntryQuality,
  TriggerState,
  ScanResult,
  ScanFunnel,
} from './types'

let isScanning = false

export function isScannerRunning(): boolean {
  return isScanning
}

const NEUTRAL_GPT: GPTAnnotation = {
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

// Bridge: build SignalWithRisk from EnrichedSignal so gptFilter still works
function enrichedToSignalWithRisk(e: EnrichedSignal): SignalWithRisk {
  const slPercent = round2(Math.abs((e.initial_stop - e.entry) / e.entry) * 100)
  const riskAmount = Math.abs(e.entry - e.initial_stop)

  // Build legacy-compatible entry models from new pipeline
  const primaryModel: EntryModel = {
    type: e.risk_profile.entry_model,
    entry: e.entry,
    stopLoss: e.initial_stop,
    takeProfits: e.take_profits.map(tp => ({ price: tp.price, rr: tp.rr })),
    leverage: e.leverage,
    positionPct: e.position_pct,
    slPercent,
    riskReward: e.take_profits[0]?.rr ?? 0,
    viable: true,
  }

  // Legacy scoreBreakdown: map new 6-component into old 7-component
  const scoreBreakdown: ScoreBreakdown = {
    trend: e.setup_breakdown.trend,
    momentum: e.setup_breakdown.momentum,
    volatility: 0,
    meanRevStretch: 0,
    levelInteraction: e.setup_breakdown.location,
    volume: e.setup_breakdown.derivatives,
    marketContext: e.setup_breakdown.geometry,
    mtfMultiplier: 1,
    patternBonus: 0,
  }

  return {
    coin: e.coin,
    type: e.type,
    strategy: e.strategy,
    score: e.setup_score,
    scoreBreakdown,
    reasons: e.reasons,
    indicators: e.indicators,
    entry: e.entry,
    stopLoss: e.initial_stop,
    takeProfits: e.take_profits.map(tp => ({ price: tp.price, rr: tp.rr })),
    leverage: e.leverage,
    positionPct: e.position_pct,
    slPercent,
    tp1Percent: e.take_profits[0] ? round2(Math.abs((e.take_profits[0].price - e.entry) / e.entry) * 100) : 0,
    tp2Percent: e.take_profits[1] ? round2(Math.abs((e.take_profits[1].price - e.entry) / e.entry) * 100) : 0,
    tp3Percent: e.take_profits[2] ? round2(Math.abs((e.take_profits[2].price - e.entry) / e.entry) * 100) : 0,
    riskReward: e.take_profits[0]?.rr ?? 0,
    entryModels: [primaryModel],
    bestEntryType: e.risk_profile.entry_model,
  }
}

// Map new SetupCategory to legacy SignalCategory
function mapToLegacyCategory(e: EnrichedSignal): import('./types').SignalCategory {
  switch (e.category) {
    case 'A_PLUS_READY': return 'READY'
    case 'READY': return 'READY'
    case 'WATCHLIST':
      return e.entry_trigger.passed ? 'WATCHLIST' : 'WAIT_CONFIRMATION'
    case 'IGNORE':
      if (!e.hard_filter.passed) return 'REJECTED'
      return 'REJECTED'
  }
}

export async function runScan(
  coins: string[] = SCAN_COINS,
  minScore = 40,
  useGPT = true,
): Promise<{ results: ScanResult[]; funnel: ScanFunnel; savedIds: Record<string, number> }> {
  if (isScanning) throw new Error('Scanner already running')
  isScanning = true

  const funnel: ScanFunnel = {
    coinsScanned: coins.length,
    fetchErrors: 0,
    strategyCandidates: 0,
    rejectedByVolume: 0,
    rejectedByHardFilter: 0,
    passedScoring: 0,
    rejectedByRR: 0,
    passedRisk: 0,
    byStrategy: {},
    byCategory: {},
    bySetupCategory: {},
    byExecutionType: {},
    final: 0,
  }

  try {
    console.log(`[Scanner] Starting scan for ${coins.length} coins...`)
    scannerProgress.start(coins.length)

    // === Phase A: Discovery — fetch market data ===
    scannerProgress.setPhase('market_data', 'Загружаю funding, OI, новости и L/S ratio...', 0, 5)
    const [market, fundingMap, oiMap, newsMap, lsrMap] = await Promise.all([
      fetchMarketOverview(),
      fetchFundingRates(coins),
      fetchOpenInterests(coins),
      fetchAllCoinNews(coins.slice(0, 10)),
      fetchLongShortRatios(coins),
    ])
    scannerProgress.tick(5, 5, 'Рыночные данные загружены')

    const coinIndicators: Record<string, MultiTFIndicators> = {}
    const coinCandles: Record<string, { candles5m: import('../../services/market').OHLCV[]; candles15m: import('../../services/market').OHLCV[] }> = {}
    const coinExchanges: Record<string, ExchangeSource> = {}
    const fetchErrors: string[] = []

    scannerProgress.setPhase('fetching', 'Загружаю свечи 5m/15m/1h/4h...', 0, coins.length)
    for (let i = 0; i < coins.length; i += 5) {
      const batch = coins.slice(i, i + 5)
      const results = await Promise.all(
        batch.map(async (coin) => {
          try {
            const symbol = `${coin}USDT`
            // Use 4h fetch to determine exchange source (most important TF)
            const result4h = await fetchOHLCVWithExchange(symbol, '4h', 200)
            const [candles5m, candles15m, candles1h] = await Promise.all([
              fetchOHLCV(symbol, '5m', 30),
              fetchOHLCV(symbol, '15m', 60),
              fetchOHLCV(symbol, '1h', 60),
            ])
            return {
              coin,
              exchange: result4h.exchange,
              candles5m,
              candles15m,
              indicators: {
                tf15m: computeIndicators(candles15m),
                tf1h: computeIndicators(candles1h),
                tf4h: computeIndicators(result4h.candles),
              } as MultiTFIndicators,
            }
          } catch {
            fetchErrors.push(coin)
            return null
          }
        }),
      )

      for (const r of results) {
        if (r) {
          coinIndicators[r.coin] = r.indicators
          coinCandles[r.coin] = { candles5m: r.candles5m, candles15m: r.candles15m }
          coinExchanges[r.coin] = r.exchange
        }
      }

      const done = Math.min(i + 5, coins.length)
      scannerProgress.tick(done, coins.length, `Свечи: ${done}/${coins.length}`)

      if (i + 5 < coins.length) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    funnel.fetchErrors = fetchErrors.length
    if (fetchErrors.length > 0) {
      console.warn(`[Scanner] Failed to fetch: ${fetchErrors.join(', ')}`)
    }

    // === Detect market regime from BTC ===
    scannerProgress.setPhase('regime', 'Определяю режим рынка по BTC...', 0, 0)
    let btcInd = coinIndicators['BTC']
    if (!btcInd) {
      try {
        const [btc1h, btc4h] = await Promise.all([
          fetchOHLCV('BTCUSDT', '1h', 60),
          fetchOHLCV('BTCUSDT', '4h', 200),
        ])
        btcInd = { tf15m: computeIndicators(btc1h), tf1h: computeIndicators(btc1h), tf4h: computeIndicators(btc4h) }
      } catch {}
    }
    const regime = btcInd
      ? detectMarketRegime({ tf1h: btcInd.tf1h, tf4h: btcInd.tf4h }, market)
      : { regime: 'RANGING' as const, confidence: 50, btcTrend: 'SIDEWAYS' as const, fearGreedZone: 'NEUTRAL' as const, volatility: 'NORMAL' as const }

    console.log(`[Scanner] Market regime: ${regime.regime} (${regime.confidence}%), BTC: ${regime.btcTrend}`)

    // === Phase B: Score all strategy candidates through new 3-layer pipeline ===
    const totalToScore = Object.keys(coinIndicators).length
    scannerProgress.setPhase('scoring', 'Считаю стратегии и скоринг...', 0, totalToScore)
    const enrichedSignals: EnrichedSignal[] = []
    const coinRegimes: Record<string, CoinRegimeContext> = {}
    let scoredCount = 0

    for (const [coin, indicators] of Object.entries(coinIndicators)) {
      scoredCount++
      if (scoredCount % 5 === 0 || scoredCount === totalToScore) {
        scannerProgress.tick(scoredCount, totalToScore, `Скоринг: ${scoredCount}/${totalToScore}`)
      }
      const p = indicators.tf1h.price
      if (!p || p <= 0 || !isFinite(p) || indicators.tf1h.atr <= 0) continue

      const coinRegime = detectCoinRegime(indicators, btcInd || null)
      coinRegimes[coin] = coinRegime

      const rawSignal = runStrategies(coin, indicators, regime.regime, coinRegime)
      if (!rawSignal) continue

      funnel.strategyCandidates++
      funnel.byStrategy[rawSignal.strategy] = (funnel.byStrategy[rawSignal.strategy] || 0) + 1

      const liqStats = getLiquidationStats(coin, 15)
      const liqPayload = liqStats.totalUsd > 0 ? liqStats : null

      // Run 3-layer scoring pipeline (with raw candles for entry trigger)
      const rawCandles = coinCandles[coin]
      const enriched = runScoringPipeline(
        rawSignal, regime, coinRegime,
        fundingMap[coin], oiMap[coin], newsMap[coin], liqPayload, lsrMap[coin],
        rawCandles?.candles5m, rawCandles?.candles15m,
      )
      if (!enriched) continue

      funnel.bySetupCategory[enriched.category] = (funnel.bySetupCategory[enriched.category] || 0) + 1
      funnel.byExecutionType[enriched.execution_type] = (funnel.byExecutionType[enriched.execution_type] || 0) + 1

      if (!enriched.hard_filter.passed) {
        funnel.rejectedByHardFilter++
        console.log(`[Scanner] ${coin}: HARD FILTER FAIL — ${enriched.hard_filter.failures.join('; ')}`)
        continue
      }

      if (enriched.category === 'IGNORE') {
        console.log(`[Scanner] ${coin}: setup_score ${enriched.setup_score} → IGNORE`)
        continue
      }

      if (enriched.setup_score < minScore) {
        console.log(`[Scanner] ${coin}: setup_score ${enriched.setup_score} < minScore ${minScore} → SKIP`)
        continue
      }

      funnel.passedScoring++
      const exch = coinExchanges[coin] || 'bybit'
      console.log(`[Scanner] ${coin}: ${rawSignal.strategy} ${rawSignal.type} setup=${enriched.setup_score} ${enriched.category}/${enriched.execution_type} vol=${indicators.tf1h.volRatio}x ${exch !== 'bybit' ? `[${exch.toUpperCase()}]` : ''} ${coinRegime.ownMomentum ? '[OWN_MOMENTUM]' : ''}`)
      enrichedSignals.push(enriched)
    }

    enrichedSignals.sort((a, b) => b.setup_score - a.setup_score)
    console.log(`[Scanner] ${enrichedSignals.length} signals passed scoring`)
    scannerProgress.setCounters({ candidates: funnel.strategyCandidates, passed: enrichedSignals.length })

    // === Phase C: Top-N selection ===
    const topN = getTopN(regime)
    const topSignals = enrichedSignals.slice(0, topN)
    funnel.passedRisk = topSignals.length

    // === Phase D: AI Annotation + build results ===
    const results: ScanResult[] = []
    const totalForGpt = topSignals.length
    scannerProgress.setPhase('gpt', useGPT ? `GPT анализ ${totalForGpt} сигналов...` : 'Классификация...', 0, totalForGpt)
    let gptDone = 0

    for (const enriched of topSignals) {
      // Build SignalWithRisk bridge for GPT annotator
      const signalWithRisk = enrichedToSignalWithRisk(enriched)

      let gptAnnotation: GPTAnnotation
      if (useGPT) {
        const liqStats = getLiquidationStats(enriched.coin, 15)
        gptAnnotation = await gptAnnotateSignal(
          signalWithRisk,
          regime,
          fundingMap[enriched.coin],
          newsMap[enriched.coin],
          oiMap[enriched.coin],
          liqStats.totalUsd > 0 ? liqStats : null,
          lsrMap[enriched.coin],
        )
      } else {
        gptAnnotation = NEUTRAL_GPT
      }

      // Map new category to legacy
      const category = mapToLegacyCategory(enriched)
      const coinRegime = coinRegimes[enriched.coin]

      // Legacy compatibility fields
      const scoreBand = enriched.setup_score >= 72 ? 'STRONG' as const
        : enriched.setup_score >= 64 ? 'ACTIONABLE' as const
        : enriched.setup_score >= 56 ? 'CONDITIONAL' as const
        : enriched.setup_score >= 40 ? 'OBSERVATIONAL' as const
        : 'LOW_QUALITY' as const
      const entryQuality = enriched.entry_trigger.passed ? 'GOOD' as const : 'FAIR' as const

      funnel.byCategory[category] = (funnel.byCategory[category] || 0) + 1

      results.push({
        signal: signalWithRisk,
        gptAnnotation,
        regime,
        category,
        scoreBand,
        entryQuality,
        triggerState: null,
        coinRegime,
        exchange: coinExchanges[enriched.coin] || 'bybit',
        // New 3-layer scoring
        enriched,
        setup_category: enriched.category,
        execution_type: enriched.execution_type,
        setup_score_breakdown: enriched.setup_breakdown,
        entry_trigger_result: enriched.entry_trigger,
        hard_filter_result: enriched.hard_filter,
        signal_context: enriched.signal_context,
        signal_explanation: enriched.explanation,
        limit_entry_plan: enriched.limit_plan,
        market_entry_plan: enriched.market_plan,
        risk_profile: enriched.risk_profile,
      })

      gptDone++
      scannerProgress.tick(gptDone, totalForGpt, useGPT ? `GPT: ${enriched.coin} (${gptDone}/${totalForGpt})` : `Классификация: ${gptDone}/${totalForGpt}`)
    }

    funnel.final = results.length

    // === Save to DB ===
    const savedIds: Record<string, number> = {}
    scannerProgress.setPhase('saving', `Сохраняю ${results.length} сигналов в БД...`, 0, results.length)

    let savedCount = 0
    for (const r of results) {
      try {
        const enriched = r.enriched!
        const liqStats = getLiquidationStats(r.signal.coin, 15)
        const exchange = coinExchanges[enriched.coin] || 'bybit'
        const saved = await prisma.generatedSignal.create({
          data: {
            coin: enriched.coin,
            type: enriched.type,
            strategy: enriched.strategy,
            score: enriched.setup_score,
            entry: enriched.entry,
            stopLoss: enriched.initial_stop,
            takeProfits: enriched.take_profits as any,
            leverage: enriched.leverage,
            positionPct: enriched.position_pct,
            exchange,
            indicators: JSON.parse(JSON.stringify(enriched.indicators)),
            marketContext: JSON.parse(JSON.stringify({
              regime: regime.regime,
              regimeConfidence: regime.confidence,
              btcTrend: regime.btcTrend,
              fearGreedZone: regime.fearGreedZone,
              volatility: regime.volatility,
              funding: fundingMap[enriched.coin] ?? null,
              oi: oiMap[enriched.coin] ?? null,
              news: newsMap[enriched.coin] ?? null,
              liquidations: liqStats.totalUsd > 0 ? liqStats : null,
              lsr: lsrMap[enriched.coin] ?? null,
              setupQuality: r.gptAnnotation.setupQuality,
              coinRegime: r.coinRegime ?? null,
              // 3-layer scoring context
              setup_category: enriched.category,
              execution_type: enriched.execution_type,
              setup_score: enriched.setup_score,
              setup_score_breakdown: enriched.setup_breakdown,
              entry_trigger_result: enriched.entry_trigger,
              hard_filter_result: enriched.hard_filter,
              signal_context: enriched.signal_context,
              signal_explanation: enriched.explanation,
              limit_entry_plan: enriched.limit_plan,
              market_entry_plan: enriched.market_plan,
              risk_profile: enriched.risk_profile,
              initial_stop: enriched.initial_stop,
              current_stop: enriched.current_stop,
              entry_model: enriched.risk_profile.entry_model,
              data_completeness: enriched.data_completeness,
            })),
            aiAnalysis: `[${r.gptAnnotation.setupQuality}] ${r.gptAnnotation.commentary}\n\nРиски: ${r.gptAnnotation.risks.join('; ')}\nКонфликты: ${r.gptAnnotation.conflicts.join('; ')}\nУровни: ${r.gptAnnotation.keyLevels.join('; ')}${r.gptAnnotation.waitForConfirmation ? `\n⏳ Ждать: ${r.gptAnnotation.waitForConfirmation}` : ''}`,
            status: 'NEW',
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
            // New DB columns
            initialStop: enriched.initial_stop,
            currentStop: enriched.current_stop,
            setupScore: enriched.setup_score,
            setupCategory: enriched.category,
            executionType: enriched.execution_type,
            entryModel: enriched.risk_profile.entry_model,
          },
        })
        savedIds[enriched.coin] = saved.id
      } catch (err) {
        console.error(`[Scanner] Failed to save signal for ${r.signal.coin}:`, err)
      }
      savedCount++
      scannerProgress.tick(savedCount, results.length)
    }

    // === Funnel report ===
    console.log(`[Scanner] ===== FUNNEL REPORT =====`)
    console.log(`[Scanner] Coins scanned: ${funnel.coinsScanned}`)
    console.log(`[Scanner] Fetch errors: ${funnel.fetchErrors}`)
    console.log(`[Scanner] Strategy candidates: ${funnel.strategyCandidates}`)
    console.log(`[Scanner]   By strategy: ${JSON.stringify(funnel.byStrategy)}`)
    console.log(`[Scanner] Rejected by hard filter: ${funnel.rejectedByHardFilter}`)
    console.log(`[Scanner] Passed scoring: ${funnel.passedScoring}`)
    console.log(`[Scanner] Top-N: ${topN} → ${topSignals.length} signals`)
    console.log(`[Scanner] Setup categories: ${JSON.stringify(funnel.bySetupCategory)}`)
    console.log(`[Scanner] Execution types: ${JSON.stringify(funnel.byExecutionType)}`)
    console.log(`[Scanner] Saved to DB: ${results.length}`)
    console.log(`[Scanner] ========================`)

    scannerProgress.done(`Готово: ${results.length} сигналов`, results.length)
    return { results, funnel, savedIds }
  } catch (err: any) {
    scannerProgress.error(err?.message || 'Ошибка сканирования')
    throw err
  } finally {
    isScanning = false
  }
}

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
