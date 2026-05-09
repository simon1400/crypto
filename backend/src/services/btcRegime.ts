/**
 * BTC regime indicator — ADX(14) on BTCUSDT 1h.
 *
 * Used as a market-wide trend filter for Daily Breakout: when BTC is in pure
 * sideways regime (ADX ≤ threshold), altcoin breakouts have systematically
 * worse R/tr in 365d backtest.
 *
 * Backtest verification (runBacktest_dailybreak_filters.ts, 2026-05-09):
 *   baseline FULL  R/tr +0.49  finalDepo $6467
 *   ADX > 20 FULL  R/tr +0.55  finalDepo $9387  (+45%)
 *   baseline TEST  R/tr +0.34  finalDepo $2772
 *   ADX > 20 TEST  R/tr +0.35  finalDepo $3925  (+42%)
 *   baseline TRAIN R/tr +0.40  finalDepo $4434
 *   ADX > 20 TRAIN R/tr +0.43  finalDepo $5675
 *
 * Caching: BTC 1h candles refresh slowly. We cache the computed ADX value
 * for 5 minutes — in line with the scanner tick.
 */

import { OHLCV } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import { ema } from './indicators'

const ADX_PERIOD = 14
const CACHE_TTL_MS = 5 * 60_000

let cachedAdx: number | null = null
let cachedAt = 0

function aggregate5mTo1h(m5: OHLCV[]): OHLCV[] {
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const h = Math.floor(c.time / 3600_000) * 3600_000
    const list = buckets.get(h) ?? []
    list.push(c); buckets.set(h, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function adxLast(candles: OHLCV[], period = ADX_PERIOD): number | null {
  const n = candles.length
  if (n < period * 2) return null
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  const trEma = ema(tr, period)
  const plusEma = ema(plusDM, period)
  const minusEma = ema(minusDM, period)
  const dx: number[] = []
  for (let i = 0; i < n; i++) {
    const plusDI = trEma[i] > 0 ? (plusEma[i] / trEma[i]) * 100 : 0
    const minusDI = trEma[i] > 0 ? (minusEma[i] / trEma[i]) * 100 : 0
    const denom = plusDI + minusDI
    dx.push(denom > 0 ? (Math.abs(plusDI - minusDI) / denom) * 100 : 0)
  }
  const adxEma = ema(dx, period)
  return adxEma[adxEma.length - 1] ?? null
}

/**
 * Returns the most recent BTC 1h ADX(14) value, or null if data is unavailable.
 * Cached for 5 minutes. Safe to call from every scanner symbol — only first
 * call per tick triggers a fetch.
 */
export async function getBtcAdx1h(): Promise<number | null> {
  if (cachedAdx != null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedAdx
  }
  try {
    // Load ~3 days of 5m for BTC (288 × 3 = 864 candles → ~72 1h bars after aggregation,
    // enough for ADX(14) Wilder smoothing + EMA stabilization).
    const m5 = await loadHistorical('BTCUSDT', '5m', 1, 'bybit', 'linear')
    const recent = m5.slice(-1500)  // ~5 days margin
    const h1 = aggregate5mTo1h(recent)
    const value = adxLast(h1, ADX_PERIOD)
    if (value != null) {
      cachedAdx = value
      cachedAt = Date.now()
    }
    return value
  } catch (e: any) {
    console.warn(`[BtcRegime] fetch failed: ${e.message}`)
    return null
  }
}

export const BTC_ADX_THRESHOLD = 20
