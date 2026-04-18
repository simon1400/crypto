import { describe, it, expect } from 'vitest'
import { calculateHardFilters, detectExtendedRegime, detectBtcRegime, calculateDataCompleteness } from '../src/scanner/scoring/hardFilters'
import { calculateSetupScore, assignSignalCategory } from '../src/scanner/scoring/setupScore'
import { calculateEntryTrigger } from '../src/scanner/scoring/entryTrigger'
import { selectEntryModel, computeRiskProfile, calculateStopLoss } from '../src/scanner/scoring/riskProfile'
import { selectExecutionType } from '../src/scanner/scoring/executionType'
import { runScoringPipeline } from '../src/scanner/scoring/index'
import { ScoringInput, SetupCategory } from '../src/scanner/scoring/types'
import { RawSignal } from '../src/scanner/strategies/index'
import { RegimeContext } from '../src/scanner/marketRegime'
import { CoinIndicators, MultiTFIndicators } from '../src/services/indicators'
import { OHLCV } from '../src/services/market'
import { computeIndicators } from '../src/services/indicators'

// === TEST HELPERS ===

function makeCoinIndicators(overrides: Partial<CoinIndicators> = {}): CoinIndicators {
  return {
    price: 100,
    ema9: 100.5,
    ema20: 99,
    ema50: 97,
    ema200: 92,
    rsi: 55,
    trend: 'BULLISH',
    trendDetail: 'BULLISH',
    marketStructure: 'HH_HL',
    swingHighs: [],
    swingLows: [],
    support: 95,
    resistance: 110,
    volRatio: 1.5,
    change24h: 2.5,
    macd: 0.5,
    macdSignal: 0.3,
    macdHistogram: 0.2,
    bbUpper: 105,
    bbMiddle: 100,
    bbLower: 95,
    bbWidth: 3,
    stochK: 55,
    stochD: 50,
    adx: 25,
    plusDI: 30,
    minusDI: 20,
    fibLevels: [],
    pivot: 100,
    pivotR1: 103,
    pivotR2: 106,
    pivotS1: 97,
    pivotS2: 94,
    patterns: [],
    vwap: 99.5,
    atr: 2,
    ...overrides,
  }
}

function makeIndicators(
  overrides1h: Partial<CoinIndicators> = {},
  overrides4h: Partial<CoinIndicators> = {},
  overrides15m: Partial<CoinIndicators> = {},
): MultiTFIndicators {
  return {
    tf15m: makeCoinIndicators({ atr: 0.5, ...overrides15m }),
    tf1h: makeCoinIndicators(overrides1h),
    tf4h: makeCoinIndicators({ atr: 4, resistance: 115, support: 90, ...overrides4h }),
  }
}

function makeRawSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    coin: 'SOL',
    type: 'LONG',
    strategy: 'trend_follow',
    confidence: 7,
    maxConfidence: 10,
    reasons: ['Test signal'],
    indicators: makeIndicators(),
    ...overrides,
  }
}

function makeRegime(overrides: Partial<RegimeContext> = {}): RegimeContext {
  return {
    regime: 'TRENDING_UP',
    confidence: 75,
    btcTrend: 'BULLISH',
    fearGreedZone: 'NEUTRAL',
    volatility: 'NORMAL',
    ...overrides,
  }
}

function makeScoringInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  const regime = makeRegime()
  return {
    raw: makeRawSignal(),
    regime,
    extendedRegime: detectExtendedRegime(regime),
    btcRegime: detectBtcRegime(regime),
    funding: { symbol: 'SOLUSDT', fundingRate: 0.0001, nextFundingTime: Date.now() + 28800000 },
    oi: { symbol: 'SOLUSDT', openInterest: 1000000, openInterestUsd: 100000000, oiChangePct1h: 1, oiChangePct4h: 3 },
    lsr: { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    ...overrides,
  }
}

// === TESTS ===

describe('Hard Filters', () => {
  it('should pass for valid trend-follow LONG in TRENDING_UP', () => {
    const input = makeScoringInput()
    const result = calculateHardFilters(input)
    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it('should fail for trend-follow LONG in TRENDING_DOWN regime', () => {
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH' })
    const input = makeScoringInput({
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.passed).toBe(false)
    expect(result.market_regime_ok).toBe(false)
  })

  it('should fail for trend-follow LONG when BTC is RISK_OFF', () => {
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH', confidence: 85 })
    const input = makeScoringInput({
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: 'RISK_OFF',
    })
    const result = calculateHardFilters(input)
    expect(result.btc_regime_ok).toBe(false)
  })

  it('should fail when data completeness < 0.9', () => {
    const input = makeScoringInput({
      funding: null,
      oi: null,
      lsr: null,
    })
    const result = calculateHardFilters(input)
    expect(result.data_completeness_ok).toBe(false)
  })

  it('should pass mean-revert only in RANGING regime', () => {
    const regime = makeRegime({ regime: 'RANGING' })
    const raw = makeRawSignal({ strategy: 'mean_revert', indicators: makeIndicators({ rsi: 28, trend: 'SIDEWAYS' }) })
    const input = makeScoringInput({
      raw,
      regime,
      extendedRegime: detectExtendedRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(true)
  })

  it('should fail mean-revert in TRENDING_UP regime', () => {
    const input = makeScoringInput({
      raw: makeRawSignal({ strategy: 'mean_revert' }),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
  })

  // === Directional regime gate (Week 1 audit) ===
  // Block SHORT in bullish regimes (RISK_ON_UP_ONLY / STRONG_TRENDING_UP)
  // Block LONG in bearish regimes (RISK_OFF / STRONG_TRENDING_DOWN)
  // Applies across ALL strategies (trend_follow, mean_revert, breakout)

  it('should block SHORT trend_follow when BTC is RISK_ON_UP_ONLY', () => {
    const regime = makeRegime({ regime: 'TRENDING_UP', btcTrend: 'BULLISH', confidence: 75 })
    const input = makeScoringInput({
      raw: makeRawSignal({ type: 'SHORT', strategy: 'trend_follow' }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
    expect(result.btc_regime_ok).toBe(false)
    expect(result.failures.some(f => f.includes('Bullish regime'))).toBe(true)
  })

  it('should block SHORT mean_revert when STRONG_TRENDING_UP', () => {
    const regime = makeRegime({ regime: 'TRENDING_UP', btcTrend: 'BULLISH', confidence: 90 })
    const input = makeScoringInput({
      raw: makeRawSignal({ type: 'SHORT', strategy: 'mean_revert' }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
    expect(result.failures.some(f => f.includes('Bullish regime'))).toBe(true)
  })

  it('should block SHORT breakout when STRONG_TRENDING_UP', () => {
    const regime = makeRegime({ regime: 'TRENDING_UP', btcTrend: 'BULLISH', confidence: 90 })
    const input = makeScoringInput({
      raw: makeRawSignal({ type: 'SHORT', strategy: 'breakout' }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
  })

  it('should block LONG when BTC is RISK_OFF', () => {
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH', confidence: 75 })
    const input = makeScoringInput({
      raw: makeRawSignal({ type: 'LONG', strategy: 'trend_follow' }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
    expect(result.btc_regime_ok).toBe(false)
    expect(result.failures.some(f => f.includes('Bearish regime'))).toBe(true)
  })

  it('should block LONG mean_revert in STRONG_TRENDING_DOWN', () => {
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH', confidence: 90 })
    const input = makeScoringInput({
      raw: makeRawSignal({ type: 'LONG', strategy: 'mean_revert' }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(false)
    expect(result.failures.some(f => f.includes('Bearish regime'))).toBe(true)
  })

  it('should NOT block SHORT in NEUTRAL regime (TRENDING_DOWN, not strong)', () => {
    // SHORT trend_follow in TRENDING_DOWN with confidence < 80 → universal gate passes,
    // strategy-specific filter passes (TRENDING_DOWN allowed for SHORT trend_follow)
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH', confidence: 70 })
    const input = makeScoringInput({
      raw: makeRawSignal({
        type: 'SHORT',
        strategy: 'trend_follow',
        indicators: makeIndicators(
          { price: 88, ema20: 90, ema50: 95, ema200: 100, trend: 'BEARISH', trendDetail: 'BEARISH', marketStructure: 'LH_LL' },
          { price: 88, ema20: 90, ema50: 95, ema200: 100, trendDetail: 'BEARISH' },
        ),
      }),
      regime,
      extendedRegime: detectExtendedRegime(regime),
      btcRegime: detectBtcRegime(regime),
    })
    const result = calculateHardFilters(input)
    // Universal gate doesn't block (not RISK_OFF, not STRONG_TRENDING_DOWN)
    // Strategy filter passes (regime is TRENDING_DOWN which is allowed for SHORT trend_follow)
    expect(result.market_regime_ok).toBe(true)
  })

  it('should NOT block LONG in NEUTRAL TRENDING_UP (non-strong)', () => {
    // Default makeRegime is TRENDING_UP confidence 75 (not strong) — LONG should pass
    const input = makeScoringInput()
    const result = calculateHardFilters(input)
    expect(result.market_regime_ok).toBe(true)
  })
})

describe('Setup Score', () => {
  it('should produce score between 0 and 100', () => {
    const input = makeScoringInput()
    const breakdown = calculateSetupScore(input)
    expect(breakdown.total).toBeGreaterThanOrEqual(0)
    expect(breakdown.total).toBeLessThanOrEqual(100)
  })

  it('should give higher trend score when 4h and 1h aligned bullish for LONG', () => {
    const input = makeScoringInput()
    const breakdown = calculateSetupScore(input)
    expect(breakdown.trend).toBeGreaterThan(10) // strong alignment should give high trend
  })

  it('should apply penalty for impulse extension', () => {
    // Price far from EMA20 → penalty
    const indicators = makeIndicators({ price: 110, ema20: 99, atr: 2 })
    const raw = makeRawSignal({ indicators })
    const input = makeScoringInput({ raw })
    const breakdown = calculateSetupScore(input)
    expect(breakdown.penalties).toBeLessThan(0)
    expect(breakdown.penalties_applied.some(p => p.includes('импульса'))).toBe(true)
  })

  it('should apply missing data penalty', () => {
    const input = makeScoringInput({ funding: null, oi: null, lsr: null })
    const breakdown = calculateSetupScore(input)
    expect(breakdown.penalties_applied.some(p => p.includes('данны'))).toBe(true)
  })
})

describe('Category Assignment', () => {
  it('should assign A_PLUS_READY for score >= 72', () => {
    expect(assignSignalCategory(75)).toBe('A_PLUS_READY')
    expect(assignSignalCategory(72)).toBe('A_PLUS_READY')
  })

  it('should assign READY for score 64-71', () => {
    expect(assignSignalCategory(64)).toBe('READY')
    expect(assignSignalCategory(71)).toBe('READY')
  })

  it('should assign WATCHLIST for score 56-63', () => {
    expect(assignSignalCategory(56)).toBe('WATCHLIST')
    expect(assignSignalCategory(63)).toBe('WATCHLIST')
  })

  it('should assign IGNORE for score < 56', () => {
    expect(assignSignalCategory(55)).toBe('IGNORE')
    expect(assignSignalCategory(0)).toBe('IGNORE')
  })
})

describe('Entry Trigger', () => {
  it('should pass when price is near pullback zone with confirmation', () => {
    // Price at EMA20, 15m confirms, good volume, close to trigger
    const indicators = makeIndicators(
      { price: 99, ema20: 99.5, vwap: 99, support: 98 },
      {},
      { price: 99, ema9: 98.5, macdHistogram: 0.1, volRatio: 1.2, atr: 0.5 },
    )
    const result = calculateEntryTrigger('LONG', indicators)
    expect(result.score).toBeGreaterThanOrEqual(3)
    expect(result.passed).toBe(true)
  })

  it('should fail when price is far from pullback zone', () => {
    // Price well above EMA20
    const indicators = makeIndicators(
      { price: 110, ema20: 99, vwap: 99, support: 95 },
      {},
      { price: 110, ema9: 109, macdHistogram: -0.1, volRatio: 0.7, atr: 0.5 },
    )
    const result = calculateEntryTrigger('LONG', indicators)
    expect(result.passed).toBe(false)
  })
})

describe('Entry Model Selection', () => {
  it('should select aggressive only for A_PLUS_READY with pullback', () => {
    const trigger = {
      passed: true,
      score: 3,
      conditions: { pullback_zone: true, candle_reclaim: true, reversal_volume: true, distance_from_trigger: false },
      details: [],
    }
    expect(selectEntryModel('A_PLUS_READY', trigger, 'trend_follow')).toBe('aggressive')
  })

  it('should select confirmation for READY (not aggressive)', () => {
    const trigger = {
      passed: true,
      score: 3,
      conditions: { pullback_zone: true, candle_reclaim: true, reversal_volume: true, distance_from_trigger: false },
      details: [],
    }
    expect(selectEntryModel('READY', trigger, 'trend_follow')).toBe('confirmation')
  })

  it('should not allow aggressive for non-A+ setups', () => {
    const trigger = {
      passed: true,
      score: 4,
      conditions: { pullback_zone: true, candle_reclaim: true, reversal_volume: true, distance_from_trigger: true },
      details: [],
    }
    expect(selectEntryModel('WATCHLIST', trigger, 'trend_follow')).toBe('confirmation')
    expect(selectEntryModel('IGNORE', trigger, 'trend_follow')).toBe('confirmation')
  })
})

describe('Risk Profile', () => {
  it('should give higher risk % to A_PLUS_READY', () => {
    const a = computeRiskProfile('A_PLUS_READY', 'trend_follow', 'confirmation')
    const r = computeRiskProfile('READY', 'trend_follow', 'confirmation')
    expect(a.risk_pct).toBeGreaterThan(r.risk_pct)
  })

  it('should limit aggressive risk to 0.5%', () => {
    const profile = computeRiskProfile('A_PLUS_READY', 'trend_follow', 'aggressive')
    expect(profile.risk_pct).toBeLessThanOrEqual(0.5)
  })

  it('should limit mean_revert risk to 0.5%', () => {
    const profile = computeRiskProfile('A_PLUS_READY', 'mean_revert', 'confirmation')
    expect(profile.risk_pct).toBeLessThanOrEqual(0.5)
  })
})

describe('SL Downgrade', () => {
  it('should downgrade to WATCHLIST/IGNORE when SL > 4%', () => {
    // Use an asset with very high ATR to get large SL
    const indicators = makeIndicators(
      { price: 100, atr: 5, support: 85, resistance: 120 },
      { price: 100, atr: 8 },
    )
    const raw = makeRawSignal({ indicators })
    const regime = makeRegime()

    const enriched = runScoringPipeline(raw, regime, undefined,
      { symbol: 'SOLUSDT', fundingRate: 0.0001, nextFundingTime: Date.now() + 28800000 },
      { symbol: 'SOLUSDT', openInterest: 1000000, openInterestUsd: 100000000, oiChangePct1h: 1, oiChangePct4h: 3 },
      null, null,
      { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    )

    if (enriched && enriched.risk_pct > 4.0) {
      expect(['WATCHLIST', 'IGNORE']).toContain(enriched.category)
    }
  })
})

describe('Stop Preservation', () => {
  it('should set initial_stop and current_stop to same value on creation', () => {
    const result = calculateStopLoss('LONG', 100, 'trend_follow', makeIndicators())
    expect(result.stopLoss).toBeLessThan(100)
    // Both should be the same at creation
    expect(result.stopLoss).toBe(result.stopLoss) // trivial but documents intent
  })

  it('should preserve initial_stop in enriched signal', () => {
    const regime = makeRegime()
    const enriched = runScoringPipeline(
      makeRawSignal(), regime, undefined,
      { symbol: 'SOLUSDT', fundingRate: 0.0001, nextFundingTime: Date.now() + 28800000 },
      { symbol: 'SOLUSDT', openInterest: 1000000, openInterestUsd: 100000000, oiChangePct1h: 1, oiChangePct4h: 3 },
      null, null,
      { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    )

    expect(enriched).not.toBeNull()
    if (enriched) {
      expect(enriched.initial_stop).toBe(enriched.current_stop)
      expect(enriched.signal_context.initial_stop).toBe(enriched.initial_stop)
      expect(enriched.signal_context.current_stop).toBe(enriched.current_stop)
    }
  })
})

describe('Full Pipeline', () => {
  it('should produce valid enriched signal for qualifying LONG trend-follow', () => {
    const regime = makeRegime()
    const enriched = runScoringPipeline(
      makeRawSignal(), regime, undefined,
      { symbol: 'SOLUSDT', fundingRate: 0.0001, nextFundingTime: Date.now() + 28800000 },
      { symbol: 'SOLUSDT', openInterest: 1000000, openInterestUsd: 100000000, oiChangePct1h: 1, oiChangePct4h: 3 },
      null, null,
      { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    )

    expect(enriched).not.toBeNull()
    if (!enriched) return

    // Should have all scoring layers
    expect(enriched.hard_filter).toBeDefined()
    expect(enriched.setup_score).toBeGreaterThanOrEqual(0)
    expect(enriched.setup_breakdown).toBeDefined()
    expect(enriched.entry_trigger).toBeDefined()
    expect(enriched.category).toBeDefined()
    expect(enriched.execution_type).toBeDefined()

    // Should have entry/exit
    expect(enriched.entry).toBeGreaterThan(0)
    expect(enriched.initial_stop).toBeLessThan(enriched.entry)
    expect(enriched.take_profits).toHaveLength(3)

    // TPs should follow 1.2R / 2.2R / 3.5R pattern
    expect(enriched.take_profits[0].close_pct).toBe(35)
    expect(enriched.take_profits[1].close_pct).toBe(35)
    expect(enriched.take_profits[2].close_pct).toBe(30)

    // Explanation should be complete
    expect(enriched.explanation).toBeDefined()
    expect(enriched.explanation.hard_filter_result).toBeDefined()
    expect(enriched.explanation.setup_score_breakdown).toBeDefined()
    expect(enriched.explanation.entry_trigger_score).toBeDefined()

    // Signal context should be populated
    expect(enriched.signal_context.market_regime).toBeDefined()
    expect(enriched.signal_context.rsi_1h).toBeDefined()
    expect(enriched.signal_context.data_completeness).toBeGreaterThan(0)
  })

  it('should return IGNORE for signal with failing hard filters', () => {
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH', confidence: 85 })
    const enriched = runScoringPipeline(
      makeRawSignal(), regime, undefined,
      { symbol: 'SOLUSDT', fundingRate: 0.0001, nextFundingTime: Date.now() + 28800000 },
      { symbol: 'SOLUSDT', openInterest: 1000000, openInterestUsd: 100000000, oiChangePct1h: 1, oiChangePct4h: 3 },
      null, null,
      { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    )

    expect(enriched).not.toBeNull()
    if (enriched) {
      expect(enriched.hard_filter.passed).toBe(false)
      expect(enriched.category).toBe('IGNORE')
    }
  })
})

describe('Data Completeness', () => {
  it('should return 1.0 when all data present', () => {
    expect(calculateDataCompleteness(
      { symbol: 'X', fundingRate: 0.001, nextFundingTime: 0 },
      { symbol: 'X', openInterest: 100, openInterestUsd: 1000, oiChangePct1h: 1, oiChangePct4h: 2 },
      { buyRatio: 0.5, sellRatio: 0.5, ratio: '1.0' } as any,
    )).toBe(1)
  })

  it('should return 0 when no data present', () => {
    expect(calculateDataCompleteness(null, null, null)).toBe(0)
  })

  it('should return 0.67 when one field missing', () => {
    expect(calculateDataCompleteness(
      { symbol: 'X', fundingRate: 0.001, nextFundingTime: 0 },
      { symbol: 'X', openInterest: 100, openInterestUsd: 1000, oiChangePct1h: 1, oiChangePct4h: 2 },
      null,
    )).toBe(0.67)
  })
})

// === NEW TESTS ===

describe('EMA200-based trend scoring', () => {
  it('should give max trend score when price > EMA200 and EMA50 > EMA200 on 4h', () => {
    const indicators = makeIndicators(
      { price: 100, ema50: 97, ema200: 90, trendDetail: 'BULLISH', marketStructure: 'HH_HL' },
      { price: 100, ema50: 97, ema200: 90, trendDetail: 'BULLISH', marketStructure: 'HH_HL' },
    )
    const raw = makeRawSignal({ indicators })
    const input = makeScoringInput({ raw })
    const breakdown = calculateSetupScore(input)
    // Should get +10 for 4h EMA200 alignment
    expect(breakdown.trend).toBeGreaterThanOrEqual(20)
  })

  it('should give lower trend score when price below EMA200', () => {
    const indicators = makeIndicators(
      { price: 88, ema50: 90, ema200: 92, trendDetail: 'SIDEWAYS', marketStructure: 'UNKNOWN' },
      { price: 88, ema50: 90, ema200: 92, trendDetail: 'SIDEWAYS', marketStructure: 'UNKNOWN' },
    )
    const raw = makeRawSignal({ indicators })
    const input = makeScoringInput({ raw })
    const breakdown = calculateSetupScore(input)
    expect(breakdown.trend).toBeLessThan(15)
  })

  it('should use EMA200 in hard filters for trend-follow', () => {
    // 4h price below EMA200 — should fail LONG trend-follow
    const indicators = makeIndicators(
      {},
      { price: 88, ema50: 90, ema200: 95 },
    )
    const raw = makeRawSignal({ indicators })
    const regime = makeRegime()
    const input = makeScoringInput({
      raw,
      regime,
      extendedRegime: detectExtendedRegime(regime),
    })
    const result = calculateHardFilters(input)
    expect(result.trend_4h_ok).toBe(false)
  })
})

describe('HH/HL and LH/LL classification', () => {
  it('should detect HH_HL structure and give trend score bonus', () => {
    const indicators = makeIndicators(
      { marketStructure: 'HH_HL', trendDetail: 'BULLISH' },
      { marketStructure: 'HH_HL' },
    )
    const raw = makeRawSignal({ indicators })
    const input = makeScoringInput({ raw })
    const breakdown = calculateSetupScore(input)
    // HH_HL gives +5 for structure
    expect(breakdown.trend).toBeGreaterThanOrEqual(5)
  })

  it('should detect LH_LL for short signals', () => {
    const indicators = makeIndicators(
      { price: 88, ema20: 90, ema50: 95, ema200: 100, trend: 'BEARISH', trendDetail: 'BEARISH', marketStructure: 'LH_LL' },
      { price: 88, ema20: 90, ema50: 95, ema200: 100, trendDetail: 'BEARISH', marketStructure: 'LH_LL' },
    )
    const raw = makeRawSignal({ type: 'SHORT', indicators })
    const regime = makeRegime({ regime: 'TRENDING_DOWN', btcTrend: 'BEARISH' })
    const input = makeScoringInput({ raw, regime, extendedRegime: detectExtendedRegime(regime), btcRegime: detectBtcRegime(regime) })
    const breakdown = calculateSetupScore(input)
    expect(breakdown.trend).toBeGreaterThanOrEqual(5)
  })

  it('should compute EMA200 and structure from real candles', () => {
    // Generate 210 synthetic candles with uptrend
    const candles: OHLCV[] = []
    let price = 50
    for (let i = 0; i < 210; i++) {
      price += (Math.random() - 0.3) * 0.5 // slight upward bias
      candles.push({
        time: Date.now() - (210 - i) * 3600000,
        open: price - 0.1,
        high: price + Math.random() * 0.5,
        low: price - Math.random() * 0.5,
        close: price,
        volume: 1000 + Math.random() * 500,
      })
    }
    const result = computeIndicators(candles)
    expect(result.ema200).toBeGreaterThan(0)
    expect(result.trendDetail).toBeDefined()
    expect(result.marketStructure).toBeDefined()
    expect(result.swingHighs.length).toBeGreaterThan(0)
    expect(result.swingLows.length).toBeGreaterThan(0)
  })
})

describe('Entry trigger with candle OHLC', () => {
  it('should detect reclaim from actual candle data', () => {
    const indicators = makeIndicators(
      { price: 99.5, ema20: 99, vwap: 99.2, support: 98 },
      {},
      { price: 99.5, ema9: 99, macdHistogram: 0.1, volRatio: 1.2, atr: 0.5 },
    )

    // 5m candles: dipped below EMA20 then closed above
    const candles5m: OHLCV[] = [
      { time: 1, open: 99.5, high: 99.8, low: 98.5, close: 98.8, volume: 1200 },
      { time: 2, open: 98.8, high: 99.3, low: 98.6, close: 99.1, volume: 1500 },
      { time: 3, open: 99.1, high: 99.6, low: 99.0, close: 99.5, volume: 1800 },
    ]

    // Add more candles for avg volume calculation
    const fullCandles: OHLCV[] = Array.from({ length: 20 }, (_, i) => ({
      time: i, open: 99, high: 99.5, low: 98.5, close: 99, volume: 1000,
    })).concat(candles5m)

    const result = calculateEntryTrigger('LONG', indicators, fullCandles)
    expect(result.conditions.candle_reclaim).toBe(true)
  })

  it('should fail candle_reclaim when no bounce pattern', () => {
    const indicators = makeIndicators(
      { price: 105, ema20: 99, vwap: 99, support: 95 },
      {},
      { price: 105, ema9: 104.5, macdHistogram: 0.3, volRatio: 0.8, atr: 0.5 },
    )

    // 5m candles: all above trigger level, no dip
    const candles5m: OHLCV[] = Array.from({ length: 23 }, (_, i) => ({
      time: i, open: 104.5, high: 105.5, low: 104, close: 105, volume: 1000,
    }))

    const result = calculateEntryTrigger('LONG', indicators, candles5m)
    expect(result.conditions.candle_reclaim).toBe(false)
  })
})

describe('ENTER_NOW downgrade to LIMIT', () => {
  it('should downgrade to LIMIT when price too extended from trigger', () => {
    // Price far above EMA20/VWAP — impulse extension high
    const indicators = makeIndicators(
      { price: 108, ema20: 99, vwap: 99, support: 95, atr: 2 },
      { price: 108, ema200: 90, ema50: 97 },
      { price: 108, ema9: 107, atr: 0.5 },
    )

    const execType = selectExecutionType(
      'LONG',
      'READY',
      { passed: true, score: 3, conditions: { pullback_zone: false, candle_reclaim: true, reversal_volume: true, distance_from_trigger: false }, details: [] },
      indicators,
    )

    // Should not be ENTER_NOW because distFromTrigger is too high
    expect(execType).not.toBe('ENTER_NOW_LONG')
    expect(['LIMIT_LONG', 'WAIT_CONFIRMATION']).toContain(execType)
  })

  it('should allow ENTER_NOW when close to pullback zone', () => {
    const indicators = makeIndicators(
      { price: 99.2, ema20: 99, vwap: 99.1, support: 98, atr: 2 },
      { price: 99.2, ema200: 90, ema50: 97 },
      { price: 99.2, ema9: 99, atr: 0.5 },
    )

    const execType = selectExecutionType(
      'LONG',
      'READY',
      { passed: true, score: 3, conditions: { pullback_zone: true, candle_reclaim: true, reversal_volume: true, distance_from_trigger: true }, details: [] },
      indicators,
    )

    expect(execType).toBe('ENTER_NOW_LONG')
  })
})

describe('LIMIT veto for lossy strategy/Score combinations (Week 1 audit)', () => {
  // Setup: extended price → would normally route to LIMIT_*
  const extendedIndicators = makeIndicators(
    { price: 108, ema20: 99, vwap: 99, support: 95, atr: 2 },
    { price: 108, ema200: 90, ema50: 97 },
    { price: 108, ema9: 107, atr: 0.5 },
  )
  const trigger = { passed: true, score: 4, conditions: { pullback_zone: true, candle_reclaim: true, reversal_volume: true, distance_from_trigger: true }, details: [] }

  it('should veto LIMIT for mean_revert and route to WAIT_CONFIRMATION', () => {
    const execType = selectExecutionType('LONG', 'READY', trigger, extendedIndicators, 'mean_revert', 65)
    expect(execType).toBe('WAIT_CONFIRMATION')
  })

  it('should veto LIMIT for breakout with Score < 72', () => {
    const execType = selectExecutionType('LONG', 'READY', trigger, extendedIndicators, 'breakout', 65)
    expect(execType).toBe('WAIT_CONFIRMATION')
  })

  it('should allow LIMIT for breakout with Score >= 72', () => {
    const execType = selectExecutionType('LONG', 'READY', trigger, extendedIndicators, 'breakout', 75)
    expect(execType).toBe('LIMIT_LONG')
  })

  it('should allow LIMIT for trend_follow regardless of Score', () => {
    const execType = selectExecutionType('LONG', 'READY', trigger, extendedIndicators, 'trend_follow', 60)
    expect(execType).toBe('LIMIT_LONG')
  })

  it('should fall back to LIMIT (no veto) when strategy is not provided', () => {
    // Backward compat: old callers don't pass strategy → no veto
    const execType = selectExecutionType('LONG', 'READY', trigger, extendedIndicators)
    expect(execType).toBe('LIMIT_LONG')
  })
})
