/**
 * Daily Breakout — slDist% breakdown.
 *
 * Вопрос: насколько часто бывают сделки с очень узким SL (≤ 0.3%, ≤ 0.5%) и
 * какой у них edge? Узкий SL = огромное плечо в реале (×100+) = риск ликвидации
 * до того как цена дойдёт до запланированного SL.
 *
 * Метод:
 *   1) Прогнать ladder backtest на 32 prod symbols (FULL/TRAIN/TEST).
 *   2) Сгруппировать сделки по бакетам slDist% от entry:
 *      [0–0.2%], [0.2–0.4%], [0.4–0.6%], [0.6–1%], [1–1.5%], [1.5–2.5%], [2.5%+]
 *   3) Per bucket: N, R/tr, totalR, WR, доля от общего N.
 *   4) Также what-if симуляция: сколько totalR теряется если фильтровать узкие.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_sldist.ts
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
const SLIPPAGE = 0.0005
const FEES_RT = 0.0008

// Match DEFAULT_BREAKOUT_SETUPS in dailyBreakoutLiveScanner.ts (32 symbols).
const SYMBOLS = [
  'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'AVAXUSDT', 'ARBUSDT',
  'AAVEUSDT', 'ENAUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'SEIUSDT', 'BLURUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'SANDUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT',
  'TRUMPUSDT', 'STRKUSDT', 'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT',
  'AEROUSDT', 'ETCUSDT', 'IOUSDT', 'POLUSDT', 'TSTBSCUSDT', 'VVVUSDT',
]

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

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
      if (c.high > rangeHigh && c.close > rangeHigh) { side = 'BUY'; entryPrice = rangeHigh }
      else if (c.low < rangeLow && c.close < rangeLow) { side = 'SELL'; entryPrice = rangeLow }
      if (!side) continue
      const sl = side === 'BUY' ? rangeLow : rangeHigh
      const tpLadder = side === 'BUY'
        ? [entryPrice + rangeSize, entryPrice + rangeSize * 2, entryPrice + rangeSize * 3]
        : [entryPrice - rangeSize, entryPrice - rangeSize * 2, entryPrice - rangeSize * 3]
      sigs.push({ side, entryTime: c.time, entryPrice, sl, tpLadder, reason: 'daily_breakout' })
      triggered = true
    }
  }
  return sigs
}

function runOne(m5: OHLCV[], periodFrom: number, periodTo: number): LadderTrade[] {
  const sigs = generateBreakoutSignals(m5, periodFrom, periodTo)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LadderSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: [0.5, 0.3, 0.2], trailing: true,
    feesRoundTrip: FEES_RT, slippagePerSide: SLIPPAGE,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface Bucket {
  label: string
  min: number  // inclusive, in %
  max: number  // exclusive, in %
}

const BUCKETS: Bucket[] = [
  { label: '≤0.2%',     min: 0,    max: 0.2 },
  { label: '0.2–0.4%',  min: 0.2,  max: 0.4 },
  { label: '0.4–0.6%',  min: 0.4,  max: 0.6 },
  { label: '0.6–1.0%',  min: 0.6,  max: 1.0 },
  { label: '1.0–1.5%',  min: 1.0,  max: 1.5 },
  { label: '1.5–2.5%',  min: 1.5,  max: 2.5 },
  { label: '2.5%+',     min: 2.5,  max: 999 },
]

interface BucketStat {
  label: string
  n: number
  totalR: number
  rPerTr: number
  wins: number
  wr: number
  share: number  // % от total trades
}

function bucketize(trades: LadderTrade[]): BucketStat[] {
  const total = trades.length
  return BUCKETS.map(b => {
    const inBucket = trades.filter(t => {
      const slPct = (Math.abs(t.entryPrice - t.initialSL) / t.entryPrice) * 100
      return slPct >= b.min && slPct < b.max
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

function printBuckets(label: string, trades: LadderTrade[]) {
  const stats = bucketize(trades)
  const totalN = trades.length
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0)
  const totalRtr = totalN > 0 ? totalR / totalN : 0

  console.log(`=== ${label} (всего: N=${totalN}, R/tr=${fmtR(totalRtr)}, totR=${fmtR(totalR)}) ===`)
  console.log('SL bucket   | trades | share | wins  | totalR  | R/tr  |  WR  ')
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

  // What-if: фильтровать узкие SL — что меняется?
  console.log(`What-if (фильтр по min slDist%):`)
  const filters = [0, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]
  for (const minPct of filters) {
    const kept = trades.filter(t => {
      const slPct = (Math.abs(t.entryPrice - t.initialSL) / t.entryPrice) * 100
      return slPct >= minPct
    })
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
  console.log('Daily Breakout — slDist% breakdown')
  console.log(`32 prod symbols | 365d | range 3h | vol×2.0 | full trailing | fees 0.08% | slip 0.05%`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const allFull: LadderTrade[] = []
  const allTrain: LadderTrade[] = []
  const allTest: LadderTrade[] = []
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
