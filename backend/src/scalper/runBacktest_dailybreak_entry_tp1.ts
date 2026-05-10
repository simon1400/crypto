/**
 * Daily Breakout — entry→TP1 distance breakdown (live entry formula).
 *
 * Вопрос: насколько часто live получаются "fast-mover" сделки где entry
 * (= c.close триггерной свечи) сильно выше rangeHigh, и TP1 оказывается
 * близко к entry? Такие сделки даже на TP1 попадают в минус из-за fees
 * (например AERO #111: entry 0.5196, TP1 0.5205, дистанция 0.17%, итог -$0.02).
 *
 * Отличие от runBacktest_dailybreak_sldist.ts:
 *   - entry = c.close (как в live engine), НЕ rangeHigh (как в idealized backtest)
 *   - SL остаётся = противоположный rangeEdge (geometry from range, not entry)
 *   - TP ladder остаётся anchor=rangeHigh + rangeSize×N (как в live engine)
 *   - Бакеты по entry→TP1 % дистанции
 *
 * Method:
 *   1) Прогнать ladder backtest на prod 23 symbols (FULL/TRAIN/TEST).
 *   2) Сгруппировать сделки по бакетам entry→TP1 % дистанции:
 *      [≤0.1%], [0.1–0.2%], [0.2–0.3%], [0.3–0.5%], [0.5–0.8%], [0.8–1.5%], [1.5%+]
 *   3) Per bucket: N, R/tr, totalR, WR, share от общего.
 *   4) What-if: фильтр min entry→TP1 % — что меняется?
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_entry_tp1.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const RANGE_BARS = 36   // 3h
const VOL_MULT = 2.0
// Realistic Binance defaults (см. project_breakout_realistic_fees_2026_05_10.md):
// taker 0.05% + maker 0.02%. Round-trip ~0.07%, плюс slip 0.03% per side.
// LadderBacktester принимает round-trip flat — используем 0.07% как approximation.
const FEES_RT = 0.0007
const SLIPPAGE = 0.0003

// Match DEFAULT_BREAKOUT_SETUPS in dailyBreakoutLiveScanner.ts (23 symbols, refreshed 2026-05-09).
const SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT', 'MUSDT', 'LDOUSDT',
  'DYDXUSDT', 'ZECUSDT', 'STXUSDT', 'IPUSDT', 'ORDIUSDT', 'ARUSDT',
  'DOGEUSDT', 'TRUMPUSDT', 'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT',
  'AEROUSDT', 'POLUSDT', 'VVVUSDT', 'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

/**
 * Генерирует сигналы по live-формуле: entry = c.close триггерной свечи (не rangeHigh).
 * SL = противоположный rangeEdge. TP ladder = rangeEdge ± rangeSize × N (anchored to range edge,
 * как в live engine — это сохраняет геометрию относительно range).
 *
 * В результате entry → TP1 дистанция может быть < rangeSize если c.close сильно ушла за rangeHigh
 * (fast mover). Эти сделки даже при TP1-hit могут быть в минус из-за fees.
 */
function generateBreakoutSignals(m5: OHLCV[], periodFrom: number, periodTo: number): LadderSignal[] {
  const sigs: LadderSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = new Date(c.time).toISOString().slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }
  for (const [, candles] of byDay) {
    if (candles.length < RANGE_BARS + 5) continue
    const rangeBars = candles.slice(0, RANGE_BARS)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue
    let triggered = false
    for (let i = RANGE_BARS; i < candles.length && !triggered; i++) {
      const c = candles[i]
      const start = Math.max(0, i - 24)
      const avgVol = candles.slice(start, i).reduce((s, x) => s + x.volume, 0) / Math.max(1, i - start)
      if (c.volume < avgVol * VOL_MULT) continue
      let side: 'BUY' | 'SELL' | null = null
      let entryPrice = 0
      let anchor = 0
      if (c.high > rangeHigh && c.close > rangeHigh) {
        side = 'BUY'
        entryPrice = c.close   // ← LIVE formula
        anchor = rangeHigh     // TP anchored to rangeHigh, not entry
      } else if (c.low < rangeLow && c.close < rangeLow) {
        side = 'SELL'
        entryPrice = c.close   // ← LIVE formula
        anchor = rangeLow
      }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [anchor + rangeSize, anchor + rangeSize * 2, anchor + rangeSize * 3]
        : [anchor - rangeSize, anchor - rangeSize * 2, anchor - rangeSize * 3]

      // Существующие гарды: slDist >= 0.4% и overshoot
      const slDistPct = (Math.abs(entryPrice - sl) / entryPrice) * 100
      if (slDistPct < 0.4) continue
      const tp1Overshoot = side === 'BUY' ? entryPrice >= tpLadder[0] : entryPrice <= tpLadder[0]
      if (tp1Overshoot) continue

      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

// Расширяем LadderTrade полем tp1 из исходного сигнала — нужно для бакетирования
// по entry→TP1 distance (LadderTrade сам не хранит tpLadder).
type TradeWithTp1 = LadderTrade & { tp1: number }

function runOne(m5: OHLCV[], periodFrom: number, periodTo: number): TradeWithTp1[] {
  const sigs = generateBreakoutSignals(m5, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
  const tp1ByEntryTime = new Map<number, number>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) {
      sigByIdx.set(idx, s)
      tp1ByEntryTime.set(s.entryTime, s.tpLadder[0])
    }
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: [0.5, 0.3, 0.2], trailing: true,
    feesRoundTrip: FEES_RT, slippagePerSide: SLIPPAGE,
  }
  const trades = runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
  return trades.map(t => ({ ...t, tp1: tp1ByEntryTime.get(t.entryTime) ?? t.entryPrice }))
}

interface Bucket {
  label: string
  min: number  // inclusive, in %
  max: number  // exclusive, in %
}

const BUCKETS: Bucket[] = [
  { label: '≤0.1%',     min: 0,    max: 0.1 },
  { label: '0.1–0.2%',  min: 0.1,  max: 0.2 },
  { label: '0.2–0.3%',  min: 0.2,  max: 0.3 },
  { label: '0.3–0.5%',  min: 0.3,  max: 0.5 },
  { label: '0.5–0.8%',  min: 0.5,  max: 0.8 },
  { label: '0.8–1.5%',  min: 0.8,  max: 1.5 },
  { label: '1.5%+',     min: 1.5,  max: 999 },
]

interface BucketStat {
  label: string
  n: number
  totalR: number
  rPerTr: number
  wins: number
  wr: number
  share: number
}

// entry→TP1 дистанция в % от entry (TP1 сохранён в trade при создании выше).
function entryTp1Pct(t: TradeWithTp1): number {
  return (Math.abs(t.tp1 - t.entryPrice) / t.entryPrice) * 100
}

function bucketize(trades: TradeWithTp1[]): BucketStat[] {
  const total = trades.length
  return BUCKETS.map(b => {
    const inBucket = trades.filter(t => {
      const p = entryTp1Pct(t)
      return p >= b.min && p < b.max
    })
    let totalR = 0, wins = 0
    for (const t of inBucket) {
      totalR += t.pnlR
      if (t.pnlR > 0.001) wins++
    }
    return {
      label: b.label,
      n: inBucket.length,
      totalR,
      rPerTr: inBucket.length > 0 ? totalR / inBucket.length : 0,
      wins,
      wr: inBucket.length > 0 ? (wins / inBucket.length) * 100 : 0,
      share: total > 0 ? (inBucket.length / total) * 100 : 0,
    }
  })
}

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }

function printBuckets(label: string, trades: TradeWithTp1[]) {
  const stats = bucketize(trades)
  const totalN = trades.length
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0)
  const totalRtr = totalN > 0 ? totalR / totalN : 0

  console.log(`=== ${label} (всего: N=${totalN}, R/tr=${fmtR(totalRtr)}, totR=${fmtR(totalR)}) ===`)
  console.log('entry→TP1   | trades | share | wins  | totalR  | R/tr  |  WR  ')
  console.log('-'.repeat(64))
  for (const s of stats) {
    if (s.n === 0) {
      console.log(`${s.label.padEnd(11)} |   ${'0'.padStart(4)} |  0.0% |    —  |     —   |   —   |  —   `)
      continue
    }
    console.log(
      `${s.label.padEnd(11)} | ${s.n.toString().padStart(6)} | ${s.share.toFixed(1).padStart(4)}% | ${s.wins.toString().padStart(5)} | ${fmtR(s.totalR).padStart(7)} | ${fmtR(s.rPerTr).padStart(5)} | ${s.wr.toFixed(0).padStart(3)}%`,
    )
  }
  console.log()

  console.log(`What-if (фильтр по min entry→TP1 %):`)
  const filters = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]
  for (const minPct of filters) {
    const kept = trades.filter(t => entryTp1Pct(t) >= minPct)
    const dropped = totalN - kept.length
    const sumR = kept.reduce((s, t) => s + t.pnlR, 0)
    const wins = kept.filter(t => t.pnlR > 0.001).length
    const filterLabel = minPct === 0 ? 'no filter' : `≥ ${minPct.toFixed(1)}%`
    if (kept.length === 0) {
      console.log(`  ${filterLabel.padEnd(12)} → отброшено ${dropped} (${((dropped/totalN)*100).toFixed(0)}%), осталось 0`)
      continue
    }
    console.log(
      `  ${filterLabel.padEnd(12)} → отброшено ${dropped.toString().padStart(4)} (${((dropped/totalN)*100).toFixed(0).padStart(2)}%), осталось N=${kept.length.toString().padStart(4)}, R/tr=${fmtR(sumR/kept.length)}, totR=${fmtR(sumR)}, WR=${((wins/kept.length)*100).toFixed(0)}%`,
    )
  }
  console.log()
}

async function main() {
  console.log('Daily Breakout — entry→TP1 distance breakdown (LIVE entry formula)')
  console.log(`23 prod symbols | 365d | range 3h | vol×2.0 | full trailing | fees 0.07% RT | slip 0.03%`)
  console.log(`entry = c.close (как в live engine), TP anchored to rangeEdge, slDist ≥ 0.4% guard`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const allFull: TradeWithTp1[] = []
  const allTrain: TradeWithTp1[] = []
  const allTest: TradeWithTp1[] = []
  for (const sym of SYMBOLS) {
    try {
      const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
      const m5 = sliceLastDays(all, DAYS_BACK)
      if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
      runOne(m5, fullStart, now).forEach(t => allFull.push(t))
      runOne(m5, fullStart, trainEnd).forEach(t => allTrain.push(t))
      runOne(m5, trainEnd, now).forEach(t => allTest.push(t))
    } catch (e: any) {
      console.warn(`[skip] ${sym} load failed: ${e.message}`)
    }
  }

  printBuckets('FULL (год)', allFull)
  printBuckets('TRAIN', allTrain)
  printBuckets('TEST', allTest)

  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
