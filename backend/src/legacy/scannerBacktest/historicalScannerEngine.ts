/**
 * Historical Scanner Engine — replays the live scanner pipeline against
 * cached OHLCV history, producing the same EnrichedSignal as the live scanner
 * would have produced at moment T.
 *
 * Differences from live runScan() (intentional):
 *   1. data_completeness gate is RELAXED: only funding is real (Bybit history).
 *      OI/LSR are stubbed with neutral values. Without this, every signal
 *      would fail data_completeness ≥ 90%.
 *   2. Liquidations are not used (signalExplanation only — doesn't affect score).
 *   3. News are null (not used by hard filters or score).
 *   4. MarketOverview fearGreed/btcDominance set to neutral (not used in scoring).
 *
 * Everything else — strategies, hardFilters, setupScore, entryTrigger,
 * executionType, riskProfile — is the live code, imported from production paths.
 */

import { OHLCV, MarketOverview } from '../../services/market'
import { computeIndicators, MultiTFIndicators } from '../../services/indicators'
import { detectMarketRegime, RegimeContext } from '../../scanner/marketRegime'
import { detectCoinRegime } from '../../scanner/coinRegime'
import { runStrategies, RawSignal } from '../../scanner/strategies/index'
import { runScoringPipeline, EnrichedSignal } from '../../scanner/scoring/index'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { LSRData } from '../../services/longShortRatio'

// === Neutral stub values ===
// Used to satisfy data_completeness gate without poisoning derivatives score.

// openInterest must be > 0 to count toward data_completeness;
// changes are 0 so derivatives score gets neither bonus nor penalty.
const NEUTRAL_OI: OIData = {
  symbol: 'STUB',
  openInterest: 1,
  openInterestUsd: 1,
  oiChangePct1h: 0,
  oiChangePct4h: 0,
}

const NEUTRAL_LSR: LSRData = {
  symbol: 'STUB',
  buyRatio: 0.5, // exactly even — no LONG/SHORT crowding bias
  sellRatio: 0.5,
  timestamp: 0,
}

const NEUTRAL_MARKET: MarketOverview = {
  fearGreed: 50,
  fearGreedLabel: 'Neutral',
  btcDominance: 50,
}

// === Slice candles up to a point in time (exclusive) ===
// Returns the most recent N candles strictly before `cutoffMs`.
export function slicePast(candles: OHLCV[], cutoffMs: number, count: number): OHLCV[] {
  // Binary-search the index of first candle with time >= cutoffMs.
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < cutoffMs) lo = mid + 1
    else hi = mid
  }
  // lo = number of candles strictly before cutoffMs
  if (lo === 0) return []
  const start = Math.max(0, lo - count)
  return candles.slice(start, lo)
}

// === Build MultiTFIndicators from cached candles for one symbol at moment T ===
// Mirrors the data shape the live scanner builds in coinScanner/index.ts.
export interface SymbolHistoricalData {
  candles5m: OHLCV[]
  candles15m: OHLCV[]
  candles1h: OHLCV[]
  candles4h: OHLCV[]
}

export interface HistoricalSnapshot {
  cutoffMs: number
  candles5m: OHLCV[]   // last 30
  candles15m: OHLCV[]  // last 60
  candles1h: OHLCV[]   // last 60
  candles4h: OHLCV[]   // last 200
  indicators: MultiTFIndicators
}

export function buildSnapshot(data: SymbolHistoricalData, cutoffMs: number): HistoricalSnapshot | null {
  // Match live scanner volumes: 30 × 5m, 60 × 15m, 60 × 1h, 200 × 4h
  const c5 = slicePast(data.candles5m, cutoffMs, 30)
  const c15 = slicePast(data.candles15m, cutoffMs, 60)
  const c1h = slicePast(data.candles1h, cutoffMs, 60)
  const c4h = slicePast(data.candles4h, cutoffMs, 200)

  // Need full warm-up windows; if any TF is short, snapshot is invalid.
  if (c5.length < 30 || c15.length < 60 || c1h.length < 60 || c4h.length < 200) return null

  const indicators: MultiTFIndicators = {
    tf15m: computeIndicators(c15),
    tf1h: computeIndicators(c1h),
    tf4h: computeIndicators(c4h),
  }
  return { cutoffMs, candles5m: c5, candles15m: c15, candles1h: c1h, candles4h: c4h, indicators }
}

// === Build BTC RegimeContext at moment T ===
// Live scanner uses BTC's 1h+4h indicators to detect regime.
export function buildBtcRegime(btcData: SymbolHistoricalData, cutoffMs: number): RegimeContext {
  const snapshot = buildSnapshot(btcData, cutoffMs)
  if (!snapshot) {
    return {
      regime: 'RANGING',
      confidence: 50,
      btcTrend: 'SIDEWAYS',
      fearGreedZone: 'NEUTRAL',
      volatility: 'NORMAL',
    }
  }
  return detectMarketRegime(
    { tf1h: snapshot.indicators.tf1h, tf4h: snapshot.indicators.tf4h },
    NEUTRAL_MARKET,
  )
}

// === Run scoring for one coin at one moment ===
// Returns null if no signal or if any strategy/scoring step rejects.
export interface ScoringContext {
  regime: RegimeContext
  btcSnapshot: HistoricalSnapshot
  fundingAt: (timeMs: number) => number | null
}

export function scoreSymbolAt(
  coin: string,
  data: SymbolHistoricalData,
  cutoffMs: number,
  ctx: ScoringContext,
): EnrichedSignal | null {
  const snapshot = buildSnapshot(data, cutoffMs)
  if (!snapshot) return null

  const indicators = snapshot.indicators
  const p = indicators.tf1h.price
  if (!p || p <= 0 || !isFinite(p) || indicators.tf1h.atr <= 0) return null

  // Coin regime relative to BTC
  const coinRegime = detectCoinRegime(indicators, ctx.btcSnapshot.indicators)

  // Run strategies — same as live runScan
  const rawSignal: RawSignal | null = runStrategies(coin, indicators, ctx.regime.regime, coinRegime)
  if (!rawSignal) return null

  // Build funding data at this moment (real Bybit history)
  const fundingRate = ctx.fundingAt(cutoffMs)
  const funding: FundingData | null = fundingRate !== null
    ? {
        symbol: `${coin}USDT`,
        fundingRate,
        nextFundingTime: cutoffMs + 8 * 3600_000,
      }
    : null

  // Stub OI/LSR with neutral values to satisfy data_completeness gate
  // without injecting bias into derivatives score.
  const oi: OIData = { ...NEUTRAL_OI, symbol: `${coin}USDT` }
  const lsr: LSRData = { ...NEUTRAL_LSR, symbol: `${coin}USDT` }

  // Run live scoring pipeline against historical inputs
  const enriched = runScoringPipeline(
    rawSignal,
    ctx.regime,
    coinRegime,
    funding,
    oi,
    null, // news — not used by hard filters or score
    null, // liquidations — not used by score
    lsr,
    snapshot.candles5m,
    snapshot.candles15m,
  )

  return enriched
}
