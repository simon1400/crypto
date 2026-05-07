/**
 * Cross-side block backtest (Идея 1):
 *
 * Правило: на сетапах с side='BOTH' (BTC, ENA), новый сигнал в противоположную
 * сторону блокируется ПОКА предыдущий трейд не достиг TP1 (после TP1 SL переезжает
 * в BE → встречный больше не угрожает депо).
 *
 * Цель: проверить как этот фильтр влияет на edge BOTH-сетапов в 365d.
 *
 * Метод:
 *   1. Для каждого BOTH-сетапа сгенерировать ВСЕ сигналы (BUY и SELL) через
 *      precomputeLevelsV2 + generateSignalV2.
 *   2. Прогнать кастомный симулятор который:
 *      - открывает позицию на сигнале если не блокируется встречной активной
 *      - блокировка снимается как только предыдущая позиция достигает TP1 (fills[0])
 *      - также обычная single-side-position constraint (как baseline)
 *   3. Сравнить baseline (без cross-side filter) vs filtered (с cross-side filter).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_crossside_block.ts
 */

import 'dotenv/config'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

interface RunCase {
  symbol: string
  side: 'BUY' | 'SELL' | 'BOTH'
  tpMinAtr?: number
}

// Production setups — focus on BOTH сетапы (где проблема), плюс несколько одноcторонних
// для контроля (на них фильтр не должен ничего менять).
const CASES: RunCase[] = [
  { symbol: 'BTCUSDT',  side: 'BOTH', tpMinAtr: 1.5 },  // ★ BOTH
  { symbol: 'ENAUSDT',  side: 'BOTH', tpMinAtr: 1.5 },  // ★ BOTH
  // Контрольные одноcторонние (cross-side filter не должен их затронуть):
  { symbol: 'AAVEUSDT', side: 'SELL', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT',  side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'AVAXUSDT', side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ETHUSDT',  side: 'SELL' },
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

// =====================================================================
// Кастомный симулятор: similar to ladderBacktester, но:
//   - возвращает массив "событий" trade'ов (entry, tp1_time, exit) для cross-side анализа
//   - allows two concurrent positions: один BUY, один SELL (для BOTH-сетапов)
//   - при baseline-режиме: позволяет любой кросс-сигнал
//   - при filtered-режиме: блокирует встречный пока активный не достиг TP1
// =====================================================================

interface Sig {
  idx: number
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
}

interface SimTrade {
  side: 'BUY' | 'SELL'
  entryTime: number
  entryIdx: number
  entryPrice: number
  initialSL: number
  riskPerUnit: number
  tpLadder: number[]
  exitTime: number
  exitIdx: number
  exitReason: 'SL' | 'LADDER_DONE' | 'EOD'
  fills: Array<{ tpIdx: number; fillIdx: number; fillTime: number; price: number; frac: number; rContrib: number }>
  pnlR: number
  reachedTp1: boolean
  tp1Time?: number
}

const SPLITS = [0.5, 0.3, 0.2]
const FEES_RT = 0.0008

interface OpenPos {
  sig: Sig
  fillPrice: number
  initialSL: number
  trailingSL: number
  risk: number
  openIdx: number
  nextTpIdx: number
  remainingFrac: number
  splits: number[]
  fills: SimTrade['fills']
  reachedTp1: boolean
  tp1Time?: number
}

function alignSplits(ladderLen: number): number[] {
  if (ladderLen <= 0) return []
  if (ladderLen >= SPLITS.length) {
    const out = [...SPLITS, ...new Array(ladderLen - SPLITS.length).fill(0)]
    const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
    out[out.length - 1] = Math.max(0, 1 - used)
    return out
  }
  const out = SPLITS.slice(0, ladderLen)
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[out.length - 1] = Math.max(0, 1 - used)
  return out
}

function closePos(pos: OpenPos, exitTime: number, exitIdx: number, reason: SimTrade['exitReason']): SimTrade {
  const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
  const feeR = (pos.fillPrice * FEES_RT) / pos.risk
  return {
    side: pos.sig.side,
    entryTime: pos.sig.entryTime,
    entryIdx: pos.openIdx,
    entryPrice: pos.fillPrice,
    initialSL: pos.initialSL,
    riskPerUnit: pos.risk,
    tpLadder: pos.sig.tpLadder,
    exitTime,
    exitIdx,
    exitReason: reason,
    fills: pos.fills,
    pnlR: Math.round((grossR - feeR) * 10000) / 10000,
    reachedTp1: pos.reachedTp1,
    tp1Time: pos.tp1Time,
  }
}

function processBar(pos: OpenPos, candles: OHLCV[], i: number): SimTrade | null {
  const c = candles[i]
  const isLong = pos.sig.side === 'BUY'

  // 1) SL check
  const slHit = isLong ? c.low <= pos.trailingSL : c.high >= pos.trailingSL
  if (slHit) {
    const exitFill = pos.trailingSL
    const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.risk
    pos.fills.push({ tpIdx: -1, fillIdx: i, fillTime: c.time, price: exitFill, frac: pos.remainingFrac, rContrib })
    pos.remainingFrac = 0
    return closePos(pos, c.time, i, 'SL')
  }

  // 2) Ladder TPs (wick mode)
  let progressed = true
  while (progressed && pos.nextTpIdx < pos.sig.tpLadder.length && pos.remainingFrac > 1e-9) {
    progressed = false
    const tpIdx = pos.nextTpIdx
    const tp = pos.sig.tpLadder[tpIdx]
    const wickReached = isLong ? c.high >= tp : c.low <= tp
    if (!wickReached) break

    const isLastTp = tpIdx === pos.sig.tpLadder.length - 1
    const closeBeyond = isLong ? c.close > tp : c.close < tp
    const fill = !closeBeyond || isLastTp

    if (fill) {
      const frac = pos.splits[tpIdx] ?? 0
      if (frac > 0) {
        const rContrib = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * frac) / pos.risk
        pos.fills.push({ tpIdx, fillIdx: i, fillTime: c.time, price: tp, frac, rContrib })
        pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)

        if (tpIdx === 0) {
          pos.reachedTp1 = true
          pos.tp1Time = c.time
          pos.trailingSL = pos.fillPrice // BE
        } else {
          pos.trailingSL = pos.sig.tpLadder[tpIdx - 1]
        }
      }
      pos.nextTpIdx++
      progressed = true
      if (pos.remainingFrac <= 1e-9) {
        return closePos(pos, c.time, i, 'LADDER_DONE')
      }
    } else {
      // wick reached but close beyond — advance ptr (skip this TP)
      pos.nextTpIdx++
      progressed = true
    }
  }
  return null
}

/**
 * Simulate trades для одного направления (BUY-only или SELL-only).
 * Single-position-at-time per side (как в обычном backtester).
 */
function simulateOneSide(candles: OHLCV[], sigs: Sig[]): SimTrade[] {
  const trades: SimTrade[] = []
  let pos: OpenPos | null = null
  const sigByIdx = new Map<number, Sig>()
  for (const s of sigs) sigByIdx.set(s.idx, s)

  for (let i = 1; i < candles.length; i++) {
    if (pos) {
      const closed = processBar(pos, candles, i)
      if (closed) {
        trades.push(closed)
        pos = null
      }
    }
    if (pos) continue
    const sig = sigByIdx.get(i)
    if (!sig) continue
    const entryFill = sig.entryPrice
    const risk = Math.abs(entryFill - sig.sl)
    if (risk <= 0) continue
    const isLong = sig.side === 'BUY'
    if (isLong && sig.sl >= entryFill) continue
    if (!isLong && sig.sl <= entryFill) continue
    const validLadder = sig.tpLadder.every((p) => isLong ? p > entryFill : p < entryFill)
    if (!validLadder) continue
    pos = {
      sig,
      fillPrice: entryFill,
      initialSL: sig.sl,
      trailingSL: sig.sl,
      risk,
      openIdx: i,
      nextTpIdx: 0,
      remainingFrac: 1,
      splits: alignSplits(sig.tpLadder.length),
      fills: [],
      reachedTp1: false,
    }
  }
  if (pos) {
    const last = candles[candles.length - 1]
    const isLong = pos.sig.side === 'BUY'
    const exitFill = last.close
    const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.risk
    pos.fills.push({ tpIdx: -1, fillIdx: candles.length - 1, fillTime: last.time, price: exitFill, frac: pos.remainingFrac, rContrib })
    trades.push(closePos(pos, last.time, candles.length - 1, 'EOD'))
  }
  return trades
}

/**
 * Симулирует cross-side block с TP1 escape:
 *   - две стороны параллельно (BUY и SELL могут быть открыты)
 *   - НО: новый встречный сигнал блокируется, если текущая позиция в противоположную
 *     сторону НЕ достигла TP1
 *   - same-side: single-position constraint (как baseline)
 */
function simulateBothWithCrossSideBlock(candles: OHLCV[], sigs: Sig[]): { trades: SimTrade[]; blocked: number } {
  const trades: SimTrade[] = []
  let posBuy: OpenPos | null = null
  let posSell: OpenPos | null = null
  let blocked = 0
  const sigByIdx = new Map<number, Sig[]>()
  for (const s of sigs) {
    if (!sigByIdx.has(s.idx)) sigByIdx.set(s.idx, [])
    sigByIdx.get(s.idx)!.push(s)
  }

  for (let i = 1; i < candles.length; i++) {
    if (posBuy) {
      const closed = processBar(posBuy, candles, i)
      if (closed) { trades.push(closed); posBuy = null }
    }
    if (posSell) {
      const closed = processBar(posSell, candles, i)
      if (closed) { trades.push(closed); posSell = null }
    }

    const newSigs = sigByIdx.get(i)
    if (!newSigs) continue

    for (const sig of newSigs) {
      const isLong = sig.side === 'BUY'
      const samePos = isLong ? posBuy : posSell
      const oppPos = isLong ? posSell : posBuy
      if (samePos) continue // single-position-per-side
      // Cross-side block: если встречный открыт и НЕ достиг TP1 — drop
      if (oppPos && !oppPos.reachedTp1) {
        blocked++
        continue
      }
      const entryFill = sig.entryPrice
      const risk = Math.abs(entryFill - sig.sl)
      if (risk <= 0) continue
      if (isLong && sig.sl >= entryFill) continue
      if (!isLong && sig.sl <= entryFill) continue
      const validLadder = sig.tpLadder.every((p) => isLong ? p > entryFill : p < entryFill)
      if (!validLadder) continue
      const newPos: OpenPos = {
        sig,
        fillPrice: entryFill,
        initialSL: sig.sl,
        trailingSL: sig.sl,
        risk,
        openIdx: i,
        nextTpIdx: 0,
        remainingFrac: 1,
        splits: alignSplits(sig.tpLadder.length),
        fills: [],
        reachedTp1: false,
      }
      if (isLong) posBuy = newPos
      else posSell = newPos
    }
  }
  // Close remaining
  for (const pos of [posBuy, posSell]) {
    if (!pos) continue
    const last = candles[candles.length - 1]
    const isLong = pos.sig.side === 'BUY'
    const exitFill = last.close
    const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.risk
    pos.fills.push({ tpIdx: -1, fillIdx: candles.length - 1, fillTime: last.time, price: exitFill, frac: pos.remainingFrac, rContrib })
    trades.push(closePos(pos, last.time, candles.length - 1, 'EOD'))
  }
  return { trades, blocked }
}

/**
 * Baseline для BOTH: две стороны параллельно БЕЗ блокировки (мирится с конфликтами).
 */
function simulateBothNoFilter(candles: OHLCV[], sigs: Sig[]): SimTrade[] {
  const buySigs = sigs.filter((s) => s.side === 'BUY')
  const sellSigs = sigs.filter((s) => s.side === 'SELL')
  return [...simulateOneSide(candles, buySigs), ...simulateOneSide(candles, sellSigs)]
}

function generateSigsForCase(data: LoadedData, c: RunCase): Sig[] {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  const sigs: Sig[] = []
  const state = newSignalState()
  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue
    sigs.push({
      idx: i,
      side: s.side,
      entryTime: s.entryTime,
      entryPrice: s.entryPrice,
      sl: s.slPrice,
      tpLadder: s.tpLadder,
    })
  }
  return sigs
}

function summary(trades: SimTrade[]): { n: number; totalR: number; rPerTr: number; wr: number; longN: number; shortN: number; longR: number; shortR: number } {
  const n = trades.length
  if (n === 0) return { n: 0, totalR: 0, rPerTr: 0, wr: 0, longN: 0, shortN: 0, longR: 0, shortR: 0 }
  let totalR = 0, wins = 0, longN = 0, shortN = 0, longR = 0, shortR = 0
  for (const t of trades) {
    totalR += t.pnlR
    if (t.pnlR > 0) wins++
    if (t.side === 'BUY') { longN++; longR += t.pnlR }
    else { shortN++; shortR += t.pnlR }
  }
  return {
    n, totalR, rPerTr: totalR / n, wr: (wins / n) * 100,
    longN, shortN, longR, shortR,
  }
}

function fmtSummary(label: string, s: ReturnType<typeof summary>): string {
  if (s.n === 0) return `  ${label.padEnd(28)} no trades`
  const longR = s.longN > 0 ? (s.longR / s.longN).toFixed(2) : '-'
  const shortR = s.shortN > 0 ? (s.shortR / s.shortN).toFixed(2) : '-'
  return `  ${label.padEnd(28)} N=${s.n.toString().padStart(3)}  totR=${(s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(0).padStart(4)}  R/tr=${(s.rPerTr >= 0 ? '+' : '') + s.rPerTr.toFixed(2)}  WR=${s.wr.toFixed(0)}%  | LONG N=${s.longN} R/tr=${longR} | SHORT N=${s.shortN} R/tr=${shortR}`
}

async function main() {
  console.log('Cross-side block backtest — Идея 1: блокировать встречный сигнал пока активный не достиг TP1')
  console.log(`Период: 365d, exit mode: wick, ladder 50/30/20, fees RT 0.08%, maxRR=8, excludeKillzones=[NY_PM]`)
  console.log()

  const portfolio = {
    base: { tradesAll: [] as SimTrade[], blocked: 0 },
    filt: { tradesAll: [] as SimTrade[], blocked: 0 },
  }

  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} side=${c.side}${c.tpMinAtr ? ` tpMinAtr=${c.tpMinAtr}` : ''} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.log('  SKIP (load fail)'); continue }
    const sigs = generateSigsForCase(data, c)
    const ltf = sliceLastDays(data.m5, DAYS_BACK)
    console.log(`  Signals generated: ${sigs.length}`)

    if (c.side === 'BOTH') {
      const baseTrades = simulateBothNoFilter(ltf, sigs)
      const filt = simulateBothWithCrossSideBlock(ltf, sigs)
      const baseSum = summary(baseTrades)
      const filtSum = summary(filt.trades)
      console.log(fmtSummary('BASELINE (no filter)', baseSum))
      console.log(fmtSummary(`FILTERED (cross-side block)`, filtSum))
      const dropped = baseSum.n - filtSum.n
      const droppedR = baseSum.totalR - filtSum.totalR
      console.log(`  Filter impact: dropped ${dropped} trades, ${(droppedR >= 0 ? '+' : '') + droppedR.toFixed(0)}R lost (blocked at signal time: ${filt.blocked})`)
      console.log(`  R/tr Δ: ${(filtSum.rPerTr - baseSum.rPerTr >= 0 ? '+' : '') + (filtSum.rPerTr - baseSum.rPerTr).toFixed(2)}`)
      portfolio.base.tradesAll.push(...baseTrades)
      portfolio.filt.tradesAll.push(...filt.trades)
      portfolio.base.blocked += 0
      portfolio.filt.blocked += filt.blocked
    } else {
      // Однонаправленный сетап — фильтр не должен ничего менять
      const baseTrades = simulateOneSide(ltf, sigs)
      const baseSum = summary(baseTrades)
      console.log(fmtSummary('BASELINE / FILTERED (same)', baseSum))
      console.log(`  (cross-side filter не применим — only one side)`)
      portfolio.base.tradesAll.push(...baseTrades)
      portfolio.filt.tradesAll.push(...baseTrades)
    }
  }

  console.log('\n\n=== PORTFOLIO TOTALS ===')
  const baseSum = summary(portfolio.base.tradesAll)
  const filtSum = summary(portfolio.filt.tradesAll)
  console.log(fmtSummary('BASELINE (all setups)', baseSum))
  console.log(fmtSummary('FILTERED (cross-side BOTH)', filtSum))
  const dN = baseSum.n - filtSum.n
  const dR = baseSum.totalR - filtSum.totalR
  console.log(`\nFilter dropped ${dN} trades / ${dR.toFixed(0)}R from portfolio`)
  console.log(`R/tr: ${baseSum.rPerTr.toFixed(2)} → ${filtSum.rPerTr.toFixed(2)} (Δ ${(filtSum.rPerTr - baseSum.rPerTr >= 0 ? '+' : '') + (filtSum.rPerTr - baseSum.rPerTr).toFixed(2)})`)
  console.log(`Total blocked at signal time across BOTH-сетапы: ${portfolio.filt.blocked}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
