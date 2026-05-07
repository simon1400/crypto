/**
 * Backtest D1+W1 only (PDH/PDL/PWH/PWL) — без fractals.
 *
 * Гипотеза: торговать только от структурных уровней (вчерашние/прошлой недели
 * экстремумы), убрав 5m/15m/1h fractals. Меньше signals, чище реакции.
 *
 * Сравниваем 3 варианта:
 *   1. ALL (как сейчас в prod) — все sources
 *   2. D1+W1 only — только PDH/PDL/PWH/PWL
 *   3. D1+W1+H1 — компромисс (без 5m/15m fractals)
 *
 * Walk-forward TRAIN (60%) / TEST (40%).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_d1w1_only.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config, LevelSourceV2,
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

const SOURCES: Record<string, LevelSourceV2[]> = {
  ALL:        ['PDH', 'PDL', 'PWH', 'PWL', 'FRACTAL_HIGH', 'FRACTAL_LOW', 'FRACTAL_HIGH_M15', 'FRACTAL_LOW_M15', 'FRACTAL_HIGH_H1', 'FRACTAL_LOW_H1'],
  D1_W1:      ['PDH', 'PDL', 'PWH', 'PWL'],
  D1_W1_H1:   ['PDH', 'PDL', 'PWH', 'PWL', 'FRACTAL_HIGH_H1', 'FRACTAL_LOW_H1'],
}

function buildCfg(tpMinAtr: number, allowedSources: LevelSourceV2[]): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12, allowRangePlay: false,
    fiboMode: 'filter', fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr, minRR: 0, maxRR: 8, excludeKillzones: ['NY_PM'],
    allowedSources,
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

function runOne(data: LoadedData, c: RunCase, sources: LevelSourceV2[], periodFrom?: number, periodTo?: number): LadderTrade[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0, sources)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const fromTime = periodFrom ?? cutoff
  const toTime = periodTo ?? Date.now()
  const periodCandles = ltf.filter(c => c.time >= fromTime && c.time <= toTime)

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    if (ltf[i].time < fromTime || ltf[i].time > toTime) continue
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

interface Stat { n: number; totalR: number; rPerTr: number; wr: number }
function summarize(trades: LadderTrade[]): Stat {
  if (trades.length === 0) return { n: 0, totalR: 0, rPerTr: 0, wr: 0 }
  let totalR = 0, wins = 0
  for (const t of trades) { totalR += t.pnlR; if (t.pnlR > 0) wins++ }
  return { n: trades.length, totalR, rPerTr: totalR / trades.length, wr: (wins / trades.length) * 100 }
}

function fmtStat(s: Stat): string {
  if (s.n === 0) return '       no trades              '
  return `N=${s.n.toString().padStart(3)} R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)} totR=${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(0).padStart(4)} WR=${s.wr.toFixed(0)}%`
}

async function main() {
  console.log('Backtest: ALL sources vs D1+W1 only vs D1+W1+H1 (компромисс)')
  console.log(`Период: 365d, TRAIN=${(TRAIN_PCT*100).toFixed(0)}%, TEST=${((1-TRAIN_PCT)*100).toFixed(0)}%`)
  console.log()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const trainCutoffTime = Date.now() - (DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const now = Date.now()

  const dataMap: Record<string, LoadedData> = {}
  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`  ${c.symbol}: load fail, skip`); continue }
    dataMap[c.symbol] = data
  }

  for (const [sourcesKey, sources] of Object.entries(SOURCES)) {
    console.log('\n' + '='.repeat(140))
    console.log(`SOURCES = ${sourcesKey}  (${sources.length} types: ${sources.join(', ')})`)
    console.log('='.repeat(140))
    console.log('Symbol            Side    FULL                                 TRAIN                                TEST                                 Δ R/tr')
    console.log('-'.repeat(140))

    let totalFull: LadderTrade[] = []
    let totalTrain: LadderTrade[] = []
    let totalTest: LadderTrade[] = []

    for (const c of CASES) {
      const data = dataMap[c.symbol]
      if (!data) continue
      const full = runOne(data, c, sources, fullStart, now)
      const train = runOne(data, c, sources, fullStart, trainCutoffTime)
      const test = runOne(data, c, sources, trainCutoffTime, now)
      totalFull.push(...full)
      totalTrain.push(...train)
      totalTest.push(...test)
      const trainStat = summarize(train)
      const testStat = summarize(test)
      const fullStat = summarize(full)
      const delta = (trainStat.n > 0 && testStat.n > 0) ? testStat.rPerTr - trainStat.rPerTr : 0
      console.log(`${c.symbol.padEnd(15)} ${c.side.padEnd(5)}   ${fmtStat(fullStat).padEnd(36)} ${fmtStat(trainStat).padEnd(36)} ${fmtStat(testStat).padEnd(36)} ${(delta >= 0 ? '+' : '') + delta.toFixed(2)}`)
    }

    console.log('-'.repeat(140))
    const fp = summarize(totalFull)
    const tp = summarize(totalTrain)
    const ep = summarize(totalTest)
    console.log(`PORTFOLIO              ${fmtStat(fp).padEnd(36)} ${fmtStat(tp).padEnd(36)} ${fmtStat(ep).padEnd(36)} ${(ep.rPerTr - tp.rPerTr >= 0 ? '+' : '') + (ep.rPerTr - tp.rPerTr).toFixed(2)}`)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
