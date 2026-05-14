/**
 * Daily Breakout — Variant C LIVE simulator.
 *
 * Воспроизводит точную prod-логику dailyBreakoutLimitTrader.ts на исторических
 * данных. В отличие от idealized limit-режима в runBacktest_dailybreak_binance_AB.ts,
 * этот скрипт моделирует РЕАЛЬНУЮ live-механику:
 *
 *   1. PRE-EMPTIVE placement: в момент закрытия 36-й 5m свечи дня (бар index=35,
 *      т.е. 03:00 UTC) для каждой монеты вычисляется 3h range. Если slDist >=0.4%
 *      и livePrice внутри range — создаются 2 PENDING_LIMIT (BUY @ rangeHigh,
 *      SELL @ rangeLow). Если livePrice уже за стороной — limit на ту сторону
 *      НЕ ставится (post-only бы reject).
 *
 *   2. GAP-HANDLING (критическое отличие от idealized): если следующая свеча
 *      открывается УЖЕ за уровнем (для BUY: open > rangeHigh), значит цена
 *      пробила limit через GAP, без касания. На реальной бирже:
 *        - Если limit уже стоял — он бы зафиллился на open или close открывающей
 *          gap-свечи (post-only ордер заполняется при касании, но если gap его
 *          перепрыгнул на открытии — Bybit/Binance fill по open).
 *        - Но в C placement происходит ПОСЛЕ закрытия 36-й свечи. Если 37-я
 *          свеча уже открылась за уровнем — placement guard `livePrice <= rangeHigh`
 *          ОТКЛОНИЛ бы этот side.
 *      Этот скрипт моделирует обоими случаями: 'livePriceCheck' (как prod, отклоняем
 *      side при gap) и 'allFills' (idealized, заполняем всегда — для сравнения).
 *
 *   3. FILL DETECTION: с 37-й свечи (i=36) и до EOD проверяем каждую свечу:
 *      - BUY: филлится если c.low <= rangeHigh (касание wick)
 *      - SELL: филлится если c.high >= rangeLow
 *      Fill price = limitPrice (exact, maker fee, slip=0).
 *
 *   4. PAIR CANCEL: при fill одной стороны — противоположная отменяется.
 *
 *   5. POST-FILL: trade попадает в стандартный ladder (TP1/TP2/TP3/SL/EOD)
 *      через runLadderBacktest. Те же fees как в taker: TP=maker 0.02%, SL=taker
 *      0.05%+slip 0.03%, EOD=taker 0.05%+slip 0.03%.
 *
 *   6. EOD: непросочённые limits в 23:55 UTC отменяются (без P&L).
 *
 * Конфигурация C (как в prod):
 *   $320 deposit, 20 max concurrent, 5% target margin, 2% risk
 *
 * Сравнение с idealized backtest:
 *   - idealized AB.ts limit-mode: предполагает fill ВСЕГДА при касании, не учитывает
 *     gap-через. Это даёт ×9-22 vs taker.
 *   - C-live (этот скрипт): учитывает gap-skip + livePrice guard. Реальная
 *     доходность будет НИЖЕ idealized — насколько именно покажет этот backtest.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_dailybreak_C_live.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal, LadderTrade } from './ladderBacktester'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from '../services/marginGuard'
import { ema } from '../services/indicators'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

// Binance USDT-M perp base tier
const TAKER_FEE = 0.00050
const MAKER_FEE = 0.00020
const TAKER_SLIP = 0.0003

const RISK_PCT = 2
const RANGE_BARS = 36           // 36 × 5m = 3h
const TP_MULTS = [1.0, 2.0, 3.0]
const SPLITS = [0.5, 0.3, 0.2]
const MIN_SL_DIST_PCT = 0.4

const BTC_ADX_PERIOD = 14
const BTC_ADX_THRESHOLD = 20

const CACHE_DIR = path.join(__dirname, '../../data/backtest')

const PROD_SYMBOLS = [
  'ETHUSDT', 'AAVEUSDT', 'ENAUSDT', 'SEIUSDT',
  'MUSDT', 'LDOUSDT', 'DYDXUSDT', 'ZECUSDT', 'STXUSDT',
  'IPUSDT', 'ORDIUSDT', 'ARUSDT', 'DOGEUSDT', 'TRUMPUSDT',
  'KASUSDT', 'SHIB1000USDT', 'FARTCOINUSDT', 'AEROUSDT', 'POLUSDT', 'VVVUSDT',
  'USELESSUSDT', 'SIRENUSDT', '1000BONKUSDT',
]

const VARIANT_C = {
  name: 'C' as const,
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

type FillMode =
  | 'live_noVolFilter'      // PROD C as-is: любое касание = fill
  | 'live_priorVolHigh'     // Касание зачитывается только если предыдущие 3 свечи имеют SUM volume >= avg×2.0
                            // (использует только закрытое прошлое — НЕТ lookahead)
  | 'live_pendingCooldown'  // После касания со слабым прошлым volume — limit "снимается" на N=12 баров (1h),
                            // потом разрешено снова попробовать (anti-knife без lookahead)

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ============================================================================
// BTC ADX(14) on 1h
// ============================================================================

function aggregate5mTo1h(m5: OHLCV[]): OHLCV[] {
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const h = Math.floor(c.time / 3600_000) * 3600_000
    const list = buckets.get(h) ?? []
    list.push(c); buckets.set(h, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

function adxSeries(candles: OHLCV[], period = BTC_ADX_PERIOD): number[] {
  const n = candles.length
  if (n < period * 2) return new Array(n).fill(0)
  const plusDM: number[] = [0]
  const minusDM: number[] = [0]
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    plusDM.push(up > dn && up > 0 ? up : 0)
    minusDM.push(dn > up && dn > 0 ? dn : 0)
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ))
  }
  const trEma = ema(tr, period)
  const plusEma = ema(plusDM, period)
  const minusEma = ema(minusDM, period)
  const dx: number[] = []
  for (let i = 0; i < n; i++) {
    const plusDI = trEma[i] > 0 ? (plusEma[i] / trEma[i]) * 100 : 0
    const minusDI = trEma[i] > 0 ? (minusEma[i] / trEma[i]) * 100 : 0
    const denom = plusDI + minusDI
    dx.push(denom > 0 ? (Math.abs(plusDI - minusDI) / denom) * 100 : 0)
  }
  return ema(dx, period)
}

interface BtcRegime { isTrending(unixMs: number): boolean }

async function buildBtcRegime(): Promise<BtcRegime> {
  const m5 = await loadHistorical('BTCUSDT', '5m', MONTHS_BACK, 'bybit', 'linear')
  const h1 = aggregate5mTo1h(m5)
  const adx = adxSeries(h1, BTC_ADX_PERIOD)
  const byHour = new Map<number, number>()
  for (let i = 0; i < h1.length; i++) byHour.set(h1[i].time, adx[i])
  return {
    isTrending(t: number) {
      const h = Math.floor(t / 3600_000) * 3600_000
      const v = byHour.get(h)
      return v == null ? true : v > BTC_ADX_THRESHOLD
    },
  }
}

// ============================================================================
// LIMIT PLACEMENT + FILL DETECTION (C live mechanics)
// ============================================================================

/**
 * Для одного символа и периода [from, to]:
 *   1. По UTC-дням группируем свечи
 *   2. Для каждого дня: бар 36 = placement момент. livePrice = close 36-го бара.
 *   3. Проверяем slDist >= 0.4%
 *   4. Geometry: BUY @ rangeHigh, SELL @ rangeLow
 *   5. Gap-check: если livePrice уже за стороной — fillMode='livePriceCheck' пропускает
 *      эту сторону
 *   6. Fill detection: с бара 37 (i=36) до EOD, ищем первое касание для каждой стороны.
 *      Pair cancel: первая зафилленная сторона отменяет вторую.
 *   7. Возвращаем сигнал (LadderSignal) с entry=limitPrice, который попадает в
 *      ladder backtester для TP/SL обработки.
 */
interface LimitFillSignal extends LadderSignal {
  gapFill: boolean
}

function generateLimitFills(
  m5: OHLCV[], periodFrom: number, periodTo: number, fillMode: FillMode,
): LimitFillSignal[] {
  const sigs: LimitFillSignal[] = []
  const byDay = new Map<string, OHLCV[]>()
  for (const c of m5) {
    if (c.time < periodFrom || c.time > periodTo) continue
    const d = utcDateOf(c.time)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(c)
  }

  for (const [, candles] of byDay) {
    if (candles.length < RANGE_BARS + 1) continue
    const rangeBars = candles.slice(0, RANGE_BARS)
    const rangeHigh = Math.max(...rangeBars.map(c => c.high))
    const rangeLow = Math.min(...rangeBars.map(c => c.low))
    const rangeSize = rangeHigh - rangeLow
    if (rangeSize <= 0) continue

    // slDist guard (как в prod placeLimitsForRanges)
    const slDistPct = (rangeSize / Math.min(rangeHigh, rangeLow)) * 100
    if (slDistPct < MIN_SL_DIST_PCT) continue

    // Placement: момент закрытия 36-го бара = livePrice
    const placementBar = candles[RANGE_BARS - 1]
    const livePrice = placementBar.close

    // Gap check на placement — как в prod
    const canPlaceBuy = livePrice <= rangeHigh
    const canPlaceSell = livePrice >= rangeLow
    if (!canPlaceBuy && !canPlaceSell) continue

    // TP ladders (anchor = rangeEdge, как в prod)
    const buyTp = [
      rangeHigh + rangeSize * TP_MULTS[0],
      rangeHigh + rangeSize * TP_MULTS[1],
      rangeHigh + rangeSize * TP_MULTS[2],
    ]
    const sellTp = [
      rangeLow - rangeSize * TP_MULTS[0],
      rangeLow - rangeSize * TP_MULTS[1],
      rangeLow - rangeSize * TP_MULTS[2],
    ]

    // Fill detection — первое касание для каждой стороны.
    // live_noVolFilter: ЛЮБОЕ касание = fill (PROD C сейчас).
    // live_volFillReq: первое касание ДОЛЖНО иметь volume>=avg×2.0. Иначе limit
    //   отменяется НА ЭТУ СТОРОНУ — это значит C считает первый wick ложным и
    //   снимает limit, не дожидаясь повторного касания.
    // live_volAfter1Bar: fill на первом касании (любой volume), НО следующая свеча
    //   должна подтвердить пробой: volume>=avg×2.0 ИЛИ продолжение в направлении пробоя.
    //   Иначе trade закрывается на close(fillBar+1) — это anti-knife выход.
    // Helper: prior volume average — использует ТОЛЬКО закрытое прошлое (нет lookahead).
    // В момент касания свечи i ещё не закрыта, но свечи [i-3, i-1] уже finalized.
    function priorVolRatio(idx: number, lookback = 3): number {
      const start = Math.max(0, idx - 24)
      const end = idx  // ←  i exclusive (мы не используем текущую свечу!)
      if (end <= start) return 0
      const avgVol = candles.slice(start, end).reduce((s, x) => s + x.volume, 0) / (end - start)
      if (avgVol <= 0) return 0
      // Сумма volume последних `lookback` закрытых свечей
      const recentStart = Math.max(start, idx - lookback)
      const recentSum = candles.slice(recentStart, end).reduce((s, x) => s + x.volume, 0)
      const recentAvg = recentSum / (end - recentStart)
      return recentAvg / avgVol
    }

    const COOLDOWN_BARS = 12  // 1h на 5m свечах
    let buyFillIdx = -1
    let sellFillIdx = -1
    let buyKilled = false
    let sellKilled = false
    let buyCooldownUntil = -1
    let sellCooldownUntil = -1
    for (let i = RANGE_BARS; i < candles.length; i++) {
      const c = candles[i]
      // BUY
      if (canPlaceBuy && !buyKilled && buyFillIdx < 0 && i >= buyCooldownUntil && c.high >= rangeHigh) {
        if (fillMode === 'live_priorVolHigh') {
          const ratio = priorVolRatio(i, 3)
          if (ratio >= 2.0) buyFillIdx = i
          else buyKilled = true  // ложное касание → limit снят насовсем на этот день
        } else if (fillMode === 'live_pendingCooldown') {
          const ratio = priorVolRatio(i, 3)
          if (ratio >= 2.0) buyFillIdx = i
          else buyCooldownUntil = i + COOLDOWN_BARS  // пауза, потом попробуем снова
        } else {
          buyFillIdx = i
        }
      }
      // SELL
      if (canPlaceSell && !sellKilled && sellFillIdx < 0 && i >= sellCooldownUntil && c.low <= rangeLow) {
        if (fillMode === 'live_priorVolHigh') {
          const ratio = priorVolRatio(i, 3)
          if (ratio >= 2.0) sellFillIdx = i
          else sellKilled = true
        } else if (fillMode === 'live_pendingCooldown') {
          const ratio = priorVolRatio(i, 3)
          if (ratio >= 2.0) sellFillIdx = i
          else sellCooldownUntil = i + COOLDOWN_BARS
        } else {
          sellFillIdx = i
        }
      }
      if (buyFillIdx >= 0 && sellFillIdx >= 0) break
    }

    // Pair cancel: первая по времени fill — побеждает
    let winningSide: 'BUY' | 'SELL' | null = null
    let winningIdx = -1
    if (buyFillIdx >= 0 && sellFillIdx >= 0) {
      if (buyFillIdx <= sellFillIdx) { winningSide = 'BUY'; winningIdx = buyFillIdx }
      else { winningSide = 'SELL'; winningIdx = sellFillIdx }
    } else if (buyFillIdx >= 0) { winningSide = 'BUY'; winningIdx = buyFillIdx }
    else if (sellFillIdx >= 0) { winningSide = 'SELL'; winningIdx = sellFillIdx }

    if (!winningSide) continue

    const fillCandle = candles[winningIdx]
    // Gap-fill detection: если open этой свечи уже за уровнем — это gap-через.
    // Limit-ордер всё ещё заполняется (он стоял в стакане заранее), но по open
    // не по rangeEdge — реалистично на Bybit/Binance это taker rate (post-only
    // отвергнет, но обычный limit зафиллится по open).
    let fillPrice: number
    let gapFill = false
    if (winningSide === 'BUY') {
      if (fillCandle.open > rangeHigh) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = rangeHigh
    } else {
      if (fillCandle.open < rangeLow) { fillPrice = fillCandle.open; gapFill = true }
      else fillPrice = rangeLow
    }

    // TP overshoot guard (как в engine) — если fill price уже за TP1, skip
    const tp = winningSide === 'BUY' ? buyTp : sellTp
    const overshoot = winningSide === 'BUY' ? fillPrice >= tp[0] : fillPrice <= tp[0]
    if (overshoot) continue

    sigs.push({
      side: winningSide,
      entryTime: fillCandle.time,
      entryPrice: fillPrice,
      sl: winningSide === 'BUY' ? rangeLow : rangeHigh,
      tpLadder: tp,
      reason: `C limit fill ${winningSide} @ ${fillPrice.toFixed(4)}${gapFill ? ' (GAP)' : ''} (range ${rangeLow.toFixed(4)}-${rangeHigh.toFixed(4)})`,
      gapFill,
    })
  }

  return sigs
}

function runLadderRaw(m5: OHLCV[], periodFrom: number, periodTo: number, fillMode: FillMode): Array<LadderTrade & { gapFill: boolean }> {
  const sigs = generateLimitFills(m5, periodFrom, periodTo, fillMode)
  const periodCandles = m5.filter(c => c.time >= periodFrom && c.time <= periodTo)
  const sigByIdx = new Map<number, LimitFillSignal>()
  for (const s of sigs) {
    const idx = periodCandles.findIndex(c => c.time === s.entryTime)
    if (idx >= 0) sigByIdx.set(idx, s)
  }
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick', splits: SPLITS, trailing: true,
    feesRoundTrip: 0, slippagePerSide: 0,
    // EOD per-trade: prod C ставит expiresAt = endOfDay UTC при fill. Maxhold 288
    // баров (24h на 5m) = безопасный upper-bound — большинство сделок закрываются
    // раньше, EOD-NO-TP1 (как A/B) сохраняет TP1-достигнувшие сделки.
    maxHoldBars: 288,
  }
  const trades = runLadderBacktest(periodCandles, (i) => sigByIdx.get(i) ?? null, ladderCfg).trades
  const gapByEntry = new Map<number, boolean>()
  for (const s of sigs) gapByEntry.set(s.entryTime, s.gapFill)
  return trades.map(t => ({ ...t, gapFill: gapByEntry.get(t.entryTime) ?? false }))
}

interface PortfolioFill {
  time: number
  price: number
  pnlR: number
  percent: number
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

interface PortfolioTrade {
  symbol: string
  utcDate: string
  entryTime: number
  closeTime: number
  side: 'BUY' | 'SELL'
  entryPrice: number   // limit fill price (=rangeEdge or gap-open)
  sl: number
  fills: PortfolioFill[]
  /** Был ли это gap-fill (open уже за уровнем на момент fill свечи)? */
  gapFill: boolean
}

function toPortfolioTrade(symbol: string, t: LadderTrade, gapFill: boolean): PortfolioTrade {
  const fills: PortfolioFill[] = (t.fills ?? []).map((f, i) => {
    const fillCount = (t.fills ?? []).length
    const frac = fillCount > 1 ? (i + 1) / fillCount : 1
    const time = t.entryTime + (t.exitTime - t.entryTime) * frac
    let reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
    if (f.idx >= 0) reason = (`TP${f.idx + 1}`) as 'TP1' | 'TP2' | 'TP3'
    else if (t.exitReason === 'EOD' || t.exitReason === 'MAX_HOLD') reason = 'EXPIRED'
    else reason = 'SL'
    return { time, price: f.price, pnlR: f.rContrib, percent: f.frac * 100, reason }
  })
  return {
    symbol, utcDate: utcDateOf(t.entryTime), entryTime: t.entryTime, closeTime: t.exitTime,
    side: t.side, entryPrice: t.entryPrice, sl: t.initialSL, fills, gapFill,
  }
}

// ============================================================================
// Portfolio simulator (C-specific: maker entry, no slip on entry)
// ============================================================================

interface SimResult {
  fillMode: FillMode
  startingDeposit: number
  signalsTotal: number
  gapFills: number
  skippedBtcAdx: number
  skippedCarryOver: number
  skippedSameDay: number
  skippedConcurrent: number
  skippedMargin: number
  opened: number
  trades: number
  totalR: number
  rPerTr: number
  finalDeposit: number
  peakDeposit: number
  minDeposit: number
  maxDD: number
  winRate: number
  totalFeesUsd: number
  totalSlipUsd: number
  monthly: Map<string, { pnl: number; equity: number; trades: number }>
}

function simulate(allTrades: PortfolioTrade[], btc: BtcRegime, fillMode: FillMode): SimResult {
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = VARIANT_C.startingDeposit
  let peak = VARIANT_C.startingDeposit
  let trough = VARIANT_C.startingDeposit
  let maxDD = 0
  let totalFees = 0, totalSlip = 0
  let gapFills = 0

  interface Active {
    pt: PortfolioTrade
    id: number
    positionSizeUsd: number
    positionUnits: number
    leverage: number
    marginUsd: number
    fillsApplied: number
    closedFracPct: number
    statusKey: 'OPEN' | 'TP1_HIT' | 'TP2_HIT'
    realizedR: number
    riskUsd: number
    effectiveEntryPrice: number
    entryIsMaker: boolean
  }
  const active: Active[] = []
  let nextId = 1
  let opened = 0
  let skippedBtcAdx = 0, skippedCarryOver = 0, skippedSameDay = 0
  let skippedConcurrent = 0, skippedMargin = 0
  const fullyClosed: PortfolioTrade[] = []
  let wins = 0, totalR = 0
  const takenSet = new Set<string>()

  const monthly = new Map<string, { pnl: number; equity: number; trades: number }>()
  function addMonthly(time: number, pnlDelta: number, tradeIncrement = 0) {
    const m = new Date(time).toISOString().slice(0, 7)
    const v = monthly.get(m) ?? { pnl: 0, equity: currentDeposit, trades: 0 }
    v.pnl += pnlDelta
    v.equity = currentDeposit
    v.trades += tradeIncrement
    monthly.set(m, v)
  }
  function applyDD(time: number) {
    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit
    const dd = ((peak - currentDeposit) / peak) * 100
    if (dd > maxDD) maxDD = dd
    addMonthly(time, 0)
  }

  function realizeFillsUntil(t: number) {
    for (let ai = active.length - 1; ai >= 0; ai--) {
      const a = active[ai]
      while (a.fillsApplied < a.pt.fills.length && a.pt.fills[a.fillsApplied].time <= t) {
        const f = a.pt.fills[a.fillsApplied]
        a.fillsApplied++
        const isMaker = f.reason === 'TP1' || f.reason === 'TP2' || f.reason === 'TP3'
        let exitPrice: number
        const isLong = a.pt.side === 'BUY'
        if (isMaker) {
          exitPrice = f.price
        } else {
          exitPrice = isLong ? f.price * (1 - TAKER_SLIP) : f.price * (1 + TAKER_SLIP)
        }
        const fillUnits = a.positionUnits * (f.percent / 100)
        const grossPnl = (isLong ? exitPrice - a.effectiveEntryPrice : a.effectiveEntryPrice - exitPrice) * fillUnits
        const fillNotional = fillUnits * exitPrice
        const feeRate = isMaker ? MAKER_FEE : TAKER_FEE
        const feeUsd = fillNotional * feeRate
        const slipUsd = isMaker ? 0 : fillUnits * Math.abs(exitPrice - f.price)
        const netPnl = grossPnl - feeUsd
        currentDeposit += netPnl
        totalFees += feeUsd
        totalSlip += slipUsd
        a.realizedR += f.pnlR
        a.closedFracPct += f.percent
        if (f.reason === 'TP1') a.statusKey = 'TP1_HIT'
        else if (f.reason === 'TP2') a.statusKey = 'TP2_HIT'
        addMonthly(f.time, netPnl, 0)
        applyDD(f.time)
      }
      if (a.fillsApplied >= a.pt.fills.length || a.closedFracPct >= 99.99) {
        if (a.realizedR > 0) wins++
        totalR += a.realizedR
        fullyClosed.push(a.pt)
        addMonthly(a.pt.closeTime, 0, 1)
        active.splice(ai, 1)
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i]
    realizeFillsUntil(pt.entryTime)

    if (!btc.isTrending(pt.entryTime)) { skippedBtcAdx++; continue }
    if (active.some(a => a.pt.symbol === pt.symbol && a.pt.utcDate !== pt.utcDate)) {
      skippedCarryOver++; continue
    }
    const key = `${pt.symbol}|${pt.utcDate}`
    if (takenSet.has(key)) { skippedSameDay++; continue }

    const slDist = Math.abs(pt.entryPrice - pt.sl)
    if (slDist <= 0 || currentDeposit <= 0) { skippedMargin++; continue }
    if (active.length >= VARIANT_C.maxConcurrent) { skippedConcurrent++; continue }

    // Entry: для C это maker fill на limit price (без slip). НО если был gap-fill
    // (open за уровнем), то реально fill случился taker'ом на open + slip против.
    const isLong = pt.side === 'BUY'
    const entryIsMaker = !pt.gapFill
    const effectiveEntry = entryIsMaker
      ? pt.entryPrice
      : (isLong ? pt.entryPrice * (1 + TAKER_SLIP) : pt.entryPrice * (1 - TAKER_SLIP))
    if (pt.gapFill) gapFills++

    const sizing = computeSizing({
      symbol: pt.symbol, deposit: currentDeposit,
      riskPct: RISK_PCT, targetMarginPct: VARIANT_C.targetMarginPct,
      entry: effectiveEntry, sl: pt.sl,
    })
    if (!sizing) { skippedMargin++; continue }

    const existing: ExistingTrade[] = active.map(a => ({
      id: a.id, symbol: a.pt.symbol, status: a.statusKey,
      positionSizeUsd: a.positionSizeUsd,
      closedFrac: a.closedFracPct / 100,
      leverage: a.leverage,
      unrealizedR: a.realizedR,
      hasTP1: a.statusKey === 'TP1_HIT' || a.statusKey === 'TP2_HIT',
      hasTP2: a.statusKey === 'TP2_HIT',
    }))
    const guard = evaluateOpenWithGuard(currentDeposit, sizing.marginUsd, existing)
    if (!guard.canOpen) { skippedMargin++; continue }
    if (guard.toClose.length > 0) { skippedMargin++; continue }

    const entryNotional = sizing.positionUnits * effectiveEntry
    const entryFeeRate = entryIsMaker ? MAKER_FEE : TAKER_FEE
    const entryFee = entryNotional * entryFeeRate
    currentDeposit -= entryFee
    totalFees += entryFee
    if (!entryIsMaker) {
      const entrySlip = sizing.positionUnits * Math.abs(effectiveEntry - pt.entryPrice)
      totalSlip += entrySlip
    }
    applyDD(pt.entryTime)

    takenSet.add(key)
    active.push({
      pt, id: nextId++,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: sizing.leverage,
      marginUsd: sizing.marginUsd,
      fillsApplied: 0, closedFracPct: 0, statusKey: 'OPEN', realizedR: 0,
      riskUsd: sizing.riskUsd,
      effectiveEntryPrice: effectiveEntry,
      entryIsMaker,
    })
    opened++
  }

  realizeFillsUntil(Date.now())
  for (const a of active) {
    if (a.realizedR > 0) wins++
    totalR += a.realizedR
    fullyClosed.push(a.pt)
  }

  return {
    fillMode,
    startingDeposit: VARIANT_C.startingDeposit,
    signalsTotal: allTrades.length, gapFills,
    skippedBtcAdx, skippedCarryOver, skippedSameDay,
    skippedConcurrent, skippedMargin,
    opened, trades: fullyClosed.length,
    totalR, rPerTr: fullyClosed.length > 0 ? totalR / fullyClosed.length : 0,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    winRate: fullyClosed.length > 0 ? (wins / fullyClosed.length) * 100 : 0,
    totalFeesUsd: totalFees, totalSlipUsd: totalSlip,
    monthly,
  }
}

// ============================================================================
// Output
// ============================================================================

function fmtR(r: number): string { return (r >= 0 ? '+' : '') + r.toFixed(2) }
function fmtUsd(n: number): string { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2) }

function printResult(label: string, r: SimResult) {
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`--- ${label} | fillMode=${r.fillMode} | Variant C ($${r.startingDeposit} start) ---`)
  console.log(
    `signals=${r.signalsTotal} (gapFill=${r.gapFills}) | ` +
    `skip btcAdx=${r.skippedBtcAdx} carryOver=${r.skippedCarryOver} sameDay=${r.skippedSameDay} ` +
    `conc=${r.skippedConcurrent} margin=${r.skippedMargin} | opened=${r.opened}`,
  )
  console.log(
    `totalR=${fmtR(r.totalR)} R/tr=${fmtR(r.rPerTr)} WR=${r.winRate.toFixed(0)}% | ` +
    `final=$${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) ` +
    `peak=$${r.peakDeposit.toFixed(0)} min=$${r.minDeposit.toFixed(0)} DD=${r.maxDD.toFixed(1)}%`,
  )
  console.log(`fees=$${r.totalFeesUsd.toFixed(2)} slip=$${r.totalSlipUsd.toFixed(2)} effCost=$${(r.totalFeesUsd + r.totalSlipUsd).toFixed(2)}`)
}

function printMonthly(label: string, r: SimResult) {
  console.log(`--- ${label} | monthly P&L (Variant C, fillMode=${r.fillMode}) ---`)
  const months = [...r.monthly.keys()].sort()
  console.log('month   |  P&L     | equity   | trades')
  console.log('-'.repeat(45))
  for (const m of months) {
    const v = r.monthly.get(m)!
    console.log(`${m} | ${fmtUsd(v.pnl).padStart(8)} | $${v.equity.toFixed(0).padStart(7)} | ${v.trades.toString().padStart(6)}`)
  }
}

async function main() {
  console.log('Daily Breakout — Variant C LIVE simulator')
  console.log(`Universe: ${PROD_SYMBOLS.length} symbols | Binance: taker ${(TAKER_FEE * 100).toFixed(2)}% / maker ${(MAKER_FEE * 100).toFixed(2)}% / slip ${(TAKER_SLIP * 100).toFixed(2)}%`)
  console.log(`Variant C: $${VARIANT_C.startingDeposit} start | ${VARIANT_C.maxConcurrent} max conc | ${VARIANT_C.targetMarginPct}% target margin`)
  console.log(`Risk ${RISK_PCT}% | BTC ADX>${BTC_ADX_THRESHOLD} | dedup guards on | rangeBars=${RANGE_BARS} (3h)`)
  console.log(`Period: 365d FULL + monthly\n`)

  console.log('Loading BTC regime...')
  const btc = await buildBtcRegime()

  const fullStart = Date.now() - DAYS_BACK * 24 * 60 * 60_000
  const now = Date.now()

  console.log('Loading m5 candles...')
  const m5BySymbol = new Map<string, OHLCV[]>()
  for (const sym of PROD_SYMBOLS) {
    const cachePath = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cachePath)) { console.warn(`[skip] ${sym} not cached`); continue }
    const all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short data ${m5.length}`); continue }
    m5BySymbol.set(sym, m5)
  }
  console.log(`Loaded ${m5BySymbol.size} symbols\n`)

  // 3 сценария:
  //   1. live_noVolFilter — точная prod C: любое касание = fill (DEPRECATED, проверка)
  //   2. live_volFillReq — первая касающаяся свеча должна иметь volume×2.0, иначе limit
  //      снимается (mainline гипотеза 3: добавить vol guard на fill-баре)
  //   3. live_volAfter1Bar — fill на любом касании, но следующая свеча должна
  //      confirm volume ИЛИ direction continuation. Иначе skip (anti-knife)
  const SCENARIOS: FillMode[] = ['live_noVolFilter', 'live_priorVolHigh', 'live_pendingCooldown']

  type Group = { full: SimResult; train: SimResult; test: SimResult; poolFull: number; poolTrain: number; poolTest: number }
  const results = new Map<FillMode, Group>()

  const TRAIN_PCT = 0.6
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000

  for (const mode of SCENARIOS) {
    const allFull: PortfolioTrade[] = []
    const allTrain: PortfolioTrade[] = []
    const allTest: PortfolioTrade[] = []
    for (const [sym, m5] of m5BySymbol.entries()) {
      const fullT = runLadderRaw(m5, fullStart, now, mode)
      const trainT = runLadderRaw(m5, fullStart, trainEnd, mode)
      const testT = runLadderRaw(m5, trainEnd, now, mode)
      for (const t of fullT) allFull.push(toPortfolioTrade(sym, t, t.gapFill))
      for (const t of trainT) allTrain.push(toPortfolioTrade(sym, t, t.gapFill))
      for (const t of testT) allTest.push(toPortfolioTrade(sym, t, t.gapFill))
    }
    console.log(`================== fillMode=${mode} ==================`)
    console.log(`Trade pool: FULL ${allFull.length} | TRAIN ${allTrain.length} | TEST ${allTest.length}\n`)

    const full = simulate(allFull, btc, mode)
    const train = simulate(allTrain, btc, mode)
    const test = simulate(allTest, btc, mode)
    printResult('FULL (365d)', full)
    printResult('TRAIN (60%, ~219d)', train)
    printResult('TEST (40%, ~146d)', test)
    console.log()

    results.set(mode, { full, train, test, poolFull: allFull.length, poolTrain: allTrain.length, poolTest: allTest.length })
  }

  // Summary
  console.log('================== Summary table (FULL / TRAIN / TEST) ==================')
  function row(label: string, r: SimResult) {
    const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
    console.log(
      `${label.padEnd(28)} | final $${r.finalDeposit.toFixed(0).padStart(6)} ` +
      `(${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%) | R/tr=${fmtR(r.rPerTr)} | WR=${r.winRate.toFixed(0)}% | ` +
      `peak $${r.peakDeposit.toFixed(0).padStart(5)} | min $${r.minDeposit.toFixed(0).padStart(4)} | DD ${r.maxDD.toFixed(1)}%`,
    )
  }
  for (const mode of SCENARIOS) {
    const g = results.get(mode)!
    console.log(`--- C fillMode=${mode} (pool FULL=${g.poolFull} TRAIN=${g.poolTrain} TEST=${g.poolTest}) ---`)
    row(`C — ${mode} FULL`, g.full)
    row(`C — ${mode} TRAIN`, g.train)
    row(`C — ${mode} TEST`, g.test)
    console.log()
  }

  // Monthly (FULL only per scenario)
  for (const mode of SCENARIOS) {
    printMonthly('FULL', results.get(mode)!.full)
    console.log()
  }

  // Save
  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `dailybreak_C_live_${Date.now()}.json`)
  const serializable: any = {}
  for (const [mode, g] of results.entries()) {
    serializable[mode] = {
      poolFull: g.poolFull, poolTrain: g.poolTrain, poolTest: g.poolTest,
      full: { ...g.full, monthly: Object.fromEntries(g.full.monthly) },
      train: { ...g.train, monthly: Object.fromEntries(g.train.monthly) },
      test: { ...g.test, monthly: Object.fromEntries(g.test.monthly) },
    }
  }
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    universe: PROD_SYMBOLS,
    variant: VARIANT_C,
    fees: { taker: TAKER_FEE, maker: MAKER_FEE, slip: TAKER_SLIP },
    results: serializable,
  }, null, 2))
  console.log(`Saved to ${outFile}`)
  console.log('=== Done ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
