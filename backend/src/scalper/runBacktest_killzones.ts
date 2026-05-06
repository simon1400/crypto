/**
 * Killzone backtest: split each signal by UTC hour-of-entry into 4 sessions and
 * report R/tr per session per setup + portfolio.
 *
 *   Asian KZ:    23:00-04:00 UTC (5h) — Tokyo/HK open, usually low-volume range
 *   London KZ:   06:00-09:00 UTC (3h) — judas swings, highest scalp edge
 *   NY KZ:       12:00-15:00 UTC (3h) — US data, continuation/reversal
 *   NY PM:       15:00-17:00 UTC (2h) — London close, mid-day
 *   Off-hours:   everything else
 *
 * Goal: find session-specific edge. If London/NY have R/tr much higher than Asian,
 * we add a time filter to the production scanner.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_killzones.ts
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

interface RunCase { symbol: string; side: 'BUY' | 'SELL' | 'BOTH'; tpMinAtr?: number }

const CASES: RunCase[] = [
  { symbol: 'BTCUSDT', side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'SEIUSDT', side: 'SELL' },
  { symbol: 'WIFUSDT', side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'SOLUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ARBUSDT', side: 'SELL' },
  { symbol: 'AVAXUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT', side: 'SELL' },
  { symbol: 'HYPEUSDT', side: 'BUY', tpMinAtr: 0.5 },
  { symbol: 'ENAUSDT', side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'AAVEUSDT', side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'STRKUSDT', side: 'SELL' },
  { symbol: 'BLURUSDT', side: 'SELL' },
  { symbol: 'CRVUSDT', side: 'SELL', tpMinAtr: 0.5 },
]

type Session = 'ASIAN' | 'LONDON' | 'NY' | 'NY_PM' | 'OFF'

function sessionOf(unixMs: number): Session {
  const hour = new Date(unixMs).getUTCHours()
  // Asian: 23:00-04:00 UTC (wraps midnight)
  if (hour >= 23 || hour < 4) return 'ASIAN'
  if (hour >= 6 && hour < 9) return 'LONDON'
  if (hour >= 12 && hour < 15) return 'NY'
  if (hour >= 15 && hour < 17) return 'NY_PM'
  return 'OFF'
}

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

function runOne(data: LoadedData, c: RunCase): LadderTrade[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigByIdx.set(i, {
      side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason,
    })
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0008,
  }
  return runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
}

interface Bucket {
  trades: number
  totalR: number
  wins: number
}
function newBucket(): Bucket { return { trades: 0, totalR: 0, wins: 0 } }
function addToBucket(b: Bucket, t: LadderTrade) {
  b.trades++
  b.totalR += t.pnlR
  if (t.pnlR > 0) b.wins++
}
function fmtBucket(b: Bucket): string {
  if (b.trades === 0) return '   no trades'
  const evVal = b.totalR / b.trades
  const wr = (b.wins / b.trades) * 100
  return `N=${b.trades.toString().padStart(3)}  R/tr=${(evVal >= 0 ? '+' : '') + evVal.toFixed(2)}  totR=${(b.totalR >= 0 ? '+' : '') + b.totalR.toFixed(0)}  WR=${wr.toFixed(0)}%`
}

async function main() {
  console.log('Killzone backtest — 365d, 15 production setups\n')
  console.log('Sessions (UTC):  Asian 23-04 · London 06-09 · NY 12-15 · NY PM 15-17 · Off other\n')

  const portfolioBuckets: Record<Session, Bucket> = {
    ASIAN: newBucket(), LONDON: newBucket(), NY: newBucket(), NY_PM: newBucket(), OFF: newBucket(),
  }

  console.log('Per-symbol R/tr by session:')
  console.log('Symbol          Side  | Asian            | London           | NY               | NY PM            | Off              | TOTAL')
  console.log('-'.repeat(155))

  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.log(`${c.symbol} SKIP`); continue }
    const trades = runOne(data, c)

    const buckets: Record<Session, Bucket> = {
      ASIAN: newBucket(), LONDON: newBucket(), NY: newBucket(), NY_PM: newBucket(), OFF: newBucket(),
    }
    for (const t of trades) {
      const sess = sessionOf(t.entryTime)
      addToBucket(buckets[sess], t)
      addToBucket(portfolioBuckets[sess], t)
    }
    const totalBucket = newBucket()
    for (const t of trades) addToBucket(totalBucket, t)

    function cell(b: Bucket): string {
      if (b.trades === 0) return '  -  '.padEnd(16)
      const ev = b.totalR / b.trades
      return `N=${b.trades.toString().padStart(3)} R/tr=${(ev >= 0 ? '+' : '') + ev.toFixed(2)}`.padEnd(16)
    }
    console.log(
      `${c.symbol.padEnd(14)} ${c.side.padEnd(5)} | ${cell(buckets.ASIAN)} | ${cell(buckets.LONDON)} | ${cell(buckets.NY)} | ${cell(buckets.NY_PM)} | ${cell(buckets.OFF)} | ${cell(totalBucket)}`
    )
  }

  console.log('\n=== PORTFOLIO TOTALS BY SESSION ===\n')
  console.log(`Asian   : ${fmtBucket(portfolioBuckets.ASIAN)}`)
  console.log(`London  : ${fmtBucket(portfolioBuckets.LONDON)}`)
  console.log(`NY      : ${fmtBucket(portfolioBuckets.NY)}`)
  console.log(`NY PM   : ${fmtBucket(portfolioBuckets.NY_PM)}`)
  console.log(`Off-hrs : ${fmtBucket(portfolioBuckets.OFF)}`)

  // Ranking
  const ranked: { sess: Session; ev: number; b: Bucket }[] = []
  for (const sess of ['ASIAN','LONDON','NY','NY_PM','OFF'] as Session[]) {
    const b = portfolioBuckets[sess]
    if (b.trades > 0) ranked.push({ sess, ev: b.totalR / b.trades, b })
  }
  ranked.sort((a, b) => b.ev - a.ev)
  console.log('\n=== RANK BY R/tr ===')
  for (const r of ranked) {
    console.log(`${r.sess.padEnd(8)} R/tr=${(r.ev >= 0 ? '+' : '') + r.ev.toFixed(2)}  totR=${(r.b.totalR >= 0 ? '+' : '') + r.b.totalR.toFixed(0)}  N=${r.b.trades}`)
  }

  // Hybrid simulation: take only sessions with R/tr > overall avg
  const totalTrades = ranked.reduce((a, r) => a + r.b.trades, 0)
  const totalR = ranked.reduce((a, r) => a + r.b.totalR, 0)
  const overallEv = totalR / totalTrades
  console.log(`\nOverall portfolio: N=${totalTrades} totR=${totalR.toFixed(0)} R/tr=${overallEv.toFixed(2)}`)

  console.log('\n=== HYPOTHETICAL FILTER: take only sessions with R/tr > 1.5x overall ===')
  const threshold = overallEv * 1.5
  let filtN = 0, filtR = 0
  const keptSess: Session[] = []
  for (const r of ranked) {
    if (r.ev > threshold) {
      filtN += r.b.trades
      filtR += r.b.totalR
      keptSess.push(r.sess)
    }
  }
  if (filtN > 0) {
    console.log(`Keep: ${keptSess.join(', ')}`)
    console.log(`Filtered: N=${filtN} totR=${filtR.toFixed(0)} R/tr=${(filtR / filtN).toFixed(2)}`)
    console.log(`Edge improvement: R/tr ${overallEv.toFixed(2)} → ${(filtR / filtN).toFixed(2)} (Δ ${(filtR / filtN - overallEv >= 0 ? '+' : '') + (filtR / filtN - overallEv).toFixed(2)})`)
    console.log(`Trade count loss: ${totalTrades} → ${filtN} (-${((1 - filtN / totalTrades) * 100).toFixed(0)}%)`)
  } else {
    console.log('No session is significantly better than average — no filter recommended.')
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
