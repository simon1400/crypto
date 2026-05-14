/**
 * Forex Binary Options Direction Prediction — backtest.
 *
 * Близнец runBacktest_binary_direction.ts, но на forex данных (OANDA).
 * Стратегии и метрики идентичны — чтобы прямо сравнить с crypto результатами.
 *
 *   1. Momentum  — RSI extreme cross + EMA20 filter
 *   2. MeanRev   — Bollinger Band touch (fade)
 *   3. Breakout  — Donchian-20 break (close)
 *   4. Combo     — Momentum + ADX>=20
 *
 * Horizons: 1m / 5m / 15m. На 5m TF: 1=5m / 3=15m. (1m horizon на 5m TF не имеет смысла.)
 *
 * Метрика: WR vs break-even 55.56% (payout 80%), EV per $1.
 *
 * Forex specifics:
 *   - Закрыт Sat-Sun → пропуски в данных, скрипт фильтрует
 *   - PO regular pairs работают только в forex hours (Mo-Fr) — backtest
 *     адекватен именно для этого режима
 *
 * Run:
 *   cd backend && npx tsx src/scalper/runBacktest_binary_direction_forex.ts
 *
 * Требует: POLYGON_API_KEY в backend/.env (free tier OK, 5 req/min)
 */

import 'dotenv/config'
import { loadPolygonHistorical } from './polygonLoader'
import { ema } from '../services/indicators'
import { OHLCV } from '../services/market'

// ============================================================================
// Config
// ============================================================================

// Polygon forex ticker format: C:{PAIR} (e.g. C:EURUSD)
const INSTRUMENTS = [
  'C:EURUSD',
  'C:GBPUSD',
  'C:AUDUSD',
  'C:USDJPY',
  'C:USDCAD',
  'C:NZDUSD',
]

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
const PAYOUT = 0.80
const BREAK_EVEN_WR = 1 / (1 + PAYOUT)

type Direction = 'CALL' | 'PUT'

interface BacktestResult {
  symbol: string
  tf: string
  strategy: string
  horizonLabel: string
  trades: number
  wins: number
  losses: number
  ties: number
  winRate: number
  evPerTrade: number
}

// ============================================================================
// Indicators (incremental — same as crypto backtest)
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

function rollingADX(candles: OHLCV[], period = 14): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n < period * 2) return out
  const tr: number[] = [0]
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
  for (let i = 1; i < n; i++) {
    const c = candles[i]; const p = candles[i - 1]
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
    const up = c.high - p.high
    const dn = p.low - c.low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
  }
  let smTR = 0, smP = 0, smM = 0
  for (let i = 1; i <= period; i++) { smTR += tr[i]; smP += plusDM[i]; smM += minusDM[i] }
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
      out[i] = dx.slice(0, period).reduce((a, b) => a + b, 0) / period
    } else if (dx.length > period) {
      const prev = out[i - 1] ?? 25
      out[i] = (prev * (period - 1) + dx[dx.length - 1]) / period
    }
  }
  return out
}

interface Series {
  closes: number[]
  highs: number[]
  lows: number[]
  rsi14: (number | null)[]
  ema20: number[]
  bbU: (number | null)[]
  bbL: (number | null)[]
  adx14: (number | null)[]
}

function buildSeries(candles: OHLCV[]): Series {
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  return {
    closes, highs, lows,
    rsi14: rollingRSI(closes, 14),
    ema20: ema(closes, 20),
    bbU: rollingBB(closes, 20, 2).upper,
    bbL: rollingBB(closes, 20, 2).lower,
    adx14: rollingADX(candles, 14),
  }
}

// ============================================================================
// Strategies
// ============================================================================

function sigMomentum(s: Series, i: number): Direction | null {
  const r = s.rsi14[i], rPrev = s.rsi14[i - 1]
  if (r == null || rPrev == null) return null
  const c = s.closes[i], e = s.ema20[i]
  if (rPrev < 30 && r >= 30 && c > e) return 'CALL'
  if (rPrev > 70 && r <= 70 && c < e) return 'PUT'
  return null
}

function sigMeanRev(s: Series, i: number): Direction | null {
  const u = s.bbU[i], l = s.bbL[i]
  if (u == null || l == null) return null
  const c = s.closes[i]
  if (c <= l) return 'CALL'
  if (c >= u) return 'PUT'
  return null
}

function sigBreakout(s: Series, i: number): Direction | null {
  const lookback = 20
  if (i < lookback) return null
  let hh = -Infinity, ll = Infinity
  for (let k = i - lookback; k < i; k++) {
    if (s.highs[k] > hh) hh = s.highs[k]
    if (s.lows[k] < ll) ll = s.lows[k]
  }
  const c = s.closes[i]
  if (c > hh) return 'CALL'
  if (c < ll) return 'PUT'
  return null
}

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
// Evaluate
// ============================================================================

function evaluate(
  candles: OHLCV[],
  series: Series,
  iStart: number,
  iEnd: number,
  horizonBars: number,
  stratFn: (s: Series, i: number) => Direction | null,
): { trades: number; wins: number; losses: number; ties: number } {
  let trades = 0, wins = 0, losses = 0, ties = 0
  for (let i = iStart; i < iEnd; i++) {
    const dir = stratFn(series, i)
    if (!dir) continue
    const j = i + horizonBars
    if (j >= candles.length) break
    // Skip if signal candle and horizon candle are separated by a weekend gap (>4h on M5)
    // — forex closes Fri 21:00 UTC, opens Sun 21:00 UTC. We don't want signals that span this.
    const gap = candles[j].time - candles[i].time
    const expectedGap = horizonBars * (candles[i + 1].time - candles[i].time)
    if (gap > expectedGap * 5) continue  // tolerate small gaps, skip weekends
    const entry = candles[i].close
    const expiry = candles[j].close
    trades++
    if (expiry === entry) { ties++; continue }
    const movedUp = expiry > entry
    const win = (dir === 'CALL' && movedUp) || (dir === 'PUT' && !movedUp)
    if (win) wins++; else losses++
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
  if (!process.env.POLYGON_API_KEY) {
    console.error('POLYGON_API_KEY is missing in backend/.env')
    process.exit(1)
  }

  const allRows: Array<BacktestResult & { phase: 'TRAIN' | 'TEST' | 'FULL' }> = []

  for (const { tf, horizonsBars } of TIMEFRAMES) {
    console.log(`\n=== Timeframe ${tf} ===`)
    for (const symbol of INSTRUMENTS) {
      console.log(`Loading ${symbol} ${tf}...`)
      let candles: OHLCV[]
      try {
        candles = await loadPolygonHistorical(symbol, tf, MONTHS_BACK)
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

      const firstTime = candles[0].time
      const lastTime = candles[candles.length - 1].time
      const span = lastTime - firstTime
      const trainEndTime = firstTime + Math.floor(span * (TRAIN_MONTHS / MONTHS_BACK))
      let trainEndIdx = candles.findIndex((c) => c.time > trainEndTime)
      if (trainEndIdx < 0) trainEndIdx = candles.length

      const warmupStart = 100

      for (const { label: hLabel, bars: hBars } of horizonsBars) {
        const safeEnd = candles.length - hBars
        for (const { name: stratName, fn } of STRATEGIES) {
          const trA = evaluate(candles, series, warmupStart, Math.min(trainEndIdx, safeEnd), hBars, fn)
          const trWR = winRate(trA.wins, trA.losses)
          allRows.push({ symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'TRAIN',
            trades: trA.trades, wins: trA.wins, losses: trA.losses, ties: trA.ties, winRate: trWR, evPerTrade: ev(trWR) })

          const teA = evaluate(candles, series, Math.max(warmupStart, trainEndIdx), safeEnd, hBars, fn)
          const teWR = winRate(teA.wins, teA.losses)
          allRows.push({ symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'TEST',
            trades: teA.trades, wins: teA.wins, losses: teA.losses, ties: teA.ties, winRate: teWR, evPerTrade: ev(teWR) })

          const fA = evaluate(candles, series, warmupStart, safeEnd, hBars, fn)
          const fWR = winRate(fA.wins, fA.losses)
          allRows.push({ symbol, tf, strategy: stratName, horizonLabel: hLabel, phase: 'FULL',
            trades: fA.trades, wins: fA.wins, losses: fA.losses, ties: fA.ties, winRate: fWR, evPerTrade: ev(fWR) })
        }
      }
    }
  }

  // -------- Report --------
  console.log('\n\n================================================================================')
  console.log('FOREX BINARY DIRECTION PREDICTION — RESULTS')
  console.log(`Payout assumed: ${(PAYOUT * 100).toFixed(0)}% → break-even WR = ${(BREAK_EVEN_WR * 100).toFixed(2)}%`)
  console.log('================================================================================\n')

  type AggKey = string
  const agg = new Map<AggKey, { trades: number; wins: number; losses: number; ties: number }>()
  for (const r of allRows) {
    if (r.phase !== 'TEST') continue
    const key = `${r.tf}|${r.strategy}|${r.horizonLabel}`
    const cur = agg.get(key) ?? { trades: 0, wins: 0, losses: 0, ties: 0 }
    cur.trades += r.trades; cur.wins += r.wins; cur.losses += r.losses; cur.ties += r.ties
    agg.set(key, cur)
  }

  console.log('--- AGGREGATE (all pairs pooled) — TEST set ---')
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
    console.log(`${tf.padEnd(3)} | ${strat.padEnd(8)} | ${h.padEnd(4)} | ${String(v.trades).padStart(6)} | ${String(v.wins).padStart(5)} | ${String(v.losses).padStart(6)} | ${(wr * 100).toFixed(2).padStart(6)} | ${e >= 0 ? '+' : ''}${e.toFixed(4)} |${edge}`)
  }

  // Per-symbol TRAIN/TEST consistency on edges
  console.log('\n--- TRAIN vs TEST consistency (per-pair rows with TEST edge >=100 trades) ---')
  console.log('TF  | Pair     | Strat    | H    | TRAIN WR | TEST WR | TEST EV | n_test | edge?')
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
    console.log(`${v.TEST.tf.padEnd(3)} | ${v.TEST.symbol.padEnd(8)} | ${v.TEST.strategy.padEnd(8)} | ${v.TEST.horizonLabel.padEnd(4)} | ${(v.TRAIN.winRate * 100).toFixed(2).padStart(8)} | ${(v.TEST.winRate * 100).toFixed(2).padStart(7)} | ${v.TEST.evPerTrade >= 0 ? '+' : ''}${v.TEST.evPerTrade.toFixed(4)} | ${String(v.TEST.trades).padStart(6)} | YES`)
  }
  if (edgeRows === 0) console.log('(no per-symbol edge with >=100 TEST trades found)')

  console.log('\n--- TOP-5 best aggregate edges (TEST) ---')
  const topAgg = sorted
    .map(([k, v]) => ({ k, wr: winRate(v.wins, v.losses), ev: ev(winRate(v.wins, v.losses)), trades: v.trades }))
    .filter((x) => x.trades >= 200)
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 5)
  for (const t of topAgg) {
    console.log(`  ${t.k.padEnd(28)} | trades=${t.trades.toString().padStart(6)} | WR=${(t.wr * 100).toFixed(2)}% | EV=${t.ev >= 0 ? '+' : ''}${t.ev.toFixed(4)}`)
  }

  console.log('\nDone.\n')
}

main().catch((e) => {
  console.error('FATAL:', e?.message ?? e)
  process.exit(1)
})
