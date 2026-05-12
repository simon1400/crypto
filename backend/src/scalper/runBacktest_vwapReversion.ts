/**
 * VWAP Reversion (intraday session VWAP, 5m execution) — backtest.
 *
 * Hypothesis:
 *   In range-bound regimes, price tends to revert to the day's session VWAP
 *   after extending more than 2σ away from it. This is a classic mean-reversion
 *   edge well-documented in equity markets; the question is whether it survives
 *   crypto's 24/7 nature and altcoin volatility, after fees.
 *
 * Session definition:
 *   VWAP resets at 00:00 UTC every day. Accumulates (typical × volume) and
 *   volume from session start. σ is the rolling standard deviation of (close -
 *   VWAP) over the session-so-far, computed bar-by-bar.
 *
 * Detection (per 5m bar after first 30 minutes of session):
 *   z = (close - VWAP) / σ
 *   If |z| ≥ Z_THRESHOLD and bar's close is closer to VWAP than its open
 *   (i.e. price has already started reverting — exhaustion signal), enter:
 *     z > +Z → SHORT (fade up extension)
 *     z < -Z → LONG (fade down extension)
 *
 * Regime filter (ADX 1h on BTC):
 *   Skip ALL trades when BTC's 1h ADX(14) ≥ 20. This is the inverse of the
 *   Daily Breakout filter — we want non-trending regimes for mean-reversion.
 *   The BTC ADX is computed on each 5m bar using all BTC 1h candles up to that
 *   point (no lookahead).
 *
 * Entry/Exit (5m bars):
 *   Entry: next 5m bar's open after detection.
 *   Direction: opposite the extension.
 *   SL: beyond the cascade-bar extreme + 0.5×ATR(14, 5m) buffer.
 *     For SHORT: SL = max(detection bar high, current bar high) + 0.5×ATR
 *     For LONG:  SL = min(detection bar low,  current bar low)  - 0.5×ATR
 *   TP: session VWAP at entry time. R-capped at 3R if too far.
 *   Time stop: 12 × 5m bars = 60 minutes.
 *
 * Universe: 23 prod symbols from Daily Breakout (already-cached 5m data).
 *
 * Sizing/costs/period: matches Daily Breakout convention.
 *
 * Run:
 *   cd backend && npx tsx src/scalper/runBacktest_vwapReversion.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  runLadderBacktest, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'
import { DEFAULT_BREAKOUT_SETUPS } from '../services/dailyBreakoutLiveScanner'
import { ema } from '../services/indicators'

// ---- Universe (23 prod symbols) ----------------------------------------
const UNIVERSE = DEFAULT_BREAKOUT_SETUPS

// ---- Time window --------------------------------------------------------
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

// ---- Sizing (mirrors Daily Breakout) -----------------------------------
const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const TARGET_MARGIN_PCT = 10
const MAX_CONCURRENT = 10

// ---- Detection & exit --------------------------------------------------
const Z_THRESHOLDS = [1.5, 2.0, 2.5]
const MIN_SESSION_BARS = 6           // require ≥30min of session before signaling
const R_CAP = 3
const ATR_PERIOD = 14
const ATR_BUFFER_MULT = 0.5
const TIME_STOP_BARS = 12            // 12 × 5m = 60min

// ---- ADX(1h) regime filter ---------------------------------------------
const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20         // skip trades when BTC ADX ≥ this (i.e. only trade in low-trend)

// ---- Cost model (realistic Bybit taker) --------------------------------
const TAKER_FEE = 0.00055
const TAKER_SLIP = 0.0007

// ===================== HELPERS ======================

function atr5m(candles5m: OHLCV[], period: number): number[] {
  const out: number[] = new Array(candles5m.length).fill(0)
  if (candles5m.length === 0) return out
  let prevClose = candles5m[0].close
  const trs: number[] = []
  for (let i = 0; i < candles5m.length; i++) {
    const c = candles5m[i]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    trs.push(tr)
    prevClose = c.close
    if (i < period) {
      out[i] = 0
    } else if (i === period) {
      const sum = trs.slice(0, period + 1).reduce((a, b) => a + b, 0)
      out[i] = sum / (period + 1)
    } else {
      out[i] = (out[i - 1] * period + tr) / (period + 1)
    }
  }
  return out
}

/**
 * Aggregate 5m candles into 1h candles (UTC-aligned hour buckets).
 */
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

/**
 * Compute ADX(period) value for each 1h candle (Wilder + EMA smoothing).
 * Returns array same length as `candles`, with leading values 0 until enough data.
 */
function adxSeries(candles: OHLCV[], period: number): number[] {
  const n = candles.length
  const out = new Array(n).fill(0)
  if (n < period * 2) return out
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
  for (let i = 0; i < n; i++) out[i] = adxEma[i] ?? 0
  return out
}

/**
 * Build a lookup function: given a 5m bar time, return BTC's most recent 1h ADX
 * value (using all 1h candles whose CLOSE time ≤ bar time — no lookahead).
 *
 * 1h bar at time T covers [T, T+1h). Its close is at T+1h.
 * So at a 5m bar with time `t5`, the latest fully-closed 1h candle has time
 * such that `time + 3600_000 ≤ t5`. We binary-search the last such index.
 */
function buildBtcAdxLookup(btc5m: OHLCV[]): (t5m: number) => number {
  const btc1h = aggregate5mTo1h(btc5m)
  const adxArr = adxSeries(btc1h, BTC_ADX_PERIOD)
  const closeTimes = btc1h.map(c => c.time + 3600_000) // when the bar closes

  return (t5m: number) => {
    // Find largest idx where closeTimes[idx] <= t5m
    let lo = 0, hi = closeTimes.length - 1, best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (closeTimes[mid] <= t5m) { best = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    if (best < 0) return 0
    return adxArr[best]
  }
}

// ===================== SIGNAL GENERATION ======================

interface ReversionSignal extends LadderSignal {
  symbol: string
  detectionBarTime: number
  z: number
  vwap: number
  sigma: number
}

interface DetectionCfg {
  zThreshold: number
  rCap: number
  atrBufferMult: number
  minSessionBars: number
}

/**
 * Walk 5m candles, maintain session VWAP and rolling Welford σ resetting at
 * each UTC midnight. Emit signals when |z| crosses threshold AND price has
 * already started reverting on the detection bar.
 */
function generateReversionSignals(
  symbol: string,
  candles5m: OHLCV[],
  btcAdxAt: (t: number) => number,
  detection: DetectionCfg,
): ReversionSignal[] {
  if (candles5m.length < ATR_PERIOD + 2) return []
  const atr = atr5m(candles5m, ATR_PERIOD)
  const signals: ReversionSignal[] = []

  // Session state (resets each UTC day)
  let sessionDay = -1
  let pvSum = 0           // sum of typical × volume
  let vSum = 0            // sum of volume
  let devSumSq = 0        // sum of (close - vwap_current)^2 weighted by 1 (simple stdev over closes vs vwap)
  let barCountInSession = 0

  for (let i = 1; i < candles5m.length - 1; i++) {
    const bar = candles5m[i]
    const utcDay = Math.floor(bar.time / 86_400_000)

    if (utcDay !== sessionDay) {
      // Reset session
      sessionDay = utcDay
      pvSum = 0
      vSum = 0
      devSumSq = 0
      barCountInSession = 0
    }

    const typical = (bar.high + bar.low + bar.close) / 3
    pvSum += typical * bar.volume
    vSum += bar.volume
    barCountInSession++
    if (vSum <= 0) continue
    const vwap = pvSum / vSum

    const dev = bar.close - vwap
    devSumSq += dev * dev
    if (barCountInSession < detection.minSessionBars) continue
    const sigma = Math.sqrt(devSumSq / barCountInSession)
    if (sigma <= 0) continue
    const z = dev / sigma

    // Threshold check
    if (Math.abs(z) < detection.zThreshold) continue

    // Exhaustion confirmation: bar closes back TOWARD vwap (closer than open).
    const distOpen = Math.abs(bar.open - vwap)
    const distClose = Math.abs(bar.close - vwap)
    if (distClose >= distOpen) continue

    // ADX regime filter — skip in trending markets
    const btcAdx = btcAdxAt(bar.time)
    if (btcAdx >= BTC_ADX_THRESHOLD) continue

    // Side: fade extension
    const side: 'BUY' | 'SELL' = z > 0 ? 'SELL' : 'BUY'

    // Entry: next 5m bar's open
    const entryBar = candles5m[i + 1]
    const entryPrice = entryBar.open

    // SL: beyond detection bar extreme + ATR buffer
    const atrNow = atr[i]
    if (atrNow <= 0) continue
    const slBuffer = detection.atrBufferMult * atrNow
    const sl = side === 'BUY' ? bar.low - slBuffer : bar.high + slBuffer
    const risk = Math.abs(entryPrice - sl)
    if (risk <= 0) continue

    // TP: VWAP, but only if in mean-reversion direction
    const vwapInDirection = side === 'BUY' ? vwap > entryPrice : vwap < entryPrice
    if (!vwapInDirection) continue

    // R-cap
    const rDistance = Math.abs(vwap - entryPrice) / risk
    const cappedR = Math.min(rDistance, detection.rCap)
    const tp = side === 'BUY' ? entryPrice + cappedR * risk : entryPrice - cappedR * risk

    // SL invariant: tp must be in trade direction beyond entry, sl on the other side
    if (side === 'BUY' && (tp <= entryPrice || sl >= entryPrice)) continue
    if (side === 'SELL' && (tp >= entryPrice || sl <= entryPrice)) continue

    signals.push({
      symbol,
      detectionBarTime: bar.time,
      side,
      entryTime: entryBar.time,
      entryPrice,
      sl,
      tpLadder: [tp],
      z,
      vwap,
      sigma,
      reason: `z=${z.toFixed(2)} vwap=${vwap.toFixed(4)} σ=${sigma.toFixed(4)}`,
    })
  }

  return signals
}

// ===================== BACKTEST RUNNER (per symbol) ======================

function runSymbol(
  symbol: string,
  candles5m: OHLCV[],
  btcAdxAt: (t: number) => number,
  detection: DetectionCfg,
): { signals: ReversionSignal[]; trades: LadderTrade[] } {
  const signals = generateReversionSignals(symbol, candles5m, btcAdxAt, detection)
  if (signals.length === 0) return { signals: [], trades: [] }

  const sigByTime = new Map<number, ReversionSignal>()
  for (const s of signals) sigByTime.set(s.entryTime, s)

  const ladderCfg: LadderConfig = {
    feesRoundTrip: TAKER_FEE * 2,
    slippagePerSide: TAKER_SLIP,
    splits: [1.0],
    exitMode: 'wick',
    trailing: false,
    maxHoldBars: TIME_STOP_BARS,
  }

  const result = runLadderBacktest(
    candles5m,
    (i: number) => {
      const c = candles5m[i]
      return sigByTime.get(c.time) ?? null
    },
    ladderCfg,
  )

  return { signals, trades: result.trades }
}

// ===================== EQUITY SIM ======================

function simulateEquity(
  perSymbolTrades: Map<string, LadderTrade[]>,
): { finalEquity: number; takenCount: number; skippedCount: number } {
  type FlatTrade = { symbol: string; trade: LadderTrade }
  const flat: FlatTrade[] = []
  for (const [sym, ts] of perSymbolTrades) for (const t of ts) flat.push({ symbol: sym, trade: t })
  flat.sort((a, b) => a.trade.entryTime - b.trade.entryTime)

  let equity = STARTING_DEPOSIT
  const open: Array<{ trade: LadderTrade; marginUsd: number }> = []
  let taken = 0, skipped = 0

  for (const ft of flat) {
    const t = ft.trade
    // Close completed positions
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].trade.exitTime <= t.entryTime) {
        const p = open[i]
        const pnlUsd = p.trade.pnlR * p.marginUsd * (RISK_PCT / TARGET_MARGIN_PCT)
        equity += pnlUsd
        open.splice(i, 1)
      }
    }

    if (open.length >= MAX_CONCURRENT) { skipped++; continue }

    const riskUsd = equity * (RISK_PCT / 100)
    const riskPerUnit = Math.abs(t.fillPrice - t.initialSL)
    if (riskPerUnit <= 0) { skipped++; continue }
    const qty = riskUsd / riskPerUnit
    const notional = qty * t.fillPrice
    const desiredMargin = equity * (TARGET_MARGIN_PCT / 100)
    if (notional / desiredMargin > 100) { skipped++; continue }
    open.push({ trade: t, marginUsd: desiredMargin })
    taken++
  }

  for (const p of open) {
    const pnlUsd = p.trade.pnlR * p.marginUsd * (RISK_PCT / TARGET_MARGIN_PCT)
    equity += pnlUsd
  }

  return { finalEquity: equity, takenCount: taken, skippedCount: skipped }
}

// ===================== METRICS ======================

function summarize(trades: LadderTrade[], label: string): string {
  if (trades.length === 0) return `${label}: 0 trades`
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0)
  const wins = trades.filter(t => t.pnlR > 0)
  const losses = trades.filter(t => t.pnlR <= 0)
  const wr = wins.length / trades.length * 100
  const avgR = totalR / trades.length
  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlR, 0) / wins.length : 0
  const avgLossR = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlR, 0) / losses.length : 0
  const slCount = trades.filter(t => t.exitReason === 'SL').length
  const ladderDone = trades.filter(t => t.exitReason === 'LADDER_DONE').length
  const timeStop = trades.filter(t => t.exitReason === 'MAX_HOLD').length

  let peak = 0, cum = 0, dd = 0
  for (const t of trades) {
    cum += t.pnlR
    if (cum > peak) peak = cum
    const curDd = peak - cum
    if (curDd > dd) dd = curDd
  }

  return [
    `${label}: ${trades.length} trades | Total R: ${totalR.toFixed(2)} | Avg R/tr: ${avgR.toFixed(3)} | WR: ${wr.toFixed(1)}% | DD: ${dd.toFixed(2)}R`,
    `        Avg win: ${avgWinR.toFixed(2)}R | Avg loss: ${avgLossR.toFixed(2)}R | Exits: SL=${slCount} TP=${ladderDone} TimeStop=${timeStop}`,
  ].join('\n')
}

function splitTrainTest(trades: LadderTrade[], cutoffTime: number): { train: LadderTrade[]; test: LadderTrade[] } {
  return {
    train: trades.filter(t => t.entryTime < cutoffTime),
    test: trades.filter(t => t.entryTime >= cutoffTime),
  }
}

// ===================== MAIN ======================

async function main() {
  console.log('=== VWAP Reversion (5m, session VWAP) — backtest ===')
  console.log(`Universe: ${UNIVERSE.length} symbols (Daily Breakout prod)`)
  console.log(`Period: ${MONTHS_BACK}mo | train ${(TRAIN_PCT * 100).toFixed(0)}% / test ${((1 - TRAIN_PCT) * 100).toFixed(0)}%`)
  console.log(`Sweep z-threshold: [${Z_THRESHOLDS.join(', ')}]`)
  console.log(`Filter: BTC 1h ADX(14) < ${BTC_ADX_THRESHOLD}`)
  console.log(`Exit: TP=session VWAP (capped at ${R_CAP}R), SL=extreme + ${ATR_BUFFER_MULT}×ATR, time stop ${TIME_STOP_BARS} × 5m bars (${TIME_STOP_BARS * 5}min)`)
  console.log(`Costs: taker ${(TAKER_FEE * 100).toFixed(3)}% × 2 + slip ${(TAKER_SLIP * 100).toFixed(3)}% × 2`)
  console.log('')

  // Load BTC for ADX
  console.log('[Load] BTCUSDT (for 1h ADX filter)...')
  const btc5m = await loadHistorical('BTCUSDT', '5m', MONTHS_BACK)
  const btcAdxAt = buildBtcAdxLookup(btc5m)
  console.log(`[Load] BTCUSDT: ${btc5m.length} bars`)

  // Load all symbols
  const data = new Map<string, OHLCV[]>()
  for (const sym of UNIVERSE) {
    const c5m = await loadHistorical(sym, '5m', MONTHS_BACK)
    data.set(sym, c5m)
    console.log(`[Load] ${sym}: ${c5m.length} bars`)
  }

  // Determine TRAIN/TEST cutoff
  const allTimes: number[] = []
  for (const c of data.values()) if (c.length > 0) {
    allTimes.push(c[0].time, c[c.length - 1].time)
  }
  const dataStart = Math.min(...allTimes)
  const dataEnd = Math.max(...allTimes)
  const cutoff = dataStart + (dataEnd - dataStart) * TRAIN_PCT
  console.log(`\nData span: ${new Date(dataStart).toISOString().slice(0, 10)} → ${new Date(dataEnd).toISOString().slice(0, 10)}`)
  console.log(`Train/test cutoff: ${new Date(cutoff).toISOString().slice(0, 10)}\n`)

  // Sweep z-threshold
  const allResults: any[] = []
  for (const z of Z_THRESHOLDS) {
    console.log(`\n========== Z = ${z} ==========`)
    const detectionCfg: DetectionCfg = {
      zThreshold: z,
      rCap: R_CAP,
      atrBufferMult: ATR_BUFFER_MULT,
      minSessionBars: MIN_SESSION_BARS,
    }

    const perSymbolTrades = new Map<string, LadderTrade[]>()
    const perSymbolSignals = new Map<string, number>()

    for (const sym of UNIVERSE) {
      const c5m = data.get(sym)!
      if (c5m.length === 0) continue
      const { signals, trades } = runSymbol(sym, c5m, btcAdxAt, detectionCfg)
      perSymbolTrades.set(sym, trades)
      perSymbolSignals.set(sym, signals.length)
    }

    const allTrades: LadderTrade[] = []
    for (const ts of perSymbolTrades.values()) allTrades.push(...ts)
    allTrades.sort((a, b) => a.entryTime - b.entryTime)

    const { train, test } = splitTrainTest(allTrades, cutoff)

    console.log(summarize(allTrades, 'FULL'))
    console.log(summarize(train, 'TRAIN'))
    console.log(summarize(test, 'TEST'))

    // Equity sim
    const eq = simulateEquity(perSymbolTrades)
    console.log(`\nEquity: $${STARTING_DEPOSIT} → $${eq.finalEquity.toFixed(2)} (${((eq.finalEquity / STARTING_DEPOSIT - 1) * 100).toFixed(1)}%) | Taken: ${eq.takenCount} | Skipped: ${eq.skippedCount}`)

    allResults.push({
      z,
      totalCount: allTrades.length,
      trainCount: train.length,
      testCount: test.length,
      fullR: allTrades.reduce((s, t) => s + t.pnlR, 0),
      trainR: train.reduce((s, t) => s + t.pnlR, 0),
      testR: test.reduce((s, t) => s + t.pnlR, 0),
      fullAvgR: allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.pnlR, 0) / allTrades.length : 0,
      testAvgR: test.length > 0 ? test.reduce((s, t) => s + t.pnlR, 0) / test.length : 0,
      finalEquity: eq.finalEquity,
    })
  }

  // Summary table
  console.log('\n\n========== SWEEP SUMMARY ==========')
  console.log('Z      Trades  FullR    AvgR    TestN   TestR   TestAvgR  FinalEq')
  for (const r of allResults) {
    console.log(`${r.z.toFixed(1)}    ${String(r.totalCount).padStart(5)}   ${r.fullR.toFixed(1).padStart(6)}   ${r.fullAvgR.toFixed(3).padStart(6)}  ${String(r.testCount).padStart(5)}   ${r.testR.toFixed(1).padStart(5)}   ${r.testAvgR.toFixed(3).padStart(7)}  $${r.finalEquity.toFixed(0)}`)
  }

  // Save raw
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `vwapReversion_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    config: {
      universe: UNIVERSE, monthsBack: MONTHS_BACK, trainPct: TRAIN_PCT,
      zThresholds: Z_THRESHOLDS, btcAdxThreshold: BTC_ADX_THRESHOLD,
      rCap: R_CAP, atrBufferMult: ATR_BUFFER_MULT, timeStopBars: TIME_STOP_BARS,
      takerFee: TAKER_FEE, takerSlip: TAKER_SLIP,
      starting: STARTING_DEPOSIT, riskPct: RISK_PCT, targetMargin: TARGET_MARGIN_PCT, maxConc: MAX_CONCURRENT,
    },
    results: allResults,
  }, null, 2))
  console.log(`\nSaved: ${outFile}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
