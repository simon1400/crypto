import { fetchOHLCV, fetchMarketOverview } from '../services/market'
import { computeIndicators, MultiTFIndicators } from '../services/indicators'
import { fetchFundingRates } from '../services/fundingRate'
import { fetchOpenInterests } from '../services/openInterest'
import { fetchAllCoinNews } from '../services/news'
import { detectMarketRegime, RegimeContext } from './marketRegime'
import { detectCoinRegime, CoinRegimeContext } from './coinRegime'
import { runStrategies } from './strategies/index'
import { scoreSignal, ScoredSignal } from './scoring'
import { calculateRisk, SignalWithRisk } from './riskCalc'
import { gptAnnotateSignal, GPTAnnotation } from './gptFilter'
import { prisma } from '../db/prisma'

// All coins verified on Bybit linear perpetual (USDT) as of 2026-04-02
export const SCAN_COINS = [
  // Layer 1 (23)
  'SOL', 'BNB', 'XRP', 'ADA', 'AVAX',
  'DOT', 'NEAR', 'SUI', 'SEI', 'TIA',
  'INJ', 'APT', 'ATOM', 'ALGO', 'HBAR',
  'ICP', 'FIL', 'VET', 'EGLD', 'KAS',
  'TON', 'TRX', 'XLM',
  // Memes (14)
  'DOGE', 'PEPE', 'WIF', 'FLOKI', 'BONK',
  'MEME', 'PEOPLE', 'ACT', 'PNUT', 'BOME',
  'MEW', 'NOT', 'BRETT', 'SPX',
  // AI & DePIN (10)
  'RENDER', 'GRT', 'TAO', 'AKT', 'AR',
  'AIOZ', 'IO', 'GLM', 'THETA', 'IOTX',
  // DeFi (16)
  'LINK', 'AAVE', 'CRV', 'LDO', 'PENDLE',
  'JUP', 'ONDO', 'RUNE', 'UNI', 'COMP',
  'SNX', 'SUSHI', 'CAKE', 'DYDX', 'GMX',
  'BANANA',
  // Infra & L2 (13)
  'ARB', 'OP', 'STRK', 'MANTA', 'BLAST',
  'IMX', 'ZK', 'METIS', 'CELO', 'ZRO',
  'W', 'ALT', 'MORPHO',
  // Gaming (12)
  'GALA', 'SAND', 'AXS', 'ENJ', 'PIXEL',
  'PORTAL', 'SUPER', 'YGG', 'BIGTIME', 'RONIN',
  'BEAM', 'GODS',
  // Mid-cap volatile (16)
  'STX', 'ENS', 'JASMY', 'CHZ', 'MASK',
  'TRB', 'ORDI', 'WLD', 'PYTH', 'JTO',
  'BLUR', 'ARKM', 'AEVO', 'ENA', 'ILV',
  'HNT',
]

// === Signal categories ===
// Each category is distinct and actionable. GPT does NOT influence gating.
// Classification uses: score band + entry quality + conflict count + trigger detection
export type SignalCategory =
  | 'READY'              // Signal quality good + entry is valid now
  | 'READY_AGGRESSIVE'   // Signal strong but only aggressive entry viable
  | 'WAIT_CONFIRMATION'  // Signal quality good but needs a specific trigger
  | 'PULLBACK_WATCH'     // Signal good but entry chasing — wait for pullback
  | 'LATE_ENTRY'         // Setup already partially realized, R:R degraded
  | 'CONFLICTED'         // 2+ strong cross-layer contradictions
  | 'WATCHLIST'          // Setup partially present, edge weak, observational
  | 'REJECTED'           // No viable models or structure broken

// Score band — semantic meaning of raw score
export type ScoreBand = 'STRONG' | 'ACTIONABLE' | 'CONDITIONAL' | 'OBSERVATIONAL' | 'LOW_QUALITY'

// Entry quality — is the current price good for entry?
export type EntryQuality = 'GOOD' | 'FAIR' | 'POOR' | 'CHASING'

// Trigger state — structured conditions for WAIT_CONFIRMATION
export interface TriggerState {
  triggerType: 'breakout_close_above' | 'breakout_close_below' | 'retest_hold' | 'volume_confirm' | 'macd_cross' | 'rsi_reversal'
  triggerLevel: number
  triggerTf: '15m' | '1h' | '4h'
  invalidIf: string // human-readable invalidation condition
}

export interface ScanResult {
  signal: SignalWithRisk
  gptAnnotation: GPTAnnotation
  regime: RegimeContext
  category: SignalCategory
  scoreBand: ScoreBand
  entryQuality: EntryQuality
  triggerState: TriggerState | null // non-null for WAIT_CONFIRMATION
  coinRegime?: CoinRegimeContext
}

// Funnel analytics
export interface ScanFunnel {
  coinsScanned: number
  fetchErrors: number
  strategyCandidates: number
  rejectedByVolume: number
  passedScoring: number
  rejectedByRR: number
  passedRisk: number
  byStrategy: Record<string, number>
  byCategory: Record<string, number>
  final: number
}

let isScanning = false

export function isScannerRunning(): boolean {
  return isScanning
}

// === Score Band ===
function getScoreBand(score: number): ScoreBand {
  if (score >= 70) return 'STRONG'
  if (score >= 60) return 'ACTIONABLE'
  if (score >= 50) return 'CONDITIONAL'
  if (score >= 40) return 'OBSERVATIONAL'
  return 'LOW_QUALITY'
}

// === Entry Quality ===
// Separate from signal quality: "is the idea good?" vs "can I enter now?"
// Checks: proximity to levels, RSI on BOTH timeframes, momentum fade,
//         conflicting patterns, volume, SL distance, model type
function assessEntryQuality(signal: SignalWithRisk): EntryQuality {
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'
  let quality = 0 // higher = worse entry timing

  // 1. Price near resistance (LONG) or support (SHORT)
  //    Use both 1h and 4h levels — 4h is stronger
  if (isLong) {
    const dist1h = (tf1h.resistance - tf1h.price) / tf1h.atr
    const dist4h = (tf4h.resistance - tf1h.price) / tf1h.atr
    if (dist1h < 0.5) quality += 2       // close to 1h resistance
    else if (dist1h < 1.0) quality += 1
    if (dist4h < 0.5) quality += 2       // close to 4h resistance (stronger)
  } else {
    const dist1h = (tf1h.price - tf1h.support) / tf1h.atr
    const dist4h = (tf1h.price - tf4h.support) / tf1h.atr
    if (dist1h < 0.5) quality += 2
    else if (dist1h < 1.0) quality += 1
    if (dist4h < 0.5) quality += 2
  }

  // 2. RSI overextended — check BOTH 1h and 4h
  if (isLong) {
    if (tf1h.rsi > 68) quality += 2
    else if (tf1h.rsi > 60) quality += 1
    if (tf4h.rsi > 70) quality += 2      // 4h overheated = bigger problem
    else if (tf4h.rsi > 65) quality += 1
  } else {
    if (tf1h.rsi < 32) quality += 2
    else if (tf1h.rsi < 40) quality += 1
    if (tf4h.rsi < 30) quality += 2
    else if (tf4h.rsi < 35) quality += 1
  }

  // 3. MACD histogram — not just negative, also near zero (losing steam)
  if (isLong) {
    if (tf1h.macdHistogram < 0) quality += 2                    // actively negative
    else if (Math.abs(tf1h.macdHistogram) < tf1h.atr * 0.01) quality += 1  // near zero = fading
  } else {
    if (tf1h.macdHistogram > 0) quality += 2
    else if (Math.abs(tf1h.macdHistogram) < tf1h.atr * 0.01) quality += 1
  }

  // 4. Conflicting candlestick patterns on 1h
  const bearish1h = ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'EVENING_STAR', 'DOUBLE_TOP']
  const bullish1h = ['HAMMER', 'BULLISH_ENGULFING', 'MORNING_STAR', 'DOUBLE_BOTTOM']
  const conflicting = isLong ? bearish1h : bullish1h
  const conflictCount = tf1h.patterns.filter(p => conflicting.includes(p)).length
  if (conflictCount >= 2) quality += 3
  else if (conflictCount === 1) quality += 1

  // 5. Volume weak
  if (tf1h.volRatio < 0.8) quality += 1

  // 6. Distance from entry to stop loss too tight
  if (signal.slPercent < 0.8) quality += 1

  // 7. Best model is pullback only
  if (signal.bestEntryType === 'pullback') quality += 1

  // 8. Stochastic overextended
  if (isLong && tf1h.stochK > 80) quality += 1
  if (!isLong && tf1h.stochK < 20) quality += 1

  if (quality <= 1) return 'GOOD'
  if (quality <= 3) return 'FAIR'
  if (quality <= 5) return 'POOR'
  return 'CHASING'
}

// === Trigger State Detection ===
// For WAIT_CONFIRMATION: what specific event would validate entry?
function detectTrigger(signal: SignalWithRisk): TriggerState | null {
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'

  // Breakout: near level but not through with volume
  if (signal.strategy === 'breakout') {
    if (isLong && tf1h.price > tf1h.resistance * 0.995 && tf1h.price < tf1h.resistance * 1.005) {
      return {
        triggerType: 'breakout_close_above',
        triggerLevel: Math.round(tf1h.resistance * 10000) / 10000,
        triggerTf: '1h',
        invalidIf: `цена теряет EMA20 1h ($${Math.round(tf1h.ema20 * 100) / 100})`,
      }
    }
    if (!isLong && tf1h.price < tf1h.support * 1.005 && tf1h.price > tf1h.support * 0.995) {
      return {
        triggerType: 'breakout_close_below',
        triggerLevel: Math.round(tf1h.support * 10000) / 10000,
        triggerTf: '1h',
        invalidIf: `цена возвращается выше EMA20 1h ($${Math.round(tf1h.ema20 * 100) / 100})`,
      }
    }
  }

  // Trend follow: price above EMA but volume not confirming
  if (signal.strategy === 'trend_follow' && signal.scoreBreakdown.volume < 5) {
    return {
      triggerType: 'volume_confirm',
      triggerLevel: tf1h.price,
      triggerTf: '1h',
      invalidIf: `цена ниже EMA20 на 1h ($${Math.round(tf1h.ema20 * 100) / 100})`,
    }
  }

  // Mean revert: RSI extreme but no reversal candle yet
  if (signal.strategy === 'mean_revert') {
    if (isLong && tf1h.rsi < 35 && tf1h.macdHistogram < 0) {
      return {
        triggerType: 'macd_cross',
        triggerLevel: tf1h.price,
        triggerTf: '1h',
        invalidIf: `новый лоу ниже $${Math.round(tf1h.support * 100) / 100}`,
      }
    }
    if (!isLong && tf1h.rsi > 65 && tf1h.macdHistogram > 0) {
      return {
        triggerType: 'macd_cross',
        triggerLevel: tf1h.price,
        triggerTf: '1h',
        invalidIf: `новый хай выше $${Math.round(tf1h.resistance * 100) / 100}`,
      }
    }
  }

  return null
}

// === CLASSIFICATION ===
// Score band + entry quality + conflicts + triggers → category
function classifySignal(signal: SignalWithRisk, scoreBand: ScoreBand, entryQuality: EntryQuality, trigger: TriggerState | null, coinRegime?: CoinRegimeContext): SignalCategory {
  const viableModels = signal.entryModels.filter(m => m.viable)

  // REJECTED: no viable entry at all
  if (viableModels.length === 0) return 'REJECTED'

  // REJECTED: score too low for any action
  if (scoreBand === 'LOW_QUALITY') return 'REJECTED'

  // CONFLICTED: 2+ strong cross-layer contradictions
  const strongConflicts = detectStrongConflicts(signal, coinRegime)
  if (strongConflicts >= 2) return 'CONFLICTED'

  // WAIT_CONFIRMATION: has a specific trigger
  if (trigger && scoreBand !== 'OBSERVATIONAL') {
    return 'WAIT_CONFIRMATION'
  }

  // LATE_ENTRY: only aggressive viable AND R:R is close to minimum
  if (viableModels.length === 1 && viableModels[0].type === 'aggressive') {
    if (scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE') {
      return 'READY_AGGRESSIVE'
    }
    return 'LATE_ENTRY'
  }

  // PULLBACK_WATCH: signal good but entry is chasing
  if (entryQuality === 'CHASING' && (scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE')) {
    return 'PULLBACK_WATCH'
  }

  // READY: score >= ACTIONABLE + entry at least FAIR + has viable models
  if ((scoreBand === 'STRONG' || scoreBand === 'ACTIONABLE') && (entryQuality === 'GOOD' || entryQuality === 'FAIR')) {
    return 'READY'
  }

  // CONDITIONAL band (50-59): can be READY if entry is good and no conflicts
  if (scoreBand === 'CONDITIONAL' && entryQuality === 'GOOD' && strongConflicts === 0) {
    return 'READY'
  }

  // WATCHLIST: everything else that isn't broken
  return 'WATCHLIST'
}

// Detect strong cross-layer contradictions (quant only, no GPT)
function detectStrongConflicts(signal: SignalWithRisk, coinRegime?: CoinRegimeContext): number {
  let conflicts = 0
  const { tf1h, tf4h } = signal.indicators
  const isLong = signal.type === 'LONG'

  // 1. Direction vs 4h bias with strong ADX (skip if coin has own momentum)
  const hasOwnMomentum = coinRegime?.ownMomentum ?? false
  if (!hasOwnMomentum) {
    if (isLong && tf4h.trend === 'BEARISH' && tf4h.adx > 25) conflicts++
    if (!isLong && tf4h.trend === 'BULLISH' && tf4h.adx > 25) conflicts++
  }

  // 2. Breakout directly into major resistance/support (< 0.5 ATR away on 4h)
  if (signal.strategy === 'breakout') {
    const distToLevel = isLong
      ? (tf4h.resistance - tf1h.price) / tf1h.atr
      : (tf1h.price - tf4h.support) / tf1h.atr
    if (distToLevel < 0.5 && distToLevel > 0) conflicts++
  }

  // 3. Trend follow with hostile market context
  if (signal.strategy === 'trend_follow' && signal.scoreBreakdown.marketContext <= 1) conflicts++

  // 4. Mean reversion in strong trend (ADX > 30)
  if (signal.strategy === 'mean_revert' && tf4h.adx > 30) conflicts++

  // 5. Mean reversion LONG while both TFs momentum falling
  if (signal.strategy === 'mean_revert') {
    if (isLong && tf1h.macdHistogram < 0 && tf4h.macdHistogram < 0 && tf4h.adx > 25) conflicts++
    if (!isLong && tf1h.macdHistogram > 0 && tf4h.macdHistogram > 0 && tf4h.adx > 25) conflicts++
  }

  // 6. Market context extremely hostile (funding squeeze risk)
  if (signal.scoreBreakdown.marketContext <= 0) conflicts++

  return conflicts
}

// Dynamic top-N based on regime
function getTopN(regime: RegimeContext): number {
  switch (regime.regime) {
    case 'TRENDING_UP':
    case 'TRENDING_DOWN':
      return 20
    case 'VOLATILE':
      return 20
    case 'RANGING':
      return 8
    default:
      return 15
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
    passedScoring: 0,
    rejectedByRR: 0,
    passedRisk: 0,
    byStrategy: {},
    byCategory: {},
    final: 0,
  }

  try {
    console.log(`[Scanner] Starting scan for ${coins.length} coins...`)

    // === Phase A: Discovery ===
    const [market, fundingMap, oiMap, newsMap] = await Promise.all([
      fetchMarketOverview(),
      fetchFundingRates(coins),
      fetchOpenInterests(coins),
      fetchAllCoinNews(coins.slice(0, 10)),
    ])

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

    // Detect market regime
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
    const scoredSignals: ScoredSignal[] = []
    const coinRegimes: Record<string, CoinRegimeContext> = {}

    for (const [coin, indicators] of Object.entries(coinIndicators)) {
      const p = indicators.tf1h.price
      if (!p || p <= 0 || !isFinite(p) || indicators.tf1h.atr <= 0) continue

      const coinRegime = detectCoinRegime(indicators, btcInd || null)
      coinRegimes[coin] = coinRegime

      const rawSignal = runStrategies(coin, indicators, regime.regime, coinRegime)
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
      console.log(`[Scanner] ${coin}: ${rawSignal.strategy} ${rawSignal.type} score=${scored.score} vol=${indicators.tf1h.volRatio}x ${coinRegime.ownMomentum ? '[OWN_MOMENTUM]' : ''}`)
      scoredSignals.push(scored)
    }

    scoredSignals.sort((a, b) => b.score - a.score)
    console.log(`[Scanner] ${scoredSignals.length} signals above score ${minScore}`)

    // === Phase C: Trade Construction ===
    const topN = getTopN(regime)
    const topSignals = scoredSignals.slice(0, topN)
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

    // === Phase D: AI Annotation + Classification ===
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
    }

    funnel.final = results.length

    // === Save non-REJECTED signals to DB ===
    const saveable = results.filter(r => r.category !== 'REJECTED')
    const savedIds: Record<string, number> = {}

    for (const r of saveable) {
      try {
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

    return { results, funnel, savedIds }
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
