/**
 * Forex Binary — backtest для выбора оптимального horizon с учётом entry delay.
 *
 * Контекст: текущий live помощник использует horizon 1m с entry в момент close 1m свечи.
 * НО на реальной торговле:
 *   1. TwelveData polling round-robin даёт сигнал с задержкой ~5-30 секунд после close
 *   2. Юзер реагирует ~10-15 секунд (увидеть, кликнуть BUY/SELL на PO)
 *   3. PO котировки отличаются от межбанка на ±10-20 пунктов
 *
 * → реальный entry происходит **~30 секунд позже** чем close той свечи на которой
 *   сработал backtest. Если цена за эти 30с уже двинулась — edge подъедается.
 *
 * Этот скрипт моделирует РЕАЛЬНУЮ ситуацию:
 *   - сигнал создаётся на close 1m свечи i (BB touch проверяем тут как обычно)
 *   - но ВХОД считается на цене через 30 секунд после close (mid-bar i+1)
 *   - exit считается через horizon_bars от ВХОДА
 *
 * Проверяем horizons: 1m, 2m, 3m, 5m.
 * Гипотеза: 2-3m может быть лучше потому что 1m не успевает реверсировать после задержки.
 *
 * Run:
 *   cd backend && npx tsx src/scalper/runBacktest_binary_horizon_delay.ts
 */

import 'dotenv/config'
import { loadPolygonHistorical } from './polygonLoader'
import { OHLCV } from '../services/market'

// EUR/CAD пропущен: для него нет кеша Polygon (только что добавлен в live).
// 5 пар с готовым кешем — мгновенный backtest.
const INSTRUMENTS = ['C:EURUSD', 'C:GBPUSD', 'C:AUDUSD', 'C:USDJPY', 'C:USDCAD']
const TF = '1m'
const MONTHS_BACK = 6
const TRAIN_MONTHS = 4
const PAYOUT = 0.85   // средний payout на PO для топовых пар
const BREAK_EVEN_WR = 1 / (1 + PAYOUT)

// Entry delay sweep: 0/0.17/0.33/0.5 ≈ 0s / 10s / 20s / 30s после close.
const ENTRY_DELAYS: Array<{ label: string; frac: number }> = [
  { label: '0s',  frac: 0.00 },
  { label: '10s', frac: 0.17 },
  { label: '20s', frac: 0.33 },
  { label: '30s', frac: 0.50 },
]

// Fixed at 5m horizon (best in previous sweep).
const HORIZON_BARS = 5

const BB_PERIOD = 20
const BB_MULT = 2
const TF_MS = 60_000

type Direction = 'CALL' | 'PUT'

interface Result {
  symbol: string
  horizonLabel: string
  trades: number
  wins: number
  losses: number
  ties: number
  winRate: number
  evPerTrade: number
}

// ----- Rolling BB -----
function rollingBB(closes: number[], period = BB_PERIOD, mult = BB_MULT) {
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]
    const mean = sum / period
    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - mean) ** 2
    const std = Math.sqrt(sqSum / period)
    upper[i] = mean + mult * std
    lower[i] = mean - mult * std
  }
  return { upper, lower }
}

// ----- Sim entry price with delay -----
// Imitate: at close of bar i (signal fires), real entry happens fraction `delay` into bar i+1.
// Approximation: entryPrice = open(i+1) + delay * (close(i+1) - open(i+1))
function entryPriceWithDelay(candles: OHLCV[], i: number, delayFrac: number): number | null {
  if (i + 1 >= candles.length) return null
  const next = candles[i + 1]
  return next.open + delayFrac * (next.close - next.open)
}

// Exit price = close of bar (entry_bar + horizon_bars - 1).
// Since entry is mid-bar (i+1), and horizon counts full bars from entry, the exit
// is at close of bar (i + horizon_bars) — i.e. horizon_bars after the entry bar.
function exitPrice(candles: OHLCV[], i: number, horizonBars: number): number | null {
  const exitIdx = i + horizonBars
  if (exitIdx >= candles.length) return null
  return candles[exitIdx].close
}

function evaluate(
  candles: OHLCV[],
  upper: (number | null)[],
  lower: (number | null)[],
  iStart: number,
  iEnd: number,
  horizonBars: number,
  delayFrac: number,
): { trades: number; wins: number; losses: number; ties: number } {
  let trades = 0, wins = 0, losses = 0, ties = 0
  for (let i = iStart; i < iEnd; i++) {
    const u = upper[i], l = lower[i]
    if (u == null || l == null) continue
    const close = candles[i].close
    let dir: Direction | null = null
    if (close <= l) dir = 'CALL'
    else if (close >= u) dir = 'PUT'
    if (!dir) continue

    const entry = entryPriceWithDelay(candles, i, delayFrac)
    if (entry == null) continue
    const exit = exitPrice(candles, i, horizonBars)
    if (exit == null) continue
    const gap = candles[i + horizonBars].time - candles[i].time
    if (gap > (horizonBars + 1) * TF_MS * 5) continue  // weekend skip

    trades++
    if (exit === entry) { ties++; continue }
    const movedUp = exit > entry
    const win = (dir === 'CALL' && movedUp) || (dir === 'PUT' && !movedUp)
    if (win) wins++; else losses++
  }
  return { trades, wins, losses, ties }
}

function ev(wr: number, payout = PAYOUT): number {
  return wr * payout - (1 - wr) * 1
}

async function main() {
  if (!process.env.POLYGON_API_KEY) {
    console.error('POLYGON_API_KEY missing in backend/.env')
    process.exit(1)
  }

  const allRows: Array<Result & { phase: 'TRAIN' | 'TEST' }> = []

  for (const symbol of INSTRUMENTS) {
    console.log(`\nLoading ${symbol} ${TF}...`)
    let candles: OHLCV[]
    try {
      candles = await loadPolygonHistorical(symbol, TF, MONTHS_BACK)
    } catch (e: any) {
      console.warn(`  ${symbol}: load failed (${e.message}), skip`)
      continue
    }
    if (candles.length < 1000) {
      console.warn(`  ${symbol}: only ${candles.length} candles, skip`)
      continue
    }
    console.log(`  ${candles.length} candles loaded`)

    const closes = candles.map((c) => c.close)
    const { upper, lower } = rollingBB(closes)

    const firstTime = candles[0].time
    const lastTime = candles[candles.length - 1].time
    const span = lastTime - firstTime
    const trainEndTime = firstTime + Math.floor(span * (TRAIN_MONTHS / MONTHS_BACK))
    let trainEndIdx = candles.findIndex((c) => c.time > trainEndTime)
    if (trainEndIdx < 0) trainEndIdx = candles.length

    const warmupStart = 100

    for (const { label: delayLabel, frac: delayFrac } of ENTRY_DELAYS) {
      const safeEnd = candles.length - HORIZON_BARS - 1
      const tr = evaluate(candles, upper, lower, warmupStart, Math.min(trainEndIdx, safeEnd), HORIZON_BARS, delayFrac)
      const trWR = tr.wins + tr.losses === 0 ? 0 : tr.wins / (tr.wins + tr.losses)
      allRows.push({ symbol, horizonLabel: delayLabel, phase: 'TRAIN',
        trades: tr.trades, wins: tr.wins, losses: tr.losses, ties: tr.ties,
        winRate: trWR, evPerTrade: ev(trWR) })

      const te = evaluate(candles, upper, lower, Math.max(warmupStart, trainEndIdx), safeEnd, HORIZON_BARS, delayFrac)
      const teWR = te.wins + te.losses === 0 ? 0 : te.wins / (te.wins + te.losses)
      allRows.push({ symbol, horizonLabel: delayLabel, phase: 'TEST',
        trades: te.trades, wins: te.wins, losses: te.losses, ties: te.ties,
        winRate: teWR, evPerTrade: ev(teWR) })
    }
  }

  // ---- Aggregate by horizon, TEST set ----
  console.log('\n\n================================================================================')
  console.log(`FOREX BINARY — h=5m, entry delay sweep`)
  console.log(`Payout ${(PAYOUT * 100).toFixed(0)}% → break-even WR = ${(BREAK_EVEN_WR * 100).toFixed(2)}%`)
  console.log('================================================================================\n')

  type Agg = { trades: number; wins: number; losses: number; ties: number }
  const aggTest = new Map<string, Agg>()
  for (const r of allRows) {
    if (r.phase !== 'TEST') continue
    const cur = aggTest.get(r.horizonLabel) ?? { trades: 0, wins: 0, losses: 0, ties: 0 }
    cur.trades += r.trades; cur.wins += r.wins; cur.losses += r.losses; cur.ties += r.ties
    aggTest.set(r.horizonLabel, cur)
  }

  console.log('--- AGGREGATE (all pairs pooled) — TEST set, h=5m ---')
  console.log('Delay | trades | wins  | losses | WR%    | EV/$1   | edge?')
  console.log('------+--------+-------+--------+--------+---------+------')
  for (const { label } of ENTRY_DELAYS) {
    const a = aggTest.get(label)
    if (!a) continue
    const wr = a.wins + a.losses === 0 ? 0 : a.wins / (a.wins + a.losses)
    const e = ev(wr)
    const edge = wr > BREAK_EVEN_WR && e > 0 ? ' YES' : ' --'
    console.log(`${label.padEnd(5)} | ${String(a.trades).padStart(6)} | ${String(a.wins).padStart(5)} | ${String(a.losses).padStart(6)} | ${(wr * 100).toFixed(2).padStart(6)} | ${e >= 0 ? '+' : ''}${e.toFixed(4)} |${edge}`)
  }

  // ---- Per-symbol breakdown ----
  console.log('\n--- PER-SYMBOL (TEST set) ---')
  console.log('Symbol     | Horiz  | trades | WR%    | EV/$1   | TRAIN WR | edge?')
  console.log('-----------+--------+--------+--------+---------+----------+------')
  // For each symbol, show all horizons sorted by EV
  const bySym = new Map<string, Array<Result & { phase: 'TRAIN' | 'TEST' }>>()
  for (const r of allRows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, [])
    bySym.get(r.symbol)!.push(r)
  }
  for (const [sym, rows] of bySym) {
    const tests = rows.filter((r) => r.phase === 'TEST').sort((a, b) => b.evPerTrade - a.evPerTrade)
    for (const t of tests) {
      const trainRow = rows.find((r) => r.phase === 'TRAIN' && r.horizonLabel === t.horizonLabel)
      const edge = t.winRate > BREAK_EVEN_WR && t.evPerTrade > 0 ? ' YES' : ' --'
      const trWR = trainRow ? `${(trainRow.winRate * 100).toFixed(2)}%` : '—'
      console.log(`${sym.padEnd(10)} | ${t.horizonLabel.padEnd(6)} | ${String(t.trades).padStart(6)} | ${(t.winRate * 100).toFixed(2).padStart(6)} | ${t.evPerTrade >= 0 ? '+' : ''}${t.evPerTrade.toFixed(4)} | ${trWR.padStart(8)} |${edge}`)
    }
    console.log('')
  }

  // Compare to ZERO-delay (current backtest assumption) — quick sanity check on horizon 1m
  console.log('\n--- COMPARE: current live (entry@close, h=1m) vs delayed entry simulation ---')
  console.log(`При payout ${(PAYOUT * 100).toFixed(0)}%, horizon 5m:`)
  console.log(`  - Если h=1m EV резко упал vs предыдущий backtest (где было +0.08 @ 80% payout) — задержка съедает edge`)
  console.log(`  - Если h=2m/3m имеют лучший EV — стоит переключиться на длиннее экспирацию`)
  console.log(`  - Если все horizon негативные — проблема не в expiry, а в задержке как таковой\n`)

  console.log('Done.\n')
}

main().catch((e) => {
  console.error('FATAL:', e?.message ?? e)
  process.exit(1)
})
