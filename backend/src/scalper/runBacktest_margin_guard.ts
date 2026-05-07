/**
 * Margin Guard backtest:
 *
 * Симулирует paper trading c $500 депо, риск 2%, target margin 10% per trade,
 * с авто-закрытием плюсовых сделок при нехватке маржи (4→1 жадно):
 *   1. TP1_HIT (SL в BE)
 *   2. TP2_HIT (SL в TP1, ещё больше плюс)
 *   3. OPEN с unrealized P&L >= 0
 *   4. Если суммарно освобождённая маржа + free всё ещё < required → SKIP
 *      (без закрытий — не теряем сделки впустую)
 *
 * Сравниваем 3 режима:
 *   A. Baseline (без margin limit) — сейчас в prod
 *   B. Margin guard SKIP-only (если не хватает → skip, без auto-close)
 *   C. Margin guard + auto-close (4→1 ladder)
 *
 * Cross-side block для BOTH — применяется во всех режимах (как в prod).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_margin_guard.ts
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

// Стартовая конфигурация (как в paper trading)
const STARTING_DEPOSIT = 500
const RISK_PCT = 2          // 2% per trade
const TARGET_MARGIN_PCT = 10 // target 10% депо как маржа per trade
const FEES_RT = 0.0008
const SPLITS = [0.5, 0.3, 0.2]

// Bybit max leverage (захардкодено, fetched 2026-05-07)
const MAX_LEVERAGE: Record<string, number> = {
  BTCUSDT: 100, ETHUSDT: 100, XRPUSDT: 100, SOLUSDT: 100,
  ARBUSDT: 50, AVAXUSDT: 50, '1000PEPEUSDT': 50,
  HYPEUSDT: 75, ENAUSDT: 50, AAVEUSDT: 75,
  STRKUSDT: 50, BLURUSDT: 50, CRVUSDT: 50,
  WIFUSDT: 50, SEIUSDT: 50,
}
const DEFAULT_MAX_LEVERAGE = 50

interface RunCase {
  symbol: string
  side: 'BUY' | 'SELL' | 'BOTH'
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

// =====================================================================
// Сигналы (per-symbol сборка)
// =====================================================================

interface Sig {
  symbol: string
  side: 'BUY' | 'SELL'
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[]
}

interface SymbolData {
  symbol: string
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  m5: OHLCV[]
  signals: Map<number, Sig>  // key: m5 timestamp
  // Для быстрого доступа к свече по времени
  candleByTime: Map<number, OHLCV>
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
      symbol: c.symbol, side: s.side, setupSide: c.side,
      entryTime: s.entryTime, entryPrice: s.entryPrice, sl: s.slPrice, tpLadder: s.tpLadder,
    })
  }
  return sigs
}

// =====================================================================
// Симулятор portfolio: один общий timeline на всех символах,
// общий депозит, общая маржа, авто-закрытие
// =====================================================================

type Mode = 'baseline' | 'skipOnly' | 'autoClose'

interface OpenPos {
  id: number
  symbol: string
  setupSide: 'BUY' | 'SELL' | 'BOTH'
  side: 'BUY' | 'SELL'
  entryTime: number
  fillPrice: number
  initialSL: number
  trailingSL: number
  riskUsd: number             // dollar risk on initial SL
  positionSizeUsd: number     // notional
  leverageUsed: number        // actual leverage chosen
  marginUsd: number           // margin currently locked (decreases as TPs hit)
  riskPerUnit: number         // |entry - SL| (for R-calc)
  openIdx: number
  nextTpIdx: number
  remainingFrac: number
  splits: number[]
  fills: Array<{ tpIdx: number; price: number; frac: number; rContrib: number; pnlUsd: number; time: number }>
  reachedTp1: boolean
  status: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
}

interface ClosedTrade {
  id: number
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  exitTime: number
  pnlR: number
  pnlUsd: number
  exitReason: 'SL' | 'LADDER_DONE' | 'EOD' | 'AUTO_CLOSE'
  reachedTp1: boolean
  marginUsed: number
  leverageUsed: number
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

interface SimResult {
  mode: Mode
  startingDeposit: number
  finalDeposit: number
  trades: ClosedTrade[]
  signalsAttempted: number
  signalsOpened: number
  signalsSkipped: number      // skipped due to margin
  signalsBlockedCrossSide: number
  signalsBlockedSamePos: number
  autoClosed: number          // # trades closed by auto-close
  peakDeposit: number
  peakEquity: number
  maxRealizedDD: number       // max DD based on closed trades only
  maxEquityDD: number         // max DD based on equity (incl. unrealized)
  // marginUtilization: avg active margin / deposit
}

let TRADE_ID = 0

function simulatePortfolio(
  symbolData: SymbolData[],
  mode: Mode,
  timeRange?: { from: number; to: number },  // undefined = full period
): SimResult {
  // Объединяем все свечи в один отсортированный timeline
  const allTimes = new Set<number>()
  for (const s of symbolData) for (const c of s.m5) {
    if (timeRange && (c.time < timeRange.from || c.time > timeRange.to)) continue
    allTimes.add(c.time)
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b)

  let deposit = STARTING_DEPOSIT
  let peakDeposit = STARTING_DEPOSIT     // peak based on REALIZED deposit only
  let peakEquity = STARTING_DEPOSIT      // peak based on EQUITY (deposit + unrealized)
  let maxRealizedDD = 0
  let maxEquityDD = 0
  const openPositions: OpenPos[] = []
  const trades: ClosedTrade[] = []
  let signalsAttempted = 0, signalsOpened = 0, signalsSkipped = 0
  let signalsBlockedCrossSide = 0, signalsBlockedSamePos = 0, autoClosed = 0

  function activeMargin(): number {
    return openPositions.reduce((s, p) => s + p.marginUsd, 0)
  }
  function freeMargin(): number {
    return Math.max(0, deposit - activeMargin())
  }
  // Equity = realized deposit + unrealized P&L всех открытых позиций
  function equity(perSymPrices: Map<string, number>): number {
    let unrealized = 0
    for (const pos of openPositions) {
      const price = perSymPrices.get(pos.symbol)
      if (price == null) continue
      const isLong = pos.side === 'BUY'
      unrealized += ((isLong ? price - pos.fillPrice : pos.fillPrice - price) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
    }
    return deposit + unrealized
  }

  function closePosNow(pos: OpenPos, candle: OHLCV, reason: ClosedTrade['exitReason']): void {
    const isLong = pos.side === 'BUY'
    const exitPrice = candle.close
    const rContrib = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.remainingFrac) / pos.riskPerUnit
    const pnlUsdRemaining = ((isLong ? exitPrice - pos.fillPrice : pos.fillPrice - exitPrice) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
    pos.fills.push({ tpIdx: -1, price: exitPrice, frac: pos.remainingFrac, rContrib, pnlUsd: pnlUsdRemaining, time: candle.time })
    pos.remainingFrac = 0
    pos.marginUsd = 0
    finalizeTrade(pos, candle.time, reason)
  }

  function finalizeTrade(pos: OpenPos, exitTime: number, reason: ClosedTrade['exitReason']): void {
    const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
    const grossUsd = pos.fills.reduce((s, f) => s + f.pnlUsd, 0)
    const feeR = (pos.fillPrice * FEES_RT) / pos.riskPerUnit
    const feeUsd = pos.positionSizeUsd * FEES_RT
    const pnlR = grossR - feeR
    const pnlUsd = grossUsd - feeUsd
    deposit += pnlUsd
    if (deposit > peakDeposit) peakDeposit = deposit
    const dd = ((peakDeposit - deposit) / peakDeposit) * 100
    if (dd > maxRealizedDD) maxRealizedDD = dd
    trades.push({
      id: pos.id, symbol: pos.symbol, side: pos.side,
      entryTime: pos.entryTime, exitTime,
      pnlR: Math.round(pnlR * 10000) / 10000,
      pnlUsd: Math.round(pnlUsd * 100) / 100,
      exitReason: reason, reachedTp1: pos.reachedTp1,
      marginUsed: pos.marginUsd, leverageUsed: pos.leverageUsed,
    })
    // Remove from openPositions
    const idx = openPositions.indexOf(pos)
    if (idx >= 0) openPositions.splice(idx, 1)
  }

  function processBarForPos(pos: OpenPos, candle: OHLCV): void {
    const isLong = pos.side === 'BUY'
    const tps: number[] = (pos as any)._tps
    // SL
    const slHit = isLong ? candle.low <= pos.trailingSL : candle.high >= pos.trailingSL
    if (slHit) {
      const exitFill = pos.trailingSL
      const rContrib = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac) / pos.riskPerUnit
      const pnlUsdRem = ((isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
      pos.fills.push({ tpIdx: -1, price: exitFill, frac: pos.remainingFrac, rContrib, pnlUsd: pnlUsdRem, time: candle.time })
      pos.remainingFrac = 0
      pos.marginUsd = 0
      finalizeTrade(pos, candle.time, 'SL')
      return
    }
    // TPs (wick mode)
    while (pos.nextTpIdx < pos.splits.length && pos.remainingFrac > 1e-9) {
      const tpIdx = pos.nextTpIdx
      const tp = tps[tpIdx]
      const wickReached = isLong ? candle.high >= tp : candle.low <= tp
      if (!wickReached) break
      const isLastTp = tpIdx === pos.splits.length - 1
      const closeBeyond = isLong ? candle.close > tp : candle.close < tp
      const fill = !closeBeyond || isLastTp
      if (!fill) { pos.nextTpIdx++; continue }
      const frac = pos.splits[tpIdx] ?? 0
      if (frac > 0) {
        const rContrib = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * frac) / pos.riskPerUnit
        const pnlUsdFrac = ((isLong ? tp - pos.fillPrice : pos.fillPrice - tp) * pos.positionSizeUsd / pos.fillPrice) * frac
        pos.fills.push({ tpIdx, price: tp, frac, rContrib, pnlUsd: pnlUsdFrac, time: candle.time })
        const fracOfRemaining = frac / Math.max(1e-9, pos.remainingFrac)
        pos.marginUsd = Math.max(0, pos.marginUsd * (1 - fracOfRemaining))
        pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)
        if (tpIdx === 0) {
          pos.reachedTp1 = true
          pos.trailingSL = pos.fillPrice
          pos.status = 'TP1_HIT'
        } else if (tpIdx === 1) {
          pos.trailingSL = tps[0]
          pos.status = 'TP2_HIT'
        } else {
          pos.trailingSL = tps[tpIdx - 1]
        }
      }
      pos.nextTpIdx++
      if (pos.remainingFrac <= 1e-9) {
        pos.marginUsd = 0
        finalizeTrade(pos, candle.time, 'LADDER_DONE')
        return
      }
    }
  }

  // Считаем unrealized P&L позиции по текущей цене
  function unrealizedPnlUsd(pos: OpenPos, currentPrice: number): number {
    const isLong = pos.side === 'BUY'
    return ((isLong ? currentPrice - pos.fillPrice : pos.fillPrice - currentPrice) * pos.positionSizeUsd / pos.fillPrice) * pos.remainingFrac
  }

  // Auto-close ladder: TP2_HIT исключён (там уже большой profit, дорого жертвовать).
  // Порядок: TP1_HIT (SL в BE, "халява") → OPEN с unrealized P&L > 0 (best-PnL first).
  function planAutoClose(needFree: number, perSymPrices: Map<string, number>): OpenPos[] {
    const tp1 = openPositions.filter(p => p.status === 'TP1_HIT')
    const profitableOpen = openPositions
      .filter(p => p.status === 'OPEN' && unrealizedPnlUsd(p, perSymPrices.get(p.symbol) ?? p.fillPrice) > 0)
      .sort((a, b) => unrealizedPnlUsd(b, perSymPrices.get(b.symbol) ?? b.fillPrice) - unrealizedPnlUsd(a, perSymPrices.get(a.symbol) ?? a.fillPrice))
    const candidates = [...tp1, ...profitableOpen]
    const toClose: OpenPos[] = []
    let freed = 0
    for (const pos of candidates) {
      if (freed >= needFree) break
      toClose.push(pos)
      freed += pos.marginUsd
    }
    return freed >= needFree ? toClose : []
  }

  // Build sig lookup by time (for fast access)
  // Поскольку сигналы могут быть на разных символах в одно время — храним массив
  const sigByTime = new Map<number, Sig[]>()
  for (const s of symbolData) {
    for (const sig of s.signals.values()) {
      if (!sigByTime.has(sig.entryTime)) sigByTime.set(sig.entryTime, [])
      sigByTime.get(sig.entryTime)!.push(sig)
    }
  }

  // Build per-symbol candle lookup for pos updates
  const candleLookup = new Map<string, Map<number, OHLCV>>()
  for (const s of symbolData) candleLookup.set(s.symbol, s.candleByTime)

  for (const t of sortedTimes) {
    // 1. Update all open positions on their respective candles (if symbol has candle at this time)
    for (const pos of [...openPositions]) {
      const c = candleLookup.get(pos.symbol)?.get(t)
      if (!c) continue
      processBarForPos(pos, c)
    }

    // Per-symbol current prices for equity & auto-close
    const perSymPrices = new Map<string, number>()
    for (const [sym, m] of candleLookup) {
      const c = m.get(t)
      if (c) perSymPrices.set(sym, c.close)
    }

    // Update equity-based DD on every bar (capture intra-trade drawdown)
    const eq = equity(perSymPrices)
    if (eq > peakEquity) peakEquity = eq
    const eqDD = ((peakEquity - eq) / peakEquity) * 100
    if (eqDD > maxEquityDD) maxEquityDD = eqDD

    // 2. New signals at this time
    const sigs = sigByTime.get(t)
    if (!sigs) continue

    for (const sig of sigs) {
      signalsAttempted++

      // Cross-side block для BOTH (как в prod)
      if (sig.setupSide === 'BOTH') {
        const opp = openPositions.find(p =>
          p.symbol === sig.symbol &&
          p.side !== sig.side &&
          !p.reachedTp1
        )
        if (opp) { signalsBlockedCrossSide++; continue }
      }

      // Single-position-per-side per symbol (как в prod)
      const samePos = openPositions.find(p => p.symbol === sig.symbol && p.side === sig.side)
      if (samePos) { signalsBlockedSamePos++; continue }

      // Position sizing
      const isLong = sig.side === 'BUY'
      const entryFill = sig.entryPrice
      const riskPerUnit = Math.abs(entryFill - sig.sl)
      if (riskPerUnit <= 0) continue
      if (isLong && sig.sl >= entryFill) continue
      if (!isLong && sig.sl <= entryFill) continue
      if (!sig.tpLadder.every(p => isLong ? p > entryFill : p < entryFill)) continue

      const riskUsd = deposit * (RISK_PCT / 100)
      const positionUnits = riskUsd / riskPerUnit
      const positionSizeUsd = entryFill * positionUnits

      // Margin guard (только в режимах skipOnly + autoClose)
      let leverageUsed = 1
      let marginNeeded = positionSizeUsd
      if (mode !== 'baseline') {
        const targetMargin = deposit * (TARGET_MARGIN_PCT / 100)
        const maxLev = MAX_LEVERAGE[sig.symbol] ?? DEFAULT_MAX_LEVERAGE
        // Оптимальный leverage чтобы положить marginNeeded ~ targetMargin
        const targetLev = Math.ceil(positionSizeUsd / targetMargin)
        leverageUsed = Math.min(targetLev, maxLev)
        leverageUsed = Math.max(1, leverageUsed)
        marginNeeded = positionSizeUsd / leverageUsed

        if (marginNeeded > freeMargin()) {
          if (mode === 'skipOnly') {
            signalsSkipped++; continue
          }
          // mode === autoClose: try to free up margin
          const need = marginNeeded - freeMargin()
          const toClose = planAutoClose(need, perSymPrices)
          if (toClose.length === 0) {
            signalsSkipped++; continue
          }
          // Execute auto-closes
          for (const p of toClose) {
            const c = candleLookup.get(p.symbol)?.get(t)
            if (c) {
              closePosNow(p, c, 'AUTO_CLOSE')
              autoClosed++
            }
          }
        }
      } else {
        // baseline: leverage = 1 (вся position notional = margin) — это даст реалистичную картину "сколько денег уходит в маржу без leverage"
        // Но в backtest baseline ИГНОРИРУЕТ маржу совсем (как сейчас в paper). Поэтому marginUsd = 0 для baseline.
        leverageUsed = 0  // sentinel: означает unconstrained
        marginNeeded = 0
      }

      // Open
      TRADE_ID++
      const candle = candleLookup.get(sig.symbol)?.get(t)
      const newPos: OpenPos = {
        id: TRADE_ID, symbol: sig.symbol, setupSide: sig.setupSide, side: sig.side,
        entryTime: t, fillPrice: entryFill, initialSL: sig.sl, trailingSL: sig.sl,
        riskUsd, positionSizeUsd, leverageUsed, marginUsd: marginNeeded,
        riskPerUnit, openIdx: 0, nextTpIdx: 0, remainingFrac: 1,
        splits: alignSplits(sig.tpLadder.length), fills: [], reachedTp1: false,
        status: 'OPEN',
      } as any
      ;(newPos as any)._tps = sig.tpLadder
      openPositions.push(newPos)
      signalsOpened++
    }
  }

  // Close any remaining at last candle
  for (const pos of [...openPositions]) {
    const lastCandle = candleLookup.get(pos.symbol)?.get([...candleLookup.get(pos.symbol)!.keys()].sort((a, b) => b - a)[0])
    if (lastCandle) closePosNow(pos, lastCandle, 'EOD')
  }

  return {
    mode,
    startingDeposit: STARTING_DEPOSIT,
    finalDeposit: deposit,
    trades, signalsAttempted, signalsOpened, signalsSkipped,
    signalsBlockedCrossSide, signalsBlockedSamePos, autoClosed,
    peakDeposit, peakEquity, maxRealizedDD, maxEquityDD,
  }
}

function summarize(r: SimResult): void {
  const n = r.trades.length
  const totalPnl = r.finalDeposit - r.startingDeposit
  const returnPct = (totalPnl / r.startingDeposit) * 100
  const wins = r.trades.filter(t => t.pnlUsd > 0).length
  const wr = n > 0 ? (wins / n) * 100 : 0
  const totalR = r.trades.reduce((s, t) => s + t.pnlR, 0)
  const rPerTr = n > 0 ? totalR / n : 0
  const slCount = r.trades.filter(t => t.exitReason === 'SL').length
  const ladderDoneCount = r.trades.filter(t => t.exitReason === 'LADDER_DONE').length
  const autoCloseCount = r.trades.filter(t => t.exitReason === 'AUTO_CLOSE').length
  const eodCount = r.trades.filter(t => t.exitReason === 'EOD').length
  console.log(`\n${r.mode.toUpperCase()}`)
  console.log(`  Депо: $${r.startingDeposit} → $${r.finalDeposit.toFixed(2)}  (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%)`)
  console.log(`  Trades: N=${n}  totR=${totalR >= 0 ? '+' : ''}${totalR.toFixed(0)}  R/tr=${rPerTr >= 0 ? '+' : ''}${rPerTr.toFixed(2)}  WR=${wr.toFixed(0)}%`)
  console.log(`  Exits: SL=${slCount}  LADDER=${ladderDoneCount}  AUTO_CLOSE=${autoCloseCount}  EOD=${eodCount}`)
  console.log(`  Signals: attempted=${r.signalsAttempted}  opened=${r.signalsOpened}  skipped(margin)=${r.signalsSkipped}`)
  console.log(`  Blocks:  cross-side=${r.signalsBlockedCrossSide}  same-pos=${r.signalsBlockedSamePos}`)
  console.log(`  Realized peak: $${r.peakDeposit.toFixed(2)}  realizedDD=${r.maxRealizedDD.toFixed(1)}%`)
  console.log(`  Equity peak:   $${r.peakEquity.toFixed(2)}  equityDD=${r.maxEquityDD.toFixed(1)}% (incl. unrealized)`)
}

async function main() {
  console.log('Margin Guard backtest — Депо $500, риск 2%, target margin 10%, max-leverage Bybit')
  console.log('Период: 365d. Cross-side block для BOTH применяется во всех режимах.')
  console.log()

  // Загружаем все символы и собираем sig lookup
  console.log('Loading symbols & generating signals...')
  const symbolData: SymbolData[] = []
  for (const c of CASES) {
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`  ${c.symbol}: load fail, skip`); continue }
    const sigs = generateSigsForCase(data, c)
    const m5 = sliceLastDays(data.m5, DAYS_BACK)
    const candleByTime = new Map<number, OHLCV>()
    for (const candle of m5) candleByTime.set(candle.time, candle)
    const signalsMap = new Map<number, Sig>()
    for (const sig of sigs) signalsMap.set(sig.entryTime, sig)
    symbolData.push({ symbol: c.symbol, setupSide: c.side, m5, signals: signalsMap, candleByTime })
    console.log(`  ${c.symbol.padEnd(15)} side=${c.side.padEnd(5)} sigs=${sigs.length}`)
  }

  // Walk-forward boundaries
  const now = Date.now()
  const fullStart = now - DAYS_BACK * 24 * 60 * 60_000
  const trainEnd = now - Math.round(DAYS_BACK * 0.4) * 24 * 60 * 60_000  // первые 60% = TRAIN
  console.log('\nRunning simulations...\n')

  function run(mode: Mode, label: string, range?: { from: number; to: number }) {
    TRADE_ID = 0
    const r = simulatePortfolio(symbolData, mode, range)
    console.log(`\n--- ${label} ---`)
    summarize(r)
    return r
  }

  console.log('=========================================================')
  console.log('FULL PERIOD (365d)')
  console.log('=========================================================')
  const baseFull = run('baseline', 'baseline FULL', { from: fullStart, to: now })
  const skipFull = run('skipOnly', 'skipOnly FULL', { from: fullStart, to: now })
  const acFull   = run('autoClose', 'autoClose FULL', { from: fullStart, to: now })

  console.log('\n=========================================================')
  console.log('TRAIN (первые 60% = 219d)')
  console.log('=========================================================')
  const baseTrain = run('baseline', 'baseline TRAIN', { from: fullStart, to: trainEnd })
  const skipTrain = run('skipOnly', 'skipOnly TRAIN', { from: fullStart, to: trainEnd })
  const acTrain   = run('autoClose', 'autoClose TRAIN', { from: fullStart, to: trainEnd })

  console.log('\n=========================================================')
  console.log('TEST (последние 40% = 146d)')
  console.log('=========================================================')
  const baseTest = run('baseline', 'baseline TEST', { from: trainEnd, to: now })
  const skipTest = run('skipOnly', 'skipOnly TEST', { from: trainEnd, to: now })
  const acTest   = run('autoClose', 'autoClose TEST', { from: trainEnd, to: now })

  console.log('\n=========================================================')
  console.log('SUMMARY (final deposit comparison)')
  console.log('=========================================================')
  console.log('Mode       | FULL              | TRAIN             | TEST')
  console.log('-'.repeat(80))
  function fmtRow(label: string, full: SimResult, train: SimResult, test: SimResult): string {
    function cell(r: SimResult): string {
      const ret = ((r.finalDeposit - r.startingDeposit) / r.startingDeposit * 100).toFixed(0)
      return `$${r.finalDeposit.toFixed(0).padStart(5)} (${(parseFloat(ret) >= 0 ? '+' : '')}${ret}%) DD${r.maxEquityDD.toFixed(0)}%`
    }
    return `${label.padEnd(10)} | ${cell(full).padEnd(17)} | ${cell(train).padEnd(17)} | ${cell(test)}`
  }
  console.log(fmtRow('baseline', baseFull, baseTrain, baseTest))
  console.log(fmtRow('skipOnly', skipFull, skipTrain, skipTest))
  console.log(fmtRow('autoClose', acFull, acTrain, acTest))
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
