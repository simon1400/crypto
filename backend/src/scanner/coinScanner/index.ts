import { fetchOHLCV, fetchMarketOverview } from '../../services/market'
import { computeIndicators, MultiTFIndicators } from '../../services/indicators'
import { fetchFundingRates } from '../../services/fundingRate'
import { fetchOpenInterests } from '../../services/openInterest'
import { fetchAllCoinNews } from '../../services/news'
import { fetchLongShortRatios } from '../../services/longShortRatio'
import { getLiquidationStats } from '../../services/liquidations'
import { detectMarketRegime } from '../marketRegime'
import { detectCoinRegime, CoinRegimeContext } from '../coinRegime'
import { runStrategies } from '../strategies/index'
import { scoreSignal, ScoredSignal } from '../scoring'
import { calculateRisk } from '../riskCalc'
import { gptAnnotateSignal, GPTAnnotation } from '../gptFilter'
import { scannerProgress } from '../scannerProgress'
import { prisma } from '../../db/prisma'
import { SCAN_COINS } from './coins'
import { ScanResult, ScanFunnel } from './types'
import {
  getScoreBand,
  assessEntryQuality,
  detectTrigger,
  classifySignal,
  getTopN,
} from './classifier'

// Re-exports для обратной совместимости с существующими импортами
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
    passedScoring: 0,
    rejectedByRR: 0,
    passedRisk: 0,
    byStrategy: {},
    byCategory: {},
    final: 0,
  }

  try {
    console.log(`[Scanner] Starting scan for ${coins.length} coins...`)
    scannerProgress.start(coins.length)

    // === Phase A: Discovery ===
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
    const fetchErrors: string[] = []

    scannerProgress.setPhase('fetching', 'Загружаю свечи 15m/1h/4h...', 0, coins.length)
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
          } catch {
            fetchErrors.push(coin)
            return null
          }
        }),
      )

      for (const r of results) {
        if (r) coinIndicators[r.coin] = r.indicators
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

    // === Detect market regime ===
    scannerProgress.setPhase('regime', 'Определяю режим рынка по BTC...', 0, 0)
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

    // === Phase B: Quant Ranking ===
    const totalToScore = Object.keys(coinIndicators).length
    scannerProgress.setPhase('scoring', 'Считаю стратегии и скоринг...', 0, totalToScore)
    const scoredSignals: ScoredSignal[] = []
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

      // Liquidations: in-memory rolling 15min window from WS
      const liqStats = getLiquidationStats(coin, 15)
      const liqPayload = liqStats.totalUsd > 0 ? liqStats : null

      const scored = scoreSignal(
        rawSignal,
        regime,
        fundingMap[coin],
        newsMap[coin],
        oiMap[coin],
        liqPayload,
        lsrMap[coin],
      )

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
      console.log(`[Scanner] ${coin}: ${rawSignal.strategy} ${rawSignal.type} score=${scored.score} vol=${indicators.tf1h.volRatio}x ${coinRegime.ownMomentum ? '[OWN_MOMENTUM]' : ''}`)
      scoredSignals.push(scored)
    }

    scoredSignals.sort((a, b) => b.score - a.score)
    console.log(`[Scanner] ${scoredSignals.length} signals above score ${minScore}`)
    scannerProgress.setCounters({ candidates: funnel.strategyCandidates, passed: scoredSignals.length })

    // === Phase C: Trade Construction ===
    const topN = getTopN(regime)
    const topSignals = scoredSignals.slice(0, topN)
    scannerProgress.setPhase('risk_calc', `Расчёт R:R и моделей входа (${topSignals.length} сигналов)...`, 0, topSignals.length)
    const signalsWithRisk = topSignals.map((s) => {
      const r = calculateRisk(s)
      const anyViable = r.entryModels.some((m) => m.viable)
      if (!anyViable) {
        funnel.rejectedByRR++
        console.log(`[Scanner] ${s.coin}: all entry models non-viable (best R:R = ${r.riskReward})`)
      } else {
        funnel.passedRisk++
      }
      return r
    })

    // === Phase D: AI Annotation + Classification ===
    const results: ScanResult[] = []
    const totalForGpt = signalsWithRisk.length
    scannerProgress.setPhase('gpt', useGPT ? `GPT анализ ${totalForGpt} сигналов...` : 'Классификация...', 0, totalForGpt)
    let gptDone = 0

    for (const signal of signalsWithRisk) {
      let gptAnnotation: GPTAnnotation

      if (useGPT) {
        const liqStats = getLiquidationStats(signal.coin, 15)
        gptAnnotation = await gptAnnotateSignal(
          signal,
          regime,
          fundingMap[signal.coin],
          newsMap[signal.coin],
          oiMap[signal.coin],
          liqStats.totalUsd > 0 ? liqStats : null,
          lsrMap[signal.coin],
        )
      } else {
        gptAnnotation = NEUTRAL_GPT
      }

      // GPT suggested adjustments are ADVISORY
      if (gptAnnotation.suggestedEntry) signal.entry = gptAnnotation.suggestedEntry
      if (gptAnnotation.suggestedSL) signal.stopLoss = gptAnnotation.suggestedSL
      if (gptAnnotation.suggestedTP1 && signal.takeProfits[0]) {
        signal.takeProfits[0].price = gptAnnotation.suggestedTP1
      }

      // Assess signal dimensions
      const coinRegime = coinRegimes[signal.coin]
      const scoreBand = getScoreBand(signal.score)
      const entryQuality = assessEntryQuality(signal)
      const trigger = detectTrigger(signal)

      // Classify based on all dimensions
      const category = classifySignal(signal, scoreBand, entryQuality, trigger, coinRegime)

      funnel.byCategory[category] = (funnel.byCategory[category] || 0) + 1
      results.push({
        signal,
        gptAnnotation,
        regime,
        category,
        scoreBand,
        entryQuality,
        triggerState: category === 'WAIT_CONFIRMATION' ? trigger : null,
        coinRegime,
      })

      gptDone++
      scannerProgress.tick(gptDone, totalForGpt, useGPT ? `GPT: ${signal.coin} (${gptDone}/${totalForGpt})` : `Классификация: ${gptDone}/${totalForGpt}`)
    }

    funnel.final = results.length

    // === Save non-REJECTED signals to DB ===
    const saveable = results.filter((r) => r.category !== 'REJECTED')
    const savedIds: Record<string, number> = {}
    scannerProgress.setPhase('saving', `Сохраняю ${saveable.length} сигналов в БД...`, 0, saveable.length)

    let savedCount = 0
    for (const r of saveable) {
      try {
        const liqStats = getLiquidationStats(r.signal.coin, 15)
        const saved = await prisma.generatedSignal.create({
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
              liquidations: liqStats.totalUsd > 0 ? liqStats : null,
              lsr: lsrMap[r.signal.coin] ?? null,
              category: r.category,
              scoreBand: r.scoreBand,
              entryQuality: r.entryQuality,
              triggerState: r.triggerState,
              entryModels: r.signal.entryModels,
              bestEntryType: r.signal.bestEntryType,
              setupQuality: r.gptAnnotation.setupQuality,
              coinRegime: r.coinRegime ?? null,
            })),
            aiAnalysis: `[${r.gptAnnotation.setupQuality}] ${r.gptAnnotation.commentary}\n\nРиски: ${r.gptAnnotation.risks.join('; ')}\nКонфликты: ${r.gptAnnotation.conflicts.join('; ')}\nУровни: ${r.gptAnnotation.keyLevels.join('; ')}${r.gptAnnotation.waitForConfirmation ? `\n⏳ Ждать: ${r.gptAnnotation.waitForConfirmation}` : ''}`,
            status: 'NEW',
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
          },
        })
        savedIds[r.signal.coin] = saved.id
      } catch (err) {
        console.error(`[Scanner] Failed to save signal for ${r.signal.coin}:`, err)
      }
      savedCount++
      scannerProgress.tick(savedCount, saveable.length)
    }

    // === Funnel report ===
    console.log(`[Scanner] ===== FUNNEL REPORT =====`)
    console.log(`[Scanner] Coins scanned: ${funnel.coinsScanned}`)
    console.log(`[Scanner] Fetch errors: ${funnel.fetchErrors}`)
    console.log(`[Scanner] Strategy candidates: ${funnel.strategyCandidates}`)
    console.log(`[Scanner]   By strategy: ${JSON.stringify(funnel.byStrategy)}`)
    console.log(`[Scanner] Rejected by volume: ${funnel.rejectedByVolume}`)
    console.log(`[Scanner] Passed scoring (>= ${minScore}): ${funnel.passedScoring}`)
    console.log(`[Scanner] Top-N sent to risk calc: ${topN}`)
    console.log(`[Scanner] Rejected by R:R: ${funnel.rejectedByRR}`)
    console.log(`[Scanner] Passed risk calc: ${funnel.passedRisk}`)
    console.log(`[Scanner] Categories: ${JSON.stringify(funnel.byCategory)}`)
    console.log(`[Scanner] Saved to DB: ${saveable.length}`)
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
