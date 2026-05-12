/**
 * Liquidation Cascade Fade — synthetic-data backtest.
 *
 * Hypothesis:
 *   Massive forced liquidations create exhaustion. After OI drops sharply along
 *   with a violent price move in the same direction, price tends to mean-revert
 *   toward the pre-cascade "fair value" (proxied here by VWAP of the previous
 *   30 minutes). Edge is short-horizon (minutes to ~1 hour).
 *
 * Synthetic detection (no real liquidation feed — Bybit's `liquidation` WS is
 * not historically queryable):
 *   At each 5min OI snapshot, look at:
 *     deltaOI    = (oi_t - oi_{t-1}) / oi_{t-1}
 *     priceMove  = (close - open) on the matching 5m bar / open
 *   LONG liquidation cascade (we fade with LONG entry):
 *     deltaOI <= -DELTA_OI_THRESHOLD AND priceMove <= -PRICE_MOVE_THRESHOLD
 *     (OI dropping + violent down move = longs being closed against their will)
 *   SHORT liquidation cascade (we fade with SHORT entry):
 *     deltaOI <= -DELTA_OI_THRESHOLD AND priceMove >= +PRICE_MOVE_THRESHOLD
 *     (OI dropping + violent up move = shorts being squeezed out)
 *   Magnitude (USD-ish notional):
 *     |deltaOI in coins| × close_price ≥ MIN_NOTIONAL_USD
 *
 * Confirmation:
 *   Wick reversal inside the cascade 5m bar — the bar's close should have already
 *   retraced ≥50% of the way back from the extreme wick. This filters out bars
 *   that are still in active cascade (we want exhaustion, not chasing).
 *
 * Entry/Exit (executed on 5m bars — same timeframe as detection and OI):
 *   Entry: 5m bar immediately AFTER the cascade 5m bar closes, at open.
 *   Direction: opposite the cascade.
 *   SL: beyond the cascade-bar wick + 0.5×ATR(14, 5m) buffer.
 *   TP ladder (single TP, no laddering — pure mean-reversion targets one level):
 *     Primary TP: pre-cascade 30min VWAP (computed over the 30min = 6×5m bars
 *     ending at the 5m bar BEFORE the cascade — does not "see" cascade bar).
 *     R-cap: if VWAP gives > 3R reward, cap TP at entry ± 3R.
 *   Time stop: 12 × 5m bars (60 minutes).
 *   Slippage/fees: realistic Bybit taker model — 0.055% fee + 0.07% slip per
 *     taker fill, both entry and exit (no maker exit — we exit at TP/SL/time
 *     stop, all of which are taker-equivalent).
 *
 * Universe (top-10 by liquidation activity intuition + your existing Daily
 * Breakout universe overlap):
 *   BTC ETH SOL DOGE XRP BNB ADA AVAX LINK 1000PEPE
 *
 * Sizing: matches Daily Breakout — risk-based, $500 starting deposit, 2% risk
 *   per trade, 10 max concurrent positions, 10% target margin/skip-only margin
 *   guard. P&L reported both in R and in equity ($).
 *
 * Period: 14 months back, 60-40 TRAIN/TEST split (your standard from
 *   feedback_no_overfitting_filters.md).
 *
 * Run:
 *   cd backend && npx tsx src/scalper/runBacktest_liquidationCascade.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { loadOIHistory, OISnapshot } from './oiLoader'
import {
  runLadderBacktest, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

// ---- Universe -----------------------------------------------------------
const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', '1000PEPEUSDT']

// ---- Time window --------------------------------------------------------
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

// ---- Sizing (mirrors Daily Breakout variant A) -------------------------
const STARTING_DEPOSIT = 500
const RISK_PCT = 2
const TARGET_MARGIN_PCT = 10
const MAX_CONCURRENT = 10

// ---- Detection thresholds (sweep candidates) ---------------------------
// Default config we'll report as the "primary" run. Sweep optionals declared
// further below.
const DELTA_OI_THRESHOLD = 0.02     // 2% OI drop in 5min
const PRICE_MOVE_THRESHOLD = 0.01   // 1% adverse price move in same 5min
const MIN_NOTIONAL_USD = 5_000_000  // $5M of forced flow
const WICK_RETRACE_MIN = 0.5        // close already retraced ≥50% of the wick
const ATR_PERIOD = 14
const ATR_BUFFER_MULT = 0.5         // SL = wick + 0.5×ATR

// ---- Exit ----------------------------------------------------------------
const R_CAP = 3                     // TP capped at 3R if VWAP-target exceeds
const VWAP_LOOKBACK_MIN = 30        // 30min pre-cascade VWAP target (6 × 5m bars)
const TIME_STOP_BARS = 12           // 12 × 5m bars = 60min

// ---- Cost model (realistic Bybit taker for both legs) ------------------
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
 * 30min VWAP ending at `endTime` (exclusive — VWAP does NOT include `endTime` bar).
 * Uses 5m candles. With 30min lookback that's 6 bars. Returns NaN if not enough data.
 */
function vwap30m(candles5m: OHLCV[], endTime: number, lookbackMin: number): number {
  const startTime = endTime - lookbackMin * 60_000
  let pvSum = 0
  let vSum = 0
  for (let i = candles5m.length - 1; i >= 0; i--) {
    const c = candles5m[i]
    if (c.time >= endTime) continue
    if (c.time < startTime) break
    const typical = (c.high + c.low + c.close) / 3
    pvSum += typical * c.volume
    vSum += c.volume
  }
  if (vSum <= 0) return NaN
  return pvSum / vSum
}

// ===================== SIGNAL GENERATION ======================

interface CascadeSignal extends LadderSignal {
  symbol: string
  cascadeBarTime: number
  deltaOI: number
  priceMove: number
  notionalUsd: number
  vwapTarget: number
  rDistance: number
}

interface DetectionCfg {
  deltaOiThreshold: number
  priceMoveThreshold: number
  minNotionalUsd: number
  wickRetraceMin: number
  rCap: number
  vwapLookbackMin: number
  atrBufferMult: number
}

const DEFAULT_DETECTION: DetectionCfg = {
  deltaOiThreshold: DELTA_OI_THRESHOLD,
  priceMoveThreshold: PRICE_MOVE_THRESHOLD,
  minNotionalUsd: MIN_NOTIONAL_USD,
  wickRetraceMin: WICK_RETRACE_MIN,
  rCap: R_CAP,
  vwapLookbackMin: VWAP_LOOKBACK_MIN,
  atrBufferMult: ATR_BUFFER_MULT,
}

/**
 * Scan 5m + OI snapshots for cascade events, produce signals keyed to the 5m
 * bar where entry executes (the bar AFTER the cascade bar closes).
 */
function generateCascadeSignals(
  symbol: string,
  candles5m: OHLCV[],
  oi: OISnapshot[],
  detection: DetectionCfg,
): CascadeSignal[] {
  if (candles5m.length < ATR_PERIOD + 2 || oi.length < 2) return []

  // Build OI index by time for O(1) lookup
  const oiByTime = new Map<number, number>()
  for (const s of oi) oiByTime.set(s.time, s.openInterest)

  const atr = atr5m(candles5m, ATR_PERIOD)
  const signals: CascadeSignal[] = []

  for (let i = ATR_PERIOD + 1; i < candles5m.length - 1; i++) {
    const bar = candles5m[i]
    const oiNow = oiByTime.get(bar.time)
    const oiPrev = oiByTime.get(candles5m[i - 1].time)
    if (oiNow === undefined || oiPrev === undefined || oiPrev <= 0) continue

    const deltaOI = (oiNow - oiPrev) / oiPrev
    const priceMove = (bar.close - bar.open) / bar.open

    // Need OI to be dropping AND price to be moving violently
    if (deltaOI > -detection.deltaOiThreshold) continue
    const violentDown = priceMove <= -detection.priceMoveThreshold
    const violentUp = priceMove >= detection.priceMoveThreshold
    if (!violentDown && !violentUp) continue

    // Magnitude filter (USD-ish notional of forced flow)
    const notionalUsd = Math.abs(oiNow - oiPrev) * bar.close
    if (notionalUsd < detection.minNotionalUsd) continue

    // Wick reversal filter — already-exhausted candle, not still-cascading
    let wickRetrace: number
    if (violentDown) {
      // For a down-cascade, the wick is the low. Retrace = (close - low) / (open - low)
      const extreme = bar.low
      const span = bar.open - extreme
      if (span <= 0) continue
      wickRetrace = (bar.close - extreme) / span
    } else {
      const extreme = bar.high
      const span = extreme - bar.open
      if (span <= 0) continue
      wickRetrace = (extreme - bar.close) / span
    }
    if (wickRetrace < detection.wickRetraceMin) continue

    // Entry = next 5m bar's open
    const entryBar = candles5m[i + 1]
    const entryPrice = entryBar.open

    // VWAP target = pre-cascade fair value (does not include cascade bar)
    const vwap = vwap30m(candles5m, bar.time, detection.vwapLookbackMin)
    if (!isFinite(vwap)) continue

    // Side: fade the cascade
    const side: 'BUY' | 'SELL' = violentDown ? 'BUY' : 'SELL'

    // SL = beyond the cascade-bar wick + ATR buffer
    const atrNow = atr[i]
    if (atrNow <= 0) continue
    const slBuffer = detection.atrBufferMult * atrNow
    const sl = side === 'BUY' ? bar.low - slBuffer : bar.high + slBuffer

    const risk = Math.abs(entryPrice - sl)
    if (risk <= 0) continue

    // VWAP must be in the right direction (mean-reversion target)
    const vwapInDirection = side === 'BUY' ? vwap > entryPrice : vwap < entryPrice
    if (!vwapInDirection) continue

    // R-cap the TP
    const rDistance = Math.abs(vwap - entryPrice) / risk
    const cappedR = Math.min(rDistance, detection.rCap)
    const tp = side === 'BUY' ? entryPrice + cappedR * risk : entryPrice - cappedR * risk

    signals.push({
      symbol,
      cascadeBarTime: bar.time,
      side,
      entryTime: entryBar.time,
      entryPrice,
      sl,
      tpLadder: [tp],
      deltaOI,
      priceMove,
      notionalUsd,
      vwapTarget: vwap,
      rDistance,
      reason: `cascade dOI=${(deltaOI * 100).toFixed(2)}% px=${(priceMove * 100).toFixed(2)}% notional=$${(notionalUsd / 1e6).toFixed(1)}M`,
    })
  }

  return signals
}

// ===================== BACKTEST RUNNER (per symbol) ======================

function runSymbol(
  symbol: string,
  candles5m: OHLCV[],
  oi: OISnapshot[],
  detection: DetectionCfg,
): { signals: CascadeSignal[]; trades: LadderTrade[] } {
  const signals = generateCascadeSignals(symbol, candles5m, oi, detection)
  if (signals.length === 0) return { signals: [], trades: [] }

  // Build sigByTime for the generator
  const sigByTime = new Map<number, CascadeSignal>()
  for (const s of signals) sigByTime.set(s.entryTime, s)

  const ladderCfg: LadderConfig = {
    feesRoundTrip: TAKER_FEE * 2,         // both legs taker
    slippagePerSide: TAKER_SLIP,
    splits: [1.0],                        // 100% on single TP
    exitMode: 'wick',
    trailing: false,                      // no trailing — single TP
    maxHoldBars: TIME_STOP_BARS,          // 12 × 5m bars = 60min time stop
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

interface EquityPos {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tp: number
  marginUsd: number
  qty: number  // contracts in coin units
  closed: boolean
}

interface EquityEvent {
  time: number
  type: 'OPEN' | 'CLOSE'
  symbol: string
  pnlUsd: number
  feesUsd: number
  equityAfter: number
  reason: string
}

/**
 * Sequence all trades across symbols by time, simulate $-equity with risk-based
 * sizing + max-concurrent cap. Skips signals when concurrent slots are full or
 * margin requirement exceeds 10% × equity per slot.
 */
function simulateEquity(
  perSymbolTrades: Map<string, LadderTrade[]>,
): { finalEquity: number; events: EquityEvent[]; takenCount: number; skippedCount: number } {
  // Flatten all trades into ordered event stream keyed by entry+exit times
  type FlatTrade = { symbol: string; trade: LadderTrade }
  const flat: FlatTrade[] = []
  for (const [sym, ts] of perSymbolTrades) for (const t of ts) flat.push({ symbol: sym, trade: t })

  flat.sort((a, b) => a.trade.entryTime - b.trade.entryTime)

  let equity = STARTING_DEPOSIT
  const open: EquityPos[] = []
  const events: EquityEvent[] = []
  let taken = 0
  let skipped = 0

  for (const ft of flat) {
    const t = ft.trade
    // First, close any positions that ended before this entry
    while (open.length > 0) {
      const earliest = open.reduce((min, p) => p.entryTime < min.entryTime ? p : min, open[0])
      // We can't actually close arbitrarily — match by symbol+entryTime later
      break
    }
    // Realistic approach: walk through `open` and close those whose exitTime <= t.entryTime
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i]
      // we'll need exitTime — stored back in original trade. Look up matching trade.
      // Simplification: tag each open with its source trade so we can read exitTime directly.
      const src = (p as any).__src as LadderTrade
      if (src.exitTime <= t.entryTime) {
        // Close it
        const pnlR = src.pnlR
        const pnlUsd = pnlR * p.marginUsd * (RISK_PCT / TARGET_MARGIN_PCT)
        equity += pnlUsd
        events.push({
          time: src.exitTime,
          type: 'CLOSE',
          symbol: p.symbol,
          pnlUsd,
          feesUsd: 0, // fees already accounted in pnlR via cost model
          equityAfter: equity,
          reason: src.exitReason,
        })
        open.splice(i, 1)
      }
    }

    // Cap: max concurrent
    if (open.length >= MAX_CONCURRENT) {
      skipped++
      continue
    }

    // Risk-based sizing: risk RISK_PCT% of equity per trade
    const riskUsd = equity * (RISK_PCT / 100)
    const riskPerUnit = Math.abs(t.fillPrice - t.initialSL)
    if (riskPerUnit <= 0) {
      skipped++
      continue
    }
    const qty = riskUsd / riskPerUnit
    const notional = qty * t.fillPrice
    // Margin guard: target TARGET_MARGIN_PCT margin, so leverage = notional / margin = notional / (equity × target_margin_pct/100)
    const desiredMargin = equity * (TARGET_MARGIN_PCT / 100)
    if (notional / desiredMargin > 100) {
      // Required leverage > 100x — skip (Bybit usually caps at 50-75x on alts)
      skipped++
      continue
    }
    const marginUsd = desiredMargin

    const pos: EquityPos & { __src?: LadderTrade } = {
      symbol: ft.symbol,
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      sl: t.initialSL,
      tp: 0, // single tp — pnl will be calculated from R directly
      marginUsd,
      qty,
      closed: false,
    }
    ;(pos as any).__src = t
    open.push(pos)
    taken++
    events.push({
      time: t.entryTime,
      type: 'OPEN',
      symbol: ft.symbol,
      pnlUsd: 0,
      feesUsd: 0,
      equityAfter: equity,
      reason: t.side,
    })
  }

  // Close any still-open positions at final
  for (const p of open) {
    const src = (p as any).__src as LadderTrade
    const pnlR = src.pnlR
    const pnlUsd = pnlR * p.marginUsd * (RISK_PCT / TARGET_MARGIN_PCT)
    equity += pnlUsd
    events.push({
      time: src.exitTime,
      type: 'CLOSE',
      symbol: p.symbol,
      pnlUsd,
      feesUsd: 0,
      equityAfter: equity,
      reason: src.exitReason,
    })
  }

  return { finalEquity: equity, events, takenCount: taken, skippedCount: skipped }
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

  // Max DD in R
  let peak = 0, cum = 0, dd = 0
  for (const t of trades) {
    cum += t.pnlR
    if (cum > peak) peak = cum
    const curDd = peak - cum
    if (curDd > dd) dd = curDd
  }

  return [
    `${label}: ${trades.length} trades`,
    `  Total R: ${totalR.toFixed(2)} | Avg R/tr: ${avgR.toFixed(3)} | WR: ${wr.toFixed(1)}%`,
    `  Avg win: ${avgWinR.toFixed(2)}R | Avg loss: ${avgLossR.toFixed(2)}R`,
    `  Exits: SL=${slCount} TP=${ladderDone} TimeStop=${timeStop}`,
    `  Max DD (R): ${dd.toFixed(2)}`,
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
  console.log('=== Liquidation Cascade Fade — backtest ===')
  console.log(`Universe: ${UNIVERSE.join(' ')}`)
  console.log(`Period: ${MONTHS_BACK} months back, train ${(TRAIN_PCT * 100).toFixed(0)}% / test ${((1 - TRAIN_PCT) * 100).toFixed(0)}%`)
  console.log(`Detection: ΔOI≤-${(DELTA_OI_THRESHOLD * 100).toFixed(1)}%, |px|≥${(PRICE_MOVE_THRESHOLD * 100).toFixed(1)}%, notional≥$${(MIN_NOTIONAL_USD / 1e6).toFixed(0)}M, wickRetrace≥${(WICK_RETRACE_MIN * 100).toFixed(0)}%`)
  console.log(`Exit: VWAP(${VWAP_LOOKBACK_MIN}min pre-cascade) capped at ${R_CAP}R, time stop ${TIME_STOP_BARS} × 5m bars (${TIME_STOP_BARS * 5}min)`)
  console.log(`Costs: taker ${(TAKER_FEE * 100).toFixed(3)}% × 2 + slip ${(TAKER_SLIP * 100).toFixed(3)}% × 2`)
  console.log('')

  // Load all data first (5m candles for entry/exit + OI for cascade detection)
  const data = new Map<string, { c5m: OHLCV[]; oi: OISnapshot[] }>()
  for (const sym of UNIVERSE) {
    console.log(`[Load] ${sym} ...`)
    const c5m = await loadHistorical(sym, '5m', MONTHS_BACK)
    const oi = await loadOIHistory(sym, '5min', MONTHS_BACK)
    console.log(`[Load] ${sym}: 5m=${c5m.length} oi=${oi.length}`)
    data.set(sym, { c5m, oi })
  }

  // Determine TRAIN/TEST cutoff based on data span
  const allTimes: number[] = []
  for (const d of data.values()) if (d.c5m.length > 0) {
    allTimes.push(d.c5m[0].time, d.c5m[d.c5m.length - 1].time)
  }
  const dataStart = Math.min(...allTimes)
  const dataEnd = Math.max(...allTimes)
  const cutoff = dataStart + (dataEnd - dataStart) * TRAIN_PCT
  console.log(`\nData span: ${new Date(dataStart).toISOString().slice(0, 10)} → ${new Date(dataEnd).toISOString().slice(0, 10)}`)
  console.log(`Train/test cutoff: ${new Date(cutoff).toISOString().slice(0, 10)}\n`)

  // Run per-symbol
  const perSymbolTrades = new Map<string, LadderTrade[]>()
  const perSymbolSignals = new Map<string, CascadeSignal[]>()

  for (const sym of UNIVERSE) {
    const d = data.get(sym)!
    if (d.c5m.length === 0 || d.oi.length === 0) {
      console.log(`[Run] ${sym}: SKIP (insufficient data)`)
      continue
    }
    const { signals, trades } = runSymbol(sym, d.c5m, d.oi, DEFAULT_DETECTION)
    perSymbolTrades.set(sym, trades)
    perSymbolSignals.set(sym, signals)
    console.log(`[Run] ${sym}: ${signals.length} signals, ${trades.length} trades, totalR=${trades.reduce((s, t) => s + t.pnlR, 0).toFixed(2)}`)
  }

  // Aggregate
  const allTrades: LadderTrade[] = []
  for (const ts of perSymbolTrades.values()) allTrades.push(...ts)
  allTrades.sort((a, b) => a.entryTime - b.entryTime)

  const { train, test } = splitTrainTest(allTrades, cutoff)

  console.log('\n========== R-METRICS ==========')
  console.log(summarize(allTrades, 'FULL'))
  console.log('')
  console.log(summarize(train, 'TRAIN'))
  console.log('')
  console.log(summarize(test, 'TEST'))

  // Per-symbol breakdown
  console.log('\n========== PER-SYMBOL ==========')
  for (const sym of UNIVERSE) {
    const ts = perSymbolTrades.get(sym) ?? []
    if (ts.length === 0) {
      console.log(`${sym}: 0 trades`)
      continue
    }
    const totalR = ts.reduce((s, t) => s + t.pnlR, 0)
    const wr = ts.filter(t => t.pnlR > 0).length / ts.length * 100
    console.log(`${sym}: ${ts.length} trades | totalR=${totalR.toFixed(2)} | avgR=${(totalR / ts.length).toFixed(3)} | WR=${wr.toFixed(0)}%`)
  }

  // Equity sim
  console.log('\n========== EQUITY SIM ==========')
  const eq = simulateEquity(perSymbolTrades)
  console.log(`Starting deposit: $${STARTING_DEPOSIT}`)
  console.log(`Final equity:     $${eq.finalEquity.toFixed(2)}`)
  console.log(`Total return:     ${((eq.finalEquity / STARTING_DEPOSIT - 1) * 100).toFixed(1)}%`)
  console.log(`Taken: ${eq.takenCount} | Skipped (slot/leverage): ${eq.skippedCount}`)

  // Save raw results
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `liqCascade_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    config: {
      universe: UNIVERSE, monthsBack: MONTHS_BACK, trainPct: TRAIN_PCT,
      starting: STARTING_DEPOSIT, riskPct: RISK_PCT, targetMargin: TARGET_MARGIN_PCT, maxConc: MAX_CONCURRENT,
      detection: DEFAULT_DETECTION, timeStopBars: TIME_STOP_BARS,
      takerFee: TAKER_FEE, takerSlip: TAKER_SLIP,
    },
    perSymbolStats: Array.from(perSymbolTrades.entries()).map(([sym, ts]) => ({
      symbol: sym,
      trades: ts.length,
      totalR: ts.reduce((s, t) => s + t.pnlR, 0),
      signals: perSymbolSignals.get(sym)?.length ?? 0,
    })),
    fullR: allTrades.reduce((s, t) => s + t.pnlR, 0),
    trainR: train.reduce((s, t) => s + t.pnlR, 0),
    testR: test.reduce((s, t) => s + t.pnlR, 0),
    finalEquity: eq.finalEquity,
    trainCount: train.length, testCount: test.length, totalCount: allTrades.length,
  }, null, 2))
  console.log(`\nSaved: ${outFile}`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
