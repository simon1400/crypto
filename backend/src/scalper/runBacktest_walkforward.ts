/**
 * Walk-forward validation for MARKET vs LIMIT_REALISTIC entry modes.
 *
 * Splits the 365d window into 2 halves:
 *   - TRAIN: oldest ~180d (months 7-12 ago) — what we used to "decide" the strategy
 *   - TEST:  newest ~180d (months 0-6 ago)  — out-of-sample validation
 *
 * For each setup, runs both MARKET and LIMIT_REALISTIC on TRAIN and TEST separately.
 * Reports R/tr and totalR per period. We're looking for setups where the chosen mode
 * (LIMIT or MARKET) keeps a positive edge across BOTH periods — that's a stable edge.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_walkforward.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config, findImpulse, isInFiboZone,
  buildLadder, nearestOpposite,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal,
} from './ladderBacktester'

const TOTAL_DAYS = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const PENDING_VALID_BARS = 12
const CONFIRM_WINDOW = 3
const COOLDOWN_BARS = 12

type Side = 'BUY' | 'SELL' | 'BOTH'
type EntryMode = 'MARKET' | 'LIMIT_REALISTIC'

interface RunCase {
  symbol: string
  side: Side
  tpMinAtr?: number
}

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
]

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface PeriodResult {
  trades: number
  totalR: number
  rPerTrade: number
  winRate: number
  pf: number
}

interface CaseResult {
  symbol: string
  side: Side
  trainMarket: PeriodResult
  trainLimit: PeriodResult
  testMarket: PeriodResult
  testLimit: PeriodResult
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5  = await loadHistorical(symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1  = await loadHistorical(symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
    const d1  = await loadHistorical(symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch (e: any) {
    console.warn(`[${symbol}] load failed: ${e.message}`)
    return null
  }
}

function computeStats(trades: any[]): PeriodResult {
  const wins = trades.filter((t) => t.pnlR > 0)
  const losses = trades.filter((t) => t.pnlR < 0)
  const totalWinR = wins.reduce((a, t) => a + t.pnlR, 0)
  const totalLossR = Math.abs(losses.reduce((a, t) => a + t.pnlR, 0))
  const totalR = trades.reduce((a, t) => a + t.pnlR, 0)
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? Infinity : 0)
  const ev = trades.length > 0 ? totalR / trades.length : 0
  return { trades: trades.length, totalR, rPerTrade: ev, winRate, pf }
}

/**
 * Run MARKET mode for trades whose entryTime falls in [tStart, tEnd]
 */
function runMarketWindow(data: LoadedData, c: RunCase, tStart: number, tEnd: number): PeriodResult {
  const ltf = sliceLastDays(data.m5, TOTAL_DAYS)
  const mtf = sliceLastDays(data.m15, TOTAL_DAYS)
  const htf = sliceLastDays(data.h1, TOTAL_DAYS)
  const dly = sliceLastDays(data.d1, TOTAL_DAYS)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - TOTAL_DAYS * 24 * 60 * 60_000

  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    // Only keep signals whose entry time is in the requested window
    if (s.entryTime < tStart || s.entryTime > tEnd) continue
    sigByIdx.set(i, { side: s.side, entryTime: s.entryTime, entryPrice: s.entryPrice,
      sl: s.slPrice, tpLadder: s.tpLadder, reason: s.reason })
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0008,
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)
  return computeStats(r.trades)
}

interface PendingLimit {
  level: number
  side: 'BUY' | 'SELL'
  source: string
  createdIdx: number
  filledIdx: number | null
}

function runLimitWindow(data: LoadedData, c: RunCase, tStart: number, tEnd: number): PeriodResult {
  const ltf = sliceLastDays(data.m5, TOTAL_DAYS)
  const mtf = sliceLastDays(data.m15, TOTAL_DAYS)
  const htf = sliceLastDays(data.h1, TOTAL_DAYS)
  const dly = sliceLastDays(data.d1, TOTAL_DAYS)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - TOTAL_DAYS * 24 * 60 * 60_000

  const allowedSet = new Set(cfg.allowedSources)
  const allowedSides: Array<'BUY' | 'SELL'> = c.side === 'BOTH' ? ['BUY', 'SELL']
    : c.side === 'BUY' ? ['BUY'] : ['SELL']

  const pendings = new Map<string, PendingLimit>()
  const lastFiredAt = new Map<string, number>()
  const sigByIdx = new Map<number, LadderSignal>()

  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const cur = ltf[i]
    const atr = pre.atr[i]
    if (!isFinite(atr) || atr <= 0) continue
    const activeIdxs = pre.activeAt[i] ?? []
    if (activeIdxs.length === 0) continue
    const impulse = findImpulse(ltf, i, cfg.fiboImpulseLookback, cfg.fiboImpulseMinAtr, atr)

    const priceSet = new Map<string, number>()
    for (const li of activeIdxs) {
      const lvl = pre.levels[li]
      if (!allowedSet.has(lvl.source)) continue
      priceSet.set(lvl.price.toFixed(2), lvl.price)
    }
    const allPrices = [...priceSet.values()]

    if (impulse) {
      for (const li of activeIdxs) {
        const lvl = pre.levels[li]
        if (!allowedSet.has(lvl.source)) continue
        for (const side of allowedSides) {
          if (!isInFiboZone(lvl.price, side, impulse, cfg.fiboZoneFrom, cfg.fiboZoneTo, 0)) continue
          const key = `${side}:${lvl.source}:${lvl.price.toFixed(2)}`
          const last = lastFiredAt.get(key)
          if (last !== undefined && i - last < COOLDOWN_BARS) continue
          if (pendings.has(key)) continue
          if (side === 'BUY' && lvl.price >= cur.close) continue
          if (side === 'SELL' && lvl.price <= cur.close) continue
          pendings.set(key, { level: lvl.price, side, source: lvl.source, createdIdx: i, filledIdx: null })
        }
      }
    }

    const toRemove: string[] = []
    for (const [key, p] of pendings) {
      const age = i - p.createdIdx
      if (p.filledIdx === null) {
        if (age > PENDING_VALID_BARS) { toRemove.push(key); continue }
        const pierceDist = atr * cfg.pierceMinAtr
        if (p.side === 'BUY' && cur.close < p.level - pierceDist) { toRemove.push(key); continue }
        if (p.side === 'SELL' && cur.close > p.level + pierceDist) { toRemove.push(key); continue }
        const filled_ = p.side === 'BUY' ? cur.low <= p.level : cur.high >= p.level
        if (filled_) p.filledIdx = i
        continue
      }
      const sinceFill = i - p.filledIdx
      if (sinceFill > CONFIRM_WINDOW) { toRemove.push(key); continue }
      const pierceDist = atr * cfg.pierceMinAtr
      if (p.side === 'BUY' && cur.close < p.level - pierceDist) { toRemove.push(key); continue }
      if (p.side === 'SELL' && cur.close > p.level + pierceDist) { toRemove.push(key); continue }
      const minReturn = atr * cfg.reactionMinReturnAtr
      const conf = p.side === 'BUY' ? cur.close >= p.level + minReturn : cur.close <= p.level - minReturn
      if (conf) {
        const opp = nearestOpposite(p.side, p.level, allPrices)
        const slBuf = atr * cfg.slBufferAtr
        const sl = opp !== null
          ? (p.side === 'BUY' ? opp - slBuf : opp + slBuf)
          : (p.side === 'BUY' ? p.level - atr * cfg.fallbackSlAtr : p.level + atr * cfg.fallbackSlAtr)
        const tpLadder = buildLadder(p.side, p.level, p.level, allPrices, atr * cfg.tpMinAtr)
        if ((p.side === 'BUY' && sl < p.level) || (p.side === 'SELL' && sl > p.level)) {
          if (tpLadder.length > 0) {
            const fillBarIdx = p.filledIdx
            const fillTime = ltf[fillBarIdx].time
            // Only register signals whose FILL time is in window
            if (fillTime >= tStart && fillTime <= tEnd) {
              sigByIdx.set(fillBarIdx, {
                side: p.side, entryTime: fillTime, entryPrice: p.level,
                sl, tpLadder, reason: `LIMIT @ ${p.source} ${p.level.toFixed(4)}`,
              })
            }
            lastFiredAt.set(key, i)
          }
        }
        toRemove.push(key)
      }
    }
    for (const k of toRemove) pendings.delete(k)
  }

  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER, exitMode: 'wick', splits: [0.5, 0.3, 0.2],
    trailing: true, feesRoundTrip: 0.0004,
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)
  return computeStats(r.trades)
}

function fmt(p: PeriodResult): string {
  if (p.trades === 0) return '   (no trades)'
  return `N=${p.trades.toString().padStart(3)} R/tr=${(p.rPerTrade >= 0 ? '+' : '') + p.rPerTrade.toFixed(2)} totR=${(p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(0)}`
}

async function main() {
  const now = Date.now()
  const sixMonthsMs = 180 * 24 * 60 * 60_000
  const totalStart = now - TOTAL_DAYS * 24 * 60 * 60_000
  const splitTime = now - sixMonthsMs

  console.log(`Walk-forward validation: TRAIN [${new Date(totalStart).toISOString().slice(0, 10)} → ${new Date(splitTime).toISOString().slice(0, 10)}], TEST [${new Date(splitTime).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)}]\n`)

  const allResults: CaseResult[] = []
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.side} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`SKIP`); continue }

    const trainMarket = runMarketWindow(data, c, totalStart, splitTime)
    const trainLimit = runLimitWindow(data, c, totalStart, splitTime)
    const testMarket = runMarketWindow(data, c, splitTime, now)
    const testLimit = runLimitWindow(data, c, splitTime, now)

    const cr: CaseResult = { symbol: c.symbol, side: c.side, trainMarket, trainLimit, testMarket, testLimit }
    allResults.push(cr)

    console.log(`  TRAIN MARKET:   ${fmt(trainMarket)}`)
    console.log(`  TRAIN LIMIT:    ${fmt(trainLimit)}`)
    console.log(`  TEST  MARKET:   ${fmt(testMarket)}`)
    console.log(`  TEST  LIMIT:    ${fmt(testLimit)}`)
  }

  console.log('\n\n========== WALK-FORWARD SUMMARY ==========\n')
  console.log('Stable LIMIT edge requires: TRAIN R/tr > MARKET TRAIN R/tr AND TEST R/tr > MARKET TEST R/tr (both periods better)')
  console.log('Stable MARKET: opposite. UNSTABLE = LIMIT wins one period, MARKET the other → don\'t trust\n')

  console.log('Symbol           Side   | TRAIN: M vs L            | TEST: M vs L             | Stability')
  console.log('-'.repeat(110))

  const stableLimits: string[] = []
  const stableMarkets: string[] = []
  const unstable: string[] = []

  for (const r of allResults) {
    const trMd = r.trainMarket.rPerTrade
    const trLd = r.trainLimit.rPerTrade
    const teMd = r.testMarket.rPerTrade
    const teLd = r.testLimit.rPerTrade

    const trainLimitBetter = trLd > trMd && r.trainLimit.trades >= 5
    const testLimitBetter = teLd > teMd && r.testLimit.trades >= 5
    const trainMarketBetter = trMd > trLd && r.trainMarket.trades >= 5
    const testMarketBetter = teMd > teLd && r.testMarket.trades >= 5

    let stability: string
    if (trainLimitBetter && testLimitBetter) {
      stability = '★ STABLE LIMIT'
      stableLimits.push(r.symbol)
    } else if (trainMarketBetter && testMarketBetter) {
      stability = '★ STABLE MARKET'
      stableMarkets.push(r.symbol)
    } else {
      stability = '⚠ UNSTABLE → MARKET (safe)'
      unstable.push(r.symbol)
    }

    const trStr = `M:${(trMd >= 0 ? '+' : '') + trMd.toFixed(2)}/L:${(trLd >= 0 ? '+' : '') + trLd.toFixed(2)}`
    const teStr = `M:${(teMd >= 0 ? '+' : '') + teMd.toFixed(2)}/L:${(teLd >= 0 ? '+' : '') + teLd.toFixed(2)}`
    console.log(`${r.symbol.padEnd(15)} ${r.side.padEnd(6)} | ${trStr.padEnd(24)} | ${teStr.padEnd(24)} | ${stability}`)
  }

  console.log('\n=== HYBRID RECOMMENDATION (only stable edges) ===')
  console.log(`USE LIMIT for:   ${stableLimits.join(', ') || '(none)'}`)
  console.log(`USE MARKET for:  ${stableMarkets.join(', ') || '(none)'}`)
  console.log(`UNSTABLE (default to MARKET): ${unstable.join(', ') || '(none)'}`)

  // Compute hybrid portfolio TEST-period totals
  let hybridTestR = 0, marketTestR = 0
  let hybridTrainR = 0, marketTrainR = 0
  for (const r of allResults) {
    const useLimit = stableLimits.includes(r.symbol)
    hybridTestR += useLimit ? r.testLimit.totalR : r.testMarket.totalR
    hybridTrainR += useLimit ? r.trainLimit.totalR : r.trainMarket.totalR
    marketTestR += r.testMarket.totalR
    marketTrainR += r.trainMarket.totalR
  }
  console.log(`\nPortfolio totals:`)
  console.log(`  TRAIN: hybrid=${hybridTrainR.toFixed(0)}R, all-MARKET=${marketTrainR.toFixed(0)}R, edge=${(hybridTrainR - marketTrainR).toFixed(0)}R`)
  console.log(`  TEST:  hybrid=${hybridTestR.toFixed(0)}R, all-MARKET=${marketTestR.toFixed(0)}R, edge=${(hybridTestR - marketTestR).toFixed(0)}R`)
  console.log(`\nIf TEST edge > 0 → hybrid LIMIT strategy is validated out-of-sample. If TEST edge < 0 → don't use LIMIT.`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `walkforward_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults, stableLimits, stableMarkets, unstable }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
