/**
 * Per-setup breakdown TRAIN vs TEST: какие setups сломались в последние 146 дней?
 *
 * Для каждого setup'а считаем R/tr, WR, totalR раздельно в TRAIN (60%) и TEST (40%).
 * Без portfolio simulation — просто per-symbol single-side backtest как в killzones script.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_setup_breakdown.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

interface RunCase { symbol: string; side: 'BUY' | 'SELL' | 'BOTH'; tpMinAtr?: number }

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'SEIUSDT',      side: 'SELL' },
  { symbol: 'WIFUSDT',      side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'SOLUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ARBUSDT',      side: 'SELL' },
  { symbol: 'AVAXUSDT',     side: 'SELL', tpMinAtr: 1.0 },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT',      side: 'SELL' },
  { symbol: 'HYPEUSDT',     side: 'BUY',  tpMinAtr: 0.5 },
  { symbol: 'ENAUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'AAVEUSDT',     side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'STRKUSDT',     side: 'SELL' },
  { symbol: 'BLURUSDT',     side: 'SELL' },
  { symbol: 'CRVUSDT',      side: 'SELL', tpMinAtr: 0.5 },
]

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
    minRR: 0, maxRR: 8,
    excludeKillzones: ['NY_PM'],
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5 = await loadHistorical(symbol, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1 = await loadHistorical(symbol, '1h', MONTHS_BACK, 'bybit', 'linear')
    const d1 = await loadHistorical(symbol, '1d', MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch { return null }
}

function runOne(data: LoadedData, c: RunCase, periodFrom?: number, periodTo?: number): LadderTrade[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  // Slice candles to selected period (если указан) — это даст ladder backtest fresh state на каждом периоде
  const fromTime = periodFrom ?? cutoff
  const toTime = periodTo ?? Date.now()
  const periodCandles = ltf.filter(c => c.time >= fromTime && c.time <= toTime)

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  // Replay state на ВСЕХ свечах от cutoff чтобы правильно собрать levels state, но сигналы фиксируем только в selected period
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    if (ltf[i].time < fromTime || ltf[i].time > toTime) continue
    // Map time-based index to periodCandles array index
    const periodIdx = periodCandles.findIndex(pc => pc.time === ltf[i].time)
    if (periodIdx < 0) continue
    sigByIdx.set(periodIdx, {
      side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
    })
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0008,
  }
  return runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface Stat { n: number; totalR: number; rPerTr: number; wr: number; longN: number; shortN: number }
function summarize(trades: LadderTrade[]): Stat {
  if (trades.length === 0) return { n: 0, totalR: 0, rPerTr: 0, wr: 0, longN: 0, shortN: 0 }
  let totalR = 0, wins = 0, longN = 0, shortN = 0
  for (const t of trades) {
    totalR += t.pnlR
    if (t.pnlR > 0) wins++
    if (t.side === 'BUY') longN++; else shortN++
  }
  return { n: trades.length, totalR, rPerTr: totalR / trades.length, wr: (wins / trades.length) * 100, longN, shortN }
}

function fmtStat(s: Stat): string {
  if (s.n === 0) return '       no trades              '
  return `N=${s.n.toString().padStart(3)} R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)} totR=${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(0).padStart(4)} WR=${s.wr.toFixed(0)}%`
}

async function main() {
  console.log('Per-setup breakdown — TRAIN/TEST walk-forward')
  console.log(`Период: 365d, TRAIN=${(TRAIN_PCT*100).toFixed(0)}% (~219d), TEST=${((1-TRAIN_PCT)*100).toFixed(0)}% (~146d)`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainCutoffTime = Date.now() - (DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  console.log('Symbol            Side    TRAIN                                TEST                                 Δ R/tr')
  console.log('-'.repeat(120))

  const portfolio = { trainTrades: [] as LadderTrade[], testTrades: [] as LadderTrade[] }
  const breakdowns: Array<{ c: RunCase; train: Stat; test: Stat; deltaRPerTr: number }> = []

  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.log(`${c.symbol.padEnd(15)} SKIP (load fail)`); continue }
    // Раздельные ladder runs для TRAIN и TEST (fresh state)
    const train = runOne(data, c, fullStart, trainCutoffTime)
    const test = runOne(data, c, trainCutoffTime, now)
    portfolio.trainTrades.push(...train)
    portfolio.testTrades.push(...test)
    const trainStat = summarize(train)
    const testStat = summarize(test)
    const deltaRPerTr = (trainStat.n > 0 && testStat.n > 0) ? testStat.rPerTr - trainStat.rPerTr : 0
    breakdowns.push({ c, train: trainStat, test: testStat, deltaRPerTr })
    const arrow = deltaRPerTr < -0.5 ? ' ⚠️ collapse' : deltaRPerTr < -0.2 ? ' ⚠ degraded' : deltaRPerTr > 0.2 ? ' ↑ better' : ''
    console.log(`${c.symbol.padEnd(15)} ${c.side.padEnd(5)}   ${fmtStat(trainStat).padEnd(36)} ${fmtStat(testStat).padEnd(36)} ${(deltaRPerTr >= 0 ? '+' : '') + deltaRPerTr.toFixed(2)}${arrow}`)
  }

  console.log('-'.repeat(120))
  const trainP = summarize(portfolio.trainTrades)
  const testP = summarize(portfolio.testTrades)
  console.log(`PORTFOLIO              ${fmtStat(trainP).padEnd(36)} ${fmtStat(testP).padEnd(36)} ${(testP.rPerTr - trainP.rPerTr >= 0 ? '+' : '') + (testP.rPerTr - trainP.rPerTr).toFixed(2)}`)

  // Top collapsed setups (worst delta)
  const collapsed = [...breakdowns]
    .filter(b => b.train.n >= 5 && b.test.n >= 5)
    .sort((a, b) => a.deltaRPerTr - b.deltaRPerTr)
    .slice(0, 5)
  console.log('\n=== ТОП-5 setups развалились в TEST ===')
  for (const b of collapsed) {
    const totRDelta = b.test.totalR - b.train.totalR
    console.log(`  ${b.c.symbol.padEnd(15)} ${b.c.side.padEnd(5)}  TRAIN R/tr=${b.train.rPerTr.toFixed(2)}  TEST R/tr=${b.test.rPerTr.toFixed(2)}  Δ ${(b.deltaRPerTr >= 0 ? '+' : '') + b.deltaRPerTr.toFixed(2)} R/tr`)
  }

  // Setups стабильно работающие
  const stable = breakdowns
    .filter(b => b.train.n >= 5 && b.test.n >= 5 && b.train.rPerTr > 0 && b.test.rPerTr > 0)
    .sort((a, b) => b.test.rPerTr - a.test.rPerTr)
    .slice(0, 5)
  console.log('\n=== ТОП-5 setups стабильны (плюс в TRAIN и TEST) ===')
  for (const b of stable) {
    console.log(`  ${b.c.symbol.padEnd(15)} ${b.c.side.padEnd(5)}  TRAIN R/tr=${b.train.rPerTr.toFixed(2)} (n=${b.train.n})  TEST R/tr=${b.test.rPerTr.toFixed(2)} (n=${b.test.n})`)
  }

  // Setups катастрофически плохие в TEST (R/tr < -0.5)
  const collapsed2 = breakdowns
    .filter(b => b.test.n >= 5 && b.test.rPerTr < -0.3)
    .sort((a, b) => a.test.rPerTr - b.test.rPerTr)
  console.log('\n=== Setups в TEST с R/tr < -0.3 (нужно исключить?) ===')
  for (const b of collapsed2) {
    console.log(`  ${b.c.symbol.padEnd(15)} ${b.c.side.padEnd(5)}  TEST: N=${b.test.n} R/tr=${b.test.rPerTr.toFixed(2)} totR=${b.test.totalR.toFixed(0)}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
