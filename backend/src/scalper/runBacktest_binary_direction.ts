/**
 * Binary Options Direction Prediction — backtest.
 *
 * Цель: проверить есть ли edge на предсказании направления цены через N минут
 * (формат бинарных опционов на Pocket Option и аналогах).
 *
 * Стратегии:
 *   1. Momentum  — RSI extreme + EMA filter
 *   2. MeanRev   — Bollinger Band touch (fade)
 *   3. Breakout  — Donchian mini-range (N-bar high/low) break
 *   4. Combo     — Momentum + ADX regime filter (тренд >=20)
 *
 * Horizons: 1, 5, 15 минут (bars-ahead зависит от TF: на 1m TF = 1/5/15 баров,
 *           на 5m TF = 1/3 баров для 5min/15min — 1min пропускаем).
 *
 * Метрика edge:
 *   - payout = 80% (типичный PO; некоторые пары 85-92%, считаем conservatively)
 *   - break-even win-rate = 1 / (1 + 0.80) = 55.56%
 *   - EV per trade = winRate * 0.80 - (1 - winRate) * 1.00
 *     (т.е. при ставке $1: выигрыш +$0.80, проигрыш -$1.00)
 *   - Edge есть если winRate > 55.6% И EV > 0 НА TEST (не только TRAIN)
 *
 * Walk-forward: TRAIN 4 мес / TEST 2 мес (всего 6 мес истории).
 *
 * Run:
 *   cd backend && npx tsx src/scalper/runBacktest_binary_direction.ts
 */

import { loadHistorical } from './historicalLoader'
import { ema, rsi as rsiOnce, sma } from '../services/indicators'
import { OHLCV } from '../services/market'

// ============================================================================
// Config
// ============================================================================

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT']
const TIMEFRAMES: Array<{ tf: string; horizonsBars: { label: string; bars: number }[] }> = [
  {
    tf: '1m',
    horizonsBars: [
      { label: '1m',  bars: 1 },
      { label: '5m',  bars: 5 },
      { label: '15m', bars: 15 },
    ],
  },
  {
    tf: '5m',
    horizonsBars: [
      { label: '5m',  bars: 1 },
      { label: '15m', bars: 3 },
    ],
  },
]
const MONTHS_BACK = 6
const TRAIN_MONTHS = 4
const PAYOUT = 0.80           // PO ~80% (conservative)
const BREAK_EVEN_WR = 1 / (1 + PAYOUT)  // = 0.5556

type Direction = 'CALL' | 'PUT'   // CALL = price up, PUT = price down

interface Signal {
  i: number             // bar index where signal fires (entry = close of this bar)
  direction: Direction
  strategy: string
}

interface BacktestResult {
  symbol: string
  tf: string
  strategy: string
  horizonLabel: string
  trades: number
  wins: number
  losses: number
  ties: number          // price EXACTLY equal at horizon
  winRate: number       // wins / (wins + losses), excluding ties
  evPerTrade: number    // expected payout per $1 stake
}

// ============================================================================
// Incremental RSI (Wilder) so we don't recompute over full series each bar
// ============================================================================

function rollingRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return out

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1]
    if (ch >= 0) avgGain += ch
    else avgLoss += -ch
  }
  avgGain /= period
  avgLoss /= period

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1]
    const gain = ch >= 0 ? ch : 0
    const loss = ch < 0 ? -ch : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs)
  }
  return out
}

// Rolling Bollinger Bands (20 SMA ± 2*stddev)
function rollingBB(closes: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  const middle: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]
    const mean = sum / period
    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - mean) ** 2
    const std = Math.sqrt(sqSum / period)
    middle[i] = mean
    upper[i] = mean + mult * std
    lower[i] = mean - mult * std
  }
  return { upper, lower, middle }
}

// Rolling ADX (Wilder, period 14) — для regime filter в Combo
function rollingADX(candles: OHLCV[], period = 14): (number | null)[] {
  const n = candles.length
  const adxOut: (number | null)[] = new Array(n).fill(null)
  if (n < period * 2) return adxOut

  const tr: number[] = [0]
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const p = candles[i - 1]
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
    const up = c.high - p.high
    const dn = p.low - c.low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
  }

  let smTR = 0
  let smP = 0
  let smM = 0
  for (let i = 1; i <= period; i++) {
    smTR += tr[i]
    smP += plusDM[i]
    smM += minusDM[i]
  }

  const dx: number[] = []
  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + tr[i]
    smP = smP - smP / period + plusDM[i]
    smM = smM - smM / period + minusDM[i]
    const pdi = smTR === 0 ? 0 : (smP / smTR) * 100
    const mdi = smTR === 0 ? 0 : (smM / smTR) * 100
    const sum = pdi + mdi
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100)

    if (dx.length === period) {
      const seed = dx.slice(0, period).reduce((a, b) => a + b, 0) / period
      adxOut[i] = seed
    } else if (dx.length > period) {
      const prev = adxOut[i - 1] ?? 25
      adxOut[i] = (prev * (period - 1) + dx[dx.length - 1]) / period
    }
  }
  return adxOut
}

// Rolling EMA — already vectorized in indicators.ts (returns full array)
function rollingEMA(values: number[], period: number) {
  return ema(values, period)
}

// ============================================================================
// Strategy: generate signals over a candle range [iStart, iEnd)
// ============================================================================

interface Series {
  closes: number[]
  highs: number[]
  lows: number[]
  rsi14: (number | null)[]
  ema20: number[]
  ema50: number[]
  bbU: (number | null)[]
  bbL: (number | null)[]
  adx14: (number | null)[]
}

function buildSeries(candles: OHLCV[]): Series {
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const r = rollingRSI(closes, 14)
  const e20 = rollingEMA(closes, 20)
  const e50 = rollingEMA(closes, 50)
  const bb = rollingBB(closes, 20, 2)
  const adx = rollingADX(candles, 14)
  return { closes, highs, lows, rsi14: r, ema20: e20, ema50: e50, bbU: bb.upper, bbL: bb.lower, adx14: adx }
}

// Strategy 1: Momentum — RSI crosses out of extreme + EMA20 confirms direction
//   CALL: rsi crosses up through 30 AND close > ema20
//   PUT:  rsi crosses down through 70 AND close < ema20
function sigMomentum(s: Series, i: number): Direction | null {
  const r = s.rsi14[i]
  const rPrev = s.rsi14[i - 1]
  if (r == null || rPrev == null) return null
  const c = s.closes[i]
  const e = s.ema20[i]
  if (rPrev < 30 && r >= 30 && c > e) return 'CALL'
  if (rPrev > 70 && r <= 70 && c < e) return 'PUT'
  return null
}

// Strategy 2: Mean Reversion — close touches/exceeds BB and reverses next bar's expectation
//   CALL: close <= bbLower
//   PUT:  close >= bbUpper
function sigMeanRev(s: Series, i: number): Direction | null {
  const u = s.bbU[i]
  const l = s.bbL[i]
  if (u == null || l == null) return null
  const c = s.closes[i]
  if (c <= l) return 'CALL'
  if (c >= u) return 'PUT'
  return null
}

// Strategy 3: Breakout — close breaks above N-bar high (CALL) or below N-bar low (PUT)
//   Use 20-bar Donchian (excluding current bar)
function sigBreakout(s: Series, i: number): Direction | null {
  const lookback = 20
  if (i < lookback) return null
  let hh = -Infinity
  let ll = Infinity
  for (let k = i - lookback; k < i; k++) {
    if (s.highs[k] > hh) hh = s.highs[k]
    if (s.lows[k] < ll) ll = s.lows[k]
  }
  const c = s.closes[i]
  if (c > hh) return 'CALL'
  if (c < ll) return 'PUT'
  return null
}

// Strategy 4: Combo — Momentum, но только если ADX >=20 (trending regime)
function sigCombo(s: Series, i: number): Direction | null {
  const adx = s.adx14[i]
  if (adx == null || adx < 20) return null
  return sigMomentum(s, i)
}

const STRATEGIES: Array<{ name: string; fn: (s: Series, i: number) => Direction | null }> = [
  { name: 'Momentum', fn: sigMomentum },
  { name: 'MeanRev',  fn: sigMeanRev },
  { name: 'Breakout', fn: sigBreakout },
  { name: 'Combo',    fn: sigCombo },
]

// ============================================================================
// Evaluate signals over a candle slice
// ============================================================================

function evaluate(
  candles: OHLCV[],
  series: Series,
  iStart: number,
  iEnd: number,                  // exclusive — we need iEnd + maxHorizonBars available
  horizonBars: number,
  stratFn: (s: Series, i: number) => Direction | null,
): { trades: number; wins: number; losses: number; ties: number } {
  let trades = 0
  let wins = 0
  let losses = 0
  let ties = 0
  for (let i = iStart; i < iEnd; i++) {
    const dir = stratFn(series, i)
    if (!dir) continue
    const j = i + horizonBars
    if (j >= candles.length) break
    const entry = candles[i].close
    const expiry = candles[j].close
    trades++
    if (expiry === entry) {
      ties++
      continue
    }
    const movedUp = expiry > entry
    const win = (dir === 'CALL' && movedUp) || (dir === 'PUT' && !movedUp)
    if (win) wins++
    else losses++
  }
  return { trades, wins, losses, ties }
}

function winRate(wins: number, losses: number): number {
  const tot = wins + losses
  return tot === 0 ? 0 : wins / tot
}

function ev(wr: number, payout = PAYOUT): number {
  return wr * payout - (1 - wr) * 1
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const allRows: Array<BacktestResult & { phase: 'TRAIN' | 'TEST' | 'FULL' }> = []

  for (const { tf, horizonsBars } of TIMEFRAMES) {
    console.log(`\n=== Timeframe ${tf} ===`)
    for (const symbol of SYMBOLS) {
      console.log(`Loading ${symbol} ${tf}...`)
      let candles: OHLCV[]
      try {
        candles = await loadHistorical(symbol, tf, MONTHS_BACK, 'bybit', 'linear')
      } catch (e: any) {
        console.warn(`  ${symbol} ${tf}: load failed (${e.message}), skip`)
        continue
      }
      if (candles.length < 1000) {
        console.warn(`  ${symbol} ${tf}: only ${candles.length} candles, skip`)
        continue
      }
      console.log(`  ${candles.length} candles, building series...`)
      const series = buildSeries(candles)

      // Walk-forward split by time, not by index
      const firstTime = candles[0].time
      const lastTime = candles[candles.length - 1].time
      const totalSpan = lastTime - firstTime
      const trainEndTime = firstTime + Math.floor(totalSpan * (TRAIN_MONTHS / MONTHS_BACK))

      let trainEndIdx = candles.findIndex((c) => c.time > trainEndTime)
      if (trainEndIdx < 0) trainEndIdx = candles.length

      const warmupStart = 100 // enough bars for EMA50 + RSI + BB
      for (const { label: hLabel, bars: hBars } of horizonsBars) {
        const safeEnd = candles.length - hBars  // can't evaluate signal beyond
        for (const { name: stratName, fn } of STRATEGIES) {
          // TRAIN
          const trA = evaluate(candles, series, warmupStart, Math.min(trainEndIdx, safeEnd), hBars, fn)
          const trWR = winRate(trA.wins, trA.losses)
          allRows.push({
            symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'TRAIN',
            trades: trA.trades, wins: trA.wins, losses: trA.losses, ties: trA.ties,
            winRate: trWR, evPerTrade: ev(trWR),
          })
          // TEST
          const teA = evaluate(candles, series, Math.max(warmupStart, trainEndIdx), safeEnd, hBars, fn)
          const teWR = winRate(teA.wins, teA.losses)
          allRows.push({
            symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'TEST',
            trades: teA.trades, wins: teA.wins, losses: teA.losses, ties: teA.ties,
            winRate: teWR, evPerTrade: ev(teWR),
          })
          // FULL (TRAIN+TEST)
          const fA = evaluate(candles, series, warmupStart, safeEnd, hBars, fn)
          const fWR = winRate(fA.wins, fA.losses)
          allRows.push({
            symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'FULL',
            trades: fA.trades, wins: fA.wins, losses: fA.losses, ties: fA.ties,
            winRate: fWR, evPerTrade: ev(fWR),
          })
        }
      }
    }
  }

  // ----- Reporting -----
  console.log('\n\n================================================================================')
  console.log('BINARY DIRECTION PREDICTION — RESULTS')
  console.log(`Payout assumed: ${(PAYOUT * 100).toFixed(0)}% → break-even WR = ${(BREAK_EVEN_WR * 100).toFixed(2)}%`)
  console.log('================================================================================\n')

  // 1. Aggregate by (tf, strategy, horizon) across all symbols — TEST only
  type AggKey = string
  const agg = new Map<AggKey, { trades: number; wins: number; losses: number; ties: number }>()
  for (const r of allRows) {
    if (r.phase !== 'TEST') continue
    const key = `${r.tf}|${r.strategy}|${r.horizonLabel}`
    const cur = agg.get(key) ?? { trades: 0, wins: 0, losses: 0, ties: 0 }
    cur.trades += r.trades
    cur.wins += r.wins
    cur.losses += r.losses
    cur.ties += r.ties
    agg.set(key, cur)
  }

  console.log('--- AGGREGATE (all symbols pooled) — TEST set ---')
  console.log('TF  | Strat    | H    | trades | wins  | losses | WR%    | EV/$1   | edge?')
  console.log('----+----------+------+--------+-------+--------+--------+---------+------')
  const sorted = [...agg.entries()].sort((a, b) => {
    const [tfa, sa, ha] = a[0].split('|')
    const [tfb, sb, hb] = b[0].split('|')
    return tfa.localeCompare(tfb) || sa.localeCompare(sb) || ha.localeCompare(hb)
  })
  for (const [key, v] of sorted) {
    const [tf, strat, h] = key.split('|')
    const wr = winRate(v.wins, v.losses)
    const e = ev(wr)
    const edge = wr > BREAK_EVEN_WR && e > 0 ? ' YES' : ' --'
    console.log(
      `${tf.padEnd(3)} | ${strat.padEnd(8)} | ${h.padEnd(4)} | ${String(v.trades).padStart(6)} | ${String(v.wins).padStart(5)} | ${String(v.losses).padStart(6)} | ${(wr * 100).toFixed(2).padStart(6)} | ${e >= 0 ? '+' : ''}${e.toFixed(4)} |${edge}`
    )
  }

  // 2. TRAIN vs TEST consistency for ANY row with TEST edge
  console.log('\n--- TRAIN vs TEST consistency (rows with TEST edge OR aggregate edge) ---')
  console.log('TF  | Symbol   | Strat    | H    | TRAIN WR | TEST WR | TEST EV | n_test | edge?')
  console.log('----+----------+----------+------+----------+---------+---------+--------+------')
  const byKey = new Map<string, { TRAIN?: BacktestResult; TEST?: BacktestResult; FULL?: BacktestResult }>()
  for (const r of allRows) {
    const key = `${r.symbol}|${r.tf}|${r.strategy}|${r.horizonLabel}`
    const cur = byKey.get(key) ?? {}
    ;(cur as any)[r.phase] = r
    byKey.set(key, cur)
  }
  let edgeRows = 0
  for (const [, v] of byKey) {
    if (!v.TRAIN || !v.TEST) continue
    const testEdge = v.TEST.winRate > BREAK_EVEN_WR && v.TEST.evPerTrade > 0 && v.TEST.trades >= 100
    if (!testEdge) continue
    edgeRows++
    console.log(
      `${v.TEST.tf.padEnd(3)} | ${v.TEST.symbol.padEnd(8)} | ${v.TEST.strategy.padEnd(8)} | ${v.TEST.horizonLabel.padEnd(4)} | ${(v.TRAIN.winRate * 100).toFixed(2).padStart(8)} | ${(v.TEST.winRate * 100).toFixed(2).padStart(7)} | ${v.TEST.evPerTrade >= 0 ? '+' : ''}${v.TEST.evPerTrade.toFixed(4)} | ${String(v.TEST.trades).padStart(6)} | YES`
    )
  }
  if (edgeRows === 0) {
    console.log('(no per-symbol edge with >=100 TEST trades found)')
  }

  // 3. Best aggregate edge highlight
  console.log('\n--- TOP-5 best aggregate edges (TEST) ---')
  const topAgg = sorted
    .map(([k, v]) => ({ k, wr: winRate(v.wins, v.losses), ev: ev(winRate(v.wins, v.losses)), trades: v.trades }))
    .filter((x) => x.trades >= 200)
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 5)
  for (const t of topAgg) {
    console.log(`  ${t.k.padEnd(28)} | trades=${t.trades.toString().padStart(6)} | WR=${(t.wr * 100).toFixed(2)}% | EV=${t.ev >= 0 ? '+' : ''}${t.ev.toFixed(4)}`)
  }

  console.log('\n--- Interpretation ---')
  console.log(`Break-even WR @ payout ${(PAYOUT * 100).toFixed(0)}% = ${(BREAK_EVEN_WR * 100).toFixed(2)}%`)
  console.log(`Edge requires: WR > break-even AND EV > 0 AND meaningful sample (>=200 trades in aggregate, >=100 per-symbol).`)
  console.log(`If best aggregate EV is negative or barely positive, direction prediction on liquid crypto has NO edge with these rules.`)
  console.log(`Note: PO OTC pairs may have different statistics — this tests REAL market only.\n`)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
