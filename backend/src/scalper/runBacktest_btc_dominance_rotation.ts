/**
 * Trend Strategy #5: BTC Dominance + Altcoin Rotation.
 *
 * Idea (non-mainstream, alternative-data edge):
 *   BTC.D = BTC market cap / total crypto market cap × 100%.
 *   When BTC.D drops below SMA(20) on daily → money rotating OUT of BTC INTO alts → altseason.
 *   Go LONG basket of alts (ETH, SOL, AVAX, ADA, DOT, POL, LINK, DOGE).
 *
 * Logic:
 *   - Read BTC.D daily candles from CSV (TradingView export)
 *   - SMA(20) on BTC.D daily close
 *   - Signal LONG basket when BTC.D close < SMA(20) for first time after being above
 *   - Signal CLOSE basket when BTC.D > SMA(20) (rotation back to BTC)
 *   - Equal weight across all alts in basket
 *   - Max hold: 30 days (rotation can last weeks)
 *
 * Entry:
 *   - For each alt in basket — market BUY on UTC day start after BTC.D < SMA(20) confirmed
 *   - SL: 5% from entry (alt-coin volatility — generous)
 *   - TP: dynamic (close when BTC.D > SMA(20) recoverу)
 *
 * Position sizing: 2% risk per alt, but cap total deposit usage at 100%
 * (i.e. if 8 alts × 2% = 16% risk total — comfortable).
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_btc_dominance_rotation.ts
 *
 * CSV format expected (backend/data/btc_dominance.csv):
 *   time,open,high,low,close
 *   2025-04-01,...,55.2
 *   ... (UTC daily)
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from '../services/marginGuard'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14
const TRAIN_PCT = 0.6

const TAKER_FEE = 0.00050
const TAKER_SLIP = 0.0003

const RISK_PCT_PER_ALT = 2
const SL_PCT = 5.0   // 5% from entry
const MAX_HOLD_DAYS = 30
const SMA_PERIOD = 20

const CACHE_DIR = path.join(__dirname, '../../data/backtest')
const BTC_DOM_CSV = path.join(__dirname, '../../data/btc_dominance.csv')

// Альты в корзине (без BTC — мы покупаем то что должно outperform BTC)
const ALTS_BASKET = [
  'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'ADAUSDT',
  'DOTUSDT', 'POLUSDT', 'LINKUSDT', 'DOGEUSDT', 'XRPUSDT',
]

const VARIANT = {
  name: 'BTC.D rotation',
  startingDeposit: 320,
  maxConcurrent: 20,
  targetMarginPct: 5,
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

function aggregate5mToDaily(m5: OHLCV[]): OHLCV[] {
  const bucketMs = 24 * 3600_000
  const buckets = new Map<number, OHLCV[]>()
  for (const c of m5) {
    const b = Math.floor(c.time / bucketMs) * bucketMs
    const list = buckets.get(b) ?? []
    list.push(c); buckets.set(b, list)
  }
  const out: OHLCV[] = []
  for (const [t, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a.time - b.time)
    out.push({
      time: t, open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    })
  }
  return out
}

/**
 * Parse TradingView CSV. Format:
 *   time,open,high,low,close (header)
 *   2025-04-01T00:00:00Z,55.1,55.5,54.8,55.2
 *   or unix ms in `time`
 */
function parseBtcDominanceCsv(filePath: string): OHLCV[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`BTC.D CSV not found at ${filePath}. Export from TradingView CRYPTOCAP:BTC.D daily → save as CSV.`)
  }
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  const header = lines[0].toLowerCase()
  const cols = header.split(',').map(s => s.trim())
  const idxTime = cols.findIndex(c => c === 'time' || c === 'date' || c === 'timestamp')
  const idxOpen = cols.findIndex(c => c === 'open')
  const idxHigh = cols.findIndex(c => c === 'high')
  const idxLow = cols.findIndex(c => c === 'low')
  const idxClose = cols.findIndex(c => c === 'close')
  if (idxTime < 0 || idxClose < 0) throw new Error(`CSV missing time/close column: ${header}`)
  const candles: OHLCV[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const t = parts[idxTime].trim()
    let ms: number
    if (/^\d+$/.test(t)) ms = parseInt(t, 10)
    else ms = new Date(t).getTime()
    if (!isFinite(ms)) continue
    // Normalize to UTC day start
    ms = Math.floor(ms / 86400_000) * 86400_000
    const close = parseFloat(parts[idxClose])
    if (!isFinite(close)) continue
    candles.push({
      time: ms,
      open: idxOpen >= 0 ? parseFloat(parts[idxOpen]) || close : close,
      high: idxHigh >= 0 ? parseFloat(parts[idxHigh]) || close : close,
      low: idxLow >= 0 ? parseFloat(parts[idxLow]) || close : close,
      close,
      volume: 0,
    })
  }
  candles.sort((a, b) => a.time - b.time)
  return candles
}

function sma(values: number[], period: number): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    out.push(sum / period)
  }
  return out
}

interface RotationEvent {
  time: number
  type: 'ALT_LONG_START' | 'ALT_LONG_END'
}

/**
 * Detect rotation signals from BTC.D daily candles.
 * Signal: when btc.close < sma → start altseason
 *         when btc.close > sma → end altseason
 * Issue events at the START of next UTC day (после закрытия дневной свечи).
 */
function detectRotations(btcDom: OHLCV[]): RotationEvent[] {
  const closes = btcDom.map(c => c.close)
  const smaArr = sma(closes, SMA_PERIOD)
  const events: RotationEvent[] = []
  let isAltseason = false
  for (let i = SMA_PERIOD; i < btcDom.length; i++) {
    const c = btcDom[i]
    const smaVal = smaArr[i]
    if (!isFinite(smaVal)) continue
    const belowSma = c.close < smaVal
    if (belowSma && !isAltseason) {
      // Signal start at NEXT day open (UTC bar start)
      events.push({ time: c.time + 86400_000, type: 'ALT_LONG_START' })
      isAltseason = true
    } else if (!belowSma && isAltseason) {
      events.push({ time: c.time + 86400_000, type: 'ALT_LONG_END' })
      isAltseason = false
    }
  }
  return events
}

interface AltTrade {
  symbol: string
  entryTime: number
  entryPrice: number
  sl: number
  exitTime: number
  exitPrice: number
  exitReason: 'ROTATION_END' | 'SL' | 'MAX_HOLD'
  r: number
  netPnlUsd: number
  positionSizeUsd: number
  leverage: number
}

function simulateBasket(
  events: RotationEvent[],
  altCandlesDaily: Map<string, OHLCV[]>,
): { trades: AltTrade[]; rotations: number } {
  const trades: AltTrade[] = []
  let openTrades: AltTrade[] = []
  let rotationCount = 0

  for (const event of events) {
    if (event.type === 'ALT_LONG_START') {
      rotationCount++
      // Открываем LONG на ВСЕХ alts в basket
      for (const sym of ALTS_BASKET) {
        const candles = altCandlesDaily.get(sym)
        if (!candles) continue
        // Find day matching event.time
        const idx = candles.findIndex(c => c.time >= event.time)
        if (idx < 0) continue
        const entryDay = candles[idx]
        const entryPrice = entryDay.open
        const sl = entryPrice * (1 - SL_PCT / 100)
        openTrades.push({
          symbol: sym, entryTime: entryDay.time,
          entryPrice, sl,
          exitTime: 0, exitPrice: 0, exitReason: 'ROTATION_END',
          r: 0, netPnlUsd: 0, positionSizeUsd: 0, leverage: 0,
        })
      }
    } else if (event.type === 'ALT_LONG_END') {
      // Закрываем все открытые trades по open следующего дня
      for (const trade of openTrades) {
        const candles = altCandlesDaily.get(trade.symbol)
        if (!candles) continue
        const exitIdx = candles.findIndex(c => c.time >= event.time)
        if (exitIdx < 0) continue
        // Walk through days from entry to exit, check SL hits
        const entryIdx = candles.findIndex(c => c.time >= trade.entryTime)
        let exitPrice = 0, exitTime = 0, reason: AltTrade['exitReason'] = 'ROTATION_END'
        for (let j = entryIdx; j < exitIdx; j++) {
          const c = candles[j]
          if (c.low <= trade.sl) {
            exitPrice = trade.sl
            exitTime = c.time
            reason = 'SL'
            break
          }
          // Max hold
          if ((c.time - trade.entryTime) / 86400_000 >= MAX_HOLD_DAYS) {
            exitPrice = c.close
            exitTime = c.time
            reason = 'MAX_HOLD'
            break
          }
        }
        if (exitTime === 0) {
          exitPrice = candles[exitIdx].open
          exitTime = candles[exitIdx].time
          reason = 'ROTATION_END'
        }
        trade.exitPrice = exitPrice
        trade.exitTime = exitTime
        trade.exitReason = reason
        // R: 5% SL distance = risk
        trade.r = ((exitPrice - trade.entryPrice) / trade.entryPrice) / (SL_PCT / 100)
        trades.push(trade)
      }
      openTrades = []
    }
  }

  // Close any still-open trades at last known candle
  for (const trade of openTrades) {
    const candles = altCandlesDaily.get(trade.symbol)
    if (!candles) continue
    const lastCandle = candles[candles.length - 1]
    trade.exitPrice = lastCandle.close
    trade.exitTime = lastCandle.time
    trade.exitReason = 'MAX_HOLD'
    trade.r = ((lastCandle.close - trade.entryPrice) / trade.entryPrice) / (SL_PCT / 100)
    trades.push(trade)
  }

  return { trades, rotations: rotationCount }
}

function simulatePortfolio(trades: AltTrade[]): {
  startingDeposit: number; finalDeposit: number; peakDeposit: number; minDeposit: number; maxDD: number
  trades: number; wins: number; winRate: number; totalR: number; rPerTr: number
  totalFeesUsd: number; rotationCount: number
} {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime)
  let currentDeposit = VARIANT.startingDeposit
  let peak = VARIANT.startingDeposit
  let trough = VARIANT.startingDeposit
  let maxDD = 0
  let totalFees = 0
  let wins = 0, totalR = 0

  // Группируем by entryTime — все trades одной rotation открываются одновременно
  const byEntryTime = new Map<number, AltTrade[]>()
  for (const t of sorted) {
    if (!byEntryTime.has(t.entryTime)) byEntryTime.set(t.entryTime, [])
    byEntryTime.get(t.entryTime)!.push(t)
  }

  for (const [, group] of [...byEntryTime.entries()].sort((a, b) => a[0] - b[0])) {
    // Open all trades in group at same time with equal sizing
    const depositBefore = currentDeposit
    const sizings: { trade: AltTrade; size: number; units: number; effEntry: number }[] = []
    for (const trade of group) {
      const effEntry = trade.entryPrice * (1 + TAKER_SLIP)  // taker slip
      const sizing = computeSizing({
        symbol: trade.symbol, deposit: depositBefore,
        riskPct: RISK_PCT_PER_ALT, targetMarginPct: VARIANT.targetMarginPct,
        entry: effEntry, sl: trade.sl,
      })
      if (!sizing) continue
      trade.positionSizeUsd = sizing.positionSizeUsd
      trade.leverage = sizing.leverage
      sizings.push({ trade, size: sizing.positionSizeUsd, units: sizing.positionUnits, effEntry })

      // Entry fee
      const entryFee = sizing.positionUnits * effEntry * TAKER_FEE
      currentDeposit -= entryFee
      totalFees += entryFee
    }

    if (currentDeposit > peak) peak = currentDeposit
    if (currentDeposit < trough) trough = currentDeposit

    // Resolve exit при exitTime
    for (const s of sizings) {
      const exitPrice = s.trade.exitPrice * (1 - TAKER_SLIP)  // SL/exit slip
      const grossPnl = (exitPrice - s.effEntry) * s.units
      const exitNotional = s.units * exitPrice
      const exitFee = exitNotional * TAKER_FEE
      const netPnl = grossPnl - exitFee
      currentDeposit += netPnl
      totalFees += exitFee
      s.trade.netPnlUsd = netPnl
      totalR += s.trade.r
      if (s.trade.r > 0) wins++
      if (currentDeposit > peak) peak = currentDeposit
      if (currentDeposit < trough) trough = currentDeposit
      const dd = ((peak - currentDeposit) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  return {
    startingDeposit: VARIANT.startingDeposit,
    finalDeposit: currentDeposit, peakDeposit: peak, minDeposit: trough, maxDD,
    trades: trades.length, wins, winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalR, rPerTr: trades.length > 0 ? totalR / trades.length : 0,
    totalFeesUsd: totalFees, rotationCount: 0,
  }
}

async function main() {
  console.log('BTC Dominance + Altcoin Rotation backtest')
  console.log(`Signal: BTC.D close < SMA(${SMA_PERIOD}) daily → LONG basket of ${ALTS_BASKET.length} alts`)
  console.log(`Basket: ${ALTS_BASKET.join(', ')}`)
  console.log(`SL: ${SL_PCT}% | Max hold: ${MAX_HOLD_DAYS} days | Risk per alt: ${RISK_PCT_PER_ALT}%`)
  console.log()

  console.log(`Loading BTC.D from ${BTC_DOM_CSV}...`)
  let btcDom: OHLCV[]
  try {
    btcDom = parseBtcDominanceCsv(BTC_DOM_CSV)
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`)
    console.error()
    console.error('To run this backtest:')
    console.error('  1. Open TradingView, search for CRYPTOCAP:BTC.D')
    console.error('  2. Set Daily timeframe')
    console.error('  3. Export chart data → CSV')
    console.error('  4. Save as backend/data/btc_dominance.csv')
    process.exit(1)
  }
  btcDom = sliceLastDays(btcDom, DAYS_BACK)
  console.log(`BTC.D loaded: ${btcDom.length} daily candles, from ${new Date(btcDom[0].time).toISOString().slice(0, 10)} to ${new Date(btcDom[btcDom.length - 1].time).toISOString().slice(0, 10)}`)

  // Compute SMA distribution for context
  const closes = btcDom.map(c => c.close)
  const smaArr = sma(closes, SMA_PERIOD)
  const finalBtcD = closes[closes.length - 1]
  const finalSma = smaArr[smaArr.length - 1]
  console.log(`Current BTC.D = ${finalBtcD.toFixed(2)}% | SMA(${SMA_PERIOD}) = ${finalSma.toFixed(2)}% | ${finalBtcD < finalSma ? '↓ ALTSEASON' : '↑ BTC dominates'}`)
  console.log()

  console.log('Detecting rotation events...')
  const events = detectRotations(btcDom)
  console.log(`Found ${events.length} events (${events.filter(e => e.type === 'ALT_LONG_START').length} altseason starts, ${events.filter(e => e.type === 'ALT_LONG_END').length} ends)`)
  for (const e of events.slice(0, 20)) {
    console.log(`  ${new Date(e.time).toISOString().slice(0, 10)} | ${e.type}`)
  }
  if (events.length > 20) console.log(`  ... and ${events.length - 20} more`)
  console.log()

  console.log('Loading alt daily candles...')
  const altCandlesDaily = new Map<string, OHLCV[]>()
  for (const sym of ALTS_BASKET) {
    const cp = path.join(CACHE_DIR, `bybit_${sym}_5m.json`)
    if (!fs.existsSync(cp)) { console.warn(`[skip] ${sym} not cached`); continue }
    const m5all = await loadHistorical(sym, '5m', MONTHS_BACK, 'bybit', 'linear')
    const m5 = sliceLastDays(m5all, DAYS_BACK)
    if (m5.length < 1000) { console.warn(`[skip] ${sym} short`); continue }
    altCandlesDaily.set(sym, aggregate5mToDaily(m5))
  }
  console.log(`Loaded ${altCandlesDaily.size} alts\n`)

  console.log('Simulating rotation trades...')
  const { trades } = simulateBasket(events, altCandlesDaily)
  console.log(`Generated ${trades.length} alt trades from ${events.length / 2} rotations\n`)

  // Per-rotation summary
  console.log('--- Rotations summary ---')
  const byRotation = new Map<number, AltTrade[]>()
  for (const t of trades) {
    if (!byRotation.has(t.entryTime)) byRotation.set(t.entryTime, [])
    byRotation.get(t.entryTime)!.push(t)
  }
  for (const [time, group] of [...byRotation.entries()].sort((a, b) => a[0] - b[0])) {
    const dateStr = new Date(time).toISOString().slice(0, 10)
    const exitTime = Math.max(...group.map(t => t.exitTime))
    const days = Math.round((exitTime - time) / 86400_000)
    const wins = group.filter(t => t.r > 0).length
    const totalR = group.reduce((s, t) => s + t.r, 0)
    const exitDate = new Date(exitTime).toISOString().slice(0, 10)
    const slHits = group.filter(t => t.exitReason === 'SL').length
    console.log(`  ${dateStr} → ${exitDate} (${days}d) | trades=${group.length} W=${wins} SL=${slHits} | totalR=${(totalR >= 0 ? '+' : '') + totalR.toFixed(2)}`)
  }
  console.log()

  // Portfolio
  console.log('--- Portfolio simulation ---')
  const r = simulatePortfolio(trades)
  const ret = ((r.finalDeposit / r.startingDeposit - 1) * 100)
  console.log(`trades=${r.trades} | WR=${r.winRate.toFixed(0)}% | totalR=${(r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(2)} R/tr=${(r.rPerTr >= 0 ? '+' : '') + r.rPerTr.toFixed(2)}`)
  console.log(`final $${r.finalDeposit.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%) | peak $${r.peakDeposit.toFixed(0)} | min $${r.minDeposit.toFixed(0)} | DD ${r.maxDD.toFixed(1)}%`)
  console.log(`fees $${r.totalFeesUsd.toFixed(2)}`)

  // TRAIN/TEST split
  const trainEnd = Date.now() - Math.round(DAYS_BACK * (1 - TRAIN_PCT)) * 24 * 60 * 60_000
  const trainTrades = trades.filter(t => t.entryTime < trainEnd)
  const testTrades = trades.filter(t => t.entryTime >= trainEnd)
  console.log()
  console.log('--- TRAIN (60%) ---')
  const trR = simulatePortfolio(trainTrades)
  console.log(`trades=${trR.trades} | WR=${trR.winRate.toFixed(0)}% | totalR=${(trR.totalR >= 0 ? '+' : '') + trR.totalR.toFixed(2)} R/tr=${(trR.rPerTr >= 0 ? '+' : '') + trR.rPerTr.toFixed(2)} | final $${trR.finalDeposit.toFixed(2)} (${((trR.finalDeposit / trR.startingDeposit - 1) * 100).toFixed(1)}%) DD ${trR.maxDD.toFixed(1)}%`)
  console.log('--- TEST (40%) ---')
  const teR = simulatePortfolio(testTrades)
  console.log(`trades=${teR.trades} | WR=${teR.winRate.toFixed(0)}% | totalR=${(teR.totalR >= 0 ? '+' : '') + teR.totalR.toFixed(2)} R/tr=${(teR.rPerTr >= 0 ? '+' : '') + teR.rPerTr.toFixed(2)} | final $${teR.finalDeposit.toFixed(2)} (${((teR.finalDeposit / teR.startingDeposit - 1) * 100).toFixed(1)}%) DD ${teR.maxDD.toFixed(1)}%`)

  const trainRet = (trR.finalDeposit / trR.startingDeposit - 1) * 100
  const testRet = (teR.finalDeposit / teR.startingDeposit - 1) * 100
  console.log()
  console.log('=== Verdict ===')
  console.log(`TRAIN: ${trainRet >= 0 ? '+' : ''}${trainRet.toFixed(0)}% | TEST: ${testRet >= 0 ? '+' : ''}${testRet.toFixed(0)}%`)
  console.log(`Robust: ${trainRet > 0 && testRet > 0 ? '✓ YES' : '✗ NO'}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `btc_dom_rotation_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'BTC.D + Alt Rotation', params: { SMA_PERIOD, SL_PCT, MAX_HOLD_DAYS, RISK_PCT_PER_ALT },
    basket: ALTS_BASKET, variant: VARIANT,
    events, trades, fullResult: r, trainResult: trR, testResult: teR,
  }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
