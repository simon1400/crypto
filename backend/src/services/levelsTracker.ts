/**
 * Levels Tracker — checks open levels signals against latest candle highs/lows
 * and updates status (TP1/TP2/TP3 hit, SL hit, expired).
 *
 * Trailing SL logic mirrors the ladder backtester:
 *   - After TP1 → currentStop = entryPrice (BE)
 *   - After TPn (n>1) → currentStop = TP(n-1)
 *
 * Closing percentages: 50% on TP1, 30% on TP2, 20% on TP3 (default ladder splits).
 */

import { prisma } from '../db/prisma'
import { OHLCV } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import { loadForexHistorical } from '../scalper/forexLoader'
import { sendNotification } from './notifier'

const SPLITS = [0.5, 0.3, 0.2] // must match ladderBacktester defaults

interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

async function loadRecent5m(symbol: string, market: 'FOREX' | 'CRYPTO'): Promise<OHLCV[]> {
  if (market === 'FOREX') return loadForexHistorical(symbol, '5m', 1)
  return loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
}

async function trackOne(sig: any, recentCandles: OHLCV[]): Promise<void> {
  // Walk every candle that's NEWER than the signal's lastPriceCheckAt (or createdAt if first time)
  const sinceMs = sig.lastPriceCheckAt
    ? new Date(sig.lastPriceCheckAt).getTime()
    : new Date(sig.createdAt).getTime()
  const newCandles = recentCandles.filter((c) => c.time > sinceMs)
  if (newCandles.length === 0) return

  const tpLadder: number[] = (sig.tpLadder as any[]) ?? []
  const isLong = sig.side === 'BUY'
  const entry = sig.entryPrice
  const initialRisk = Math.abs(entry - sig.initialStop)

  // Determine where we currently are in the ladder
  let nextTpIdx = 0
  let remainingFrac = 1
  const fills: CloseRecord[] = ((sig.closes as any[]) ?? []).map((c) => c as CloseRecord)
  for (const f of fills) {
    if (f.reason === 'TP1') { nextTpIdx = Math.max(nextTpIdx, 1); remainingFrac -= SPLITS[0] }
    else if (f.reason === 'TP2') { nextTpIdx = Math.max(nextTpIdx, 2); remainingFrac -= SPLITS[1] }
    else if (f.reason === 'TP3') { nextTpIdx = Math.max(nextTpIdx, 3); remainingFrac -= SPLITS[2] }
  }
  if (remainingFrac < 1e-6) return // already fully closed

  let currentStop: number = sig.currentStop
  let realizedR: number = sig.realizedR ?? 0
  let status: string = sig.status

  for (const c of newCandles) {
    const slHit = isLong ? c.low <= currentStop : c.high >= currentStop
    if (slHit) {
      const pnlR = ((isLong ? currentStop - entry : entry - currentStop) / initialRisk) * remainingFrac
      realizedR += pnlR
      fills.push({
        price: currentStop, percent: remainingFrac * 100, pnlR,
        closedAt: new Date(c.time).toISOString(),
        reason: nextTpIdx === 0 ? 'SL' : nextTpIdx === 1 ? 'SL' : 'SL', // SL after TPs → still 'SL' but at trailing level
      })
      remainingFrac = 0
      status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      await sendNotification('LEVELS_SL_HIT' as any, {
        id: sig.id, symbol: sig.symbol, side: sig.side, level: sig.level,
        slPrice: currentStop, realizedR, reasonText: nextTpIdx === 0 ? 'Initial SL' : `Trailing SL after TP${nextTpIdx}`,
      })
      break
    }

    // Walk through TPs in ladder order, allowing multiple hits in one bar
    while (nextTpIdx < tpLadder.length && remainingFrac > 1e-6) {
      const tp = tpLadder[nextTpIdx]
      const tpHit = isLong ? c.high >= tp : c.low <= tp
      if (!tpHit) break

      const splitFrac = SPLITS[nextTpIdx] ?? remainingFrac
      const fillFrac = Math.min(splitFrac, remainingFrac)
      const pnlR = ((isLong ? tp - entry : entry - tp) / initialRisk) * fillFrac
      realizedR += pnlR
      const tpName = (`TP${nextTpIdx + 1}`) as 'TP1' | 'TP2' | 'TP3'
      fills.push({
        price: tp, percent: fillFrac * 100, pnlR,
        closedAt: new Date(c.time).toISOString(),
        reason: tpName,
      })
      remainingFrac -= fillFrac
      // Trailing SL move
      if (nextTpIdx === 0) currentStop = entry           // BE after TP1
      else currentStop = tpLadder[nextTpIdx - 1]         // previous TP after TP(n>1)
      // Status step
      status = (nextTpIdx === 0 ? 'TP1_HIT' : nextTpIdx === 1 ? 'TP2_HIT' : 'TP3_HIT')
      // Telegram
      await sendNotification(`LEVELS_${tpName}_HIT` as any, {
        id: sig.id, symbol: sig.symbol, side: sig.side, level: sig.level,
        tpPrice: tp, percent: fillFrac * 100, pnlR, realizedR,
      })
      nextTpIdx++

      if (remainingFrac < 1e-6) {
        status = 'CLOSED'
        break
      }
    }
    if (status === 'CLOSED' || status === 'SL_HIT') break
    // Activate from NEW → ACTIVE on first observed price after creation
    if (status === 'NEW') status = 'ACTIVE'
  }

  // Expiry check (only if still open)
  if (status !== 'CLOSED' && status !== 'SL_HIT' && sig.expiresAt && new Date(sig.expiresAt) < new Date()) {
    if (remainingFrac > 1e-6) {
      const lastPrice = newCandles[newCandles.length - 1].close
      const pnlR = ((isLong ? lastPrice - entry : entry - lastPrice) / initialRisk) * remainingFrac
      realizedR += pnlR
      fills.push({
        price: lastPrice, percent: remainingFrac * 100, pnlR,
        closedAt: new Date().toISOString(), reason: 'EXPIRED',
      })
    }
    status = 'EXPIRED'
    await sendNotification('LEVELS_EXPIRED' as any, {
      id: sig.id, symbol: sig.symbol, side: sig.side, level: sig.level, realizedR,
    })
  }

  const lastCandle = newCandles[newCandles.length - 1]
  await prisma.levelsSignal.update({
    where: { id: sig.id },
    data: {
      status,
      currentStop,
      realizedR,
      closes: fills as any,
      lastPriceCheck: lastCandle.close,
      lastPriceCheckAt: new Date(lastCandle.time),
      ...(status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED'
        ? { closedAt: new Date() } : {}),
    },
  })
}

export async function runLevelsTrackerCycle(): Promise<number> {
  const open = await prisma.levelsSignal.findMany({
    where: { status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return 0

  // Group by symbol — load candles once per symbol
  const bySymbol = new Map<string, any[]>()
  for (const s of open) {
    const list = bySymbol.get(s.symbol) ?? []
    list.push(s)
    bySymbol.set(s.symbol, list)
  }

  let processed = 0
  for (const [symbol, sigs] of bySymbol) {
    try {
      const market = sigs[0].market as 'FOREX' | 'CRYPTO'
      const candles = await loadRecent5m(symbol, market)
      for (const sig of sigs) {
        await trackOne(sig, candles)
        processed++
      }
    } catch (e: any) {
      console.error(`[LevelsTracker] ${symbol} failed:`, e.message)
    }
  }
  return processed
}

let trackerInterval: NodeJS.Timeout | null = null

export function startLevelsTracker(): void {
  if (trackerInterval) return
  const tick = async () => {
    try {
      await runLevelsTrackerCycle()
    } catch (e: any) {
      console.error('[LevelsTracker] tick error:', e.message)
    }
  }
  setTimeout(tick, 60_000) // start 1 min after boot
  trackerInterval = setInterval(tick, 5 * 60_000)
  console.log('[LevelsTracker] started (5 min interval)')
}

export function stopLevelsTracker(): void {
  if (trackerInterval) {
    clearInterval(trackerInterval)
    trackerInterval = null
  }
}
