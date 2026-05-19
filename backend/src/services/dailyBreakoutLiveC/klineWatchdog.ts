/**
 * Kline-replay safety net for Live C SL/TP detection.
 *
 * The primary exit path is aggTrade WS → trackLiveTrade (sub-second).
 * But aggTrade can miss ticks: WS reconnect gaps, throttle on bursts, or
 * symbols where the wick that pierced our level didn't generate a matched
 * aggTrade we received. The exchange-side STOP_MARKET covers SL, but TPs
 * are fully virtual on our side — a missed wick = TP never fires until the
 * price comes back, which may never happen the same day.
 *
 * This watchdog runs every 30s and, for each active position, fetches the
 * recent 1m klines from Binance Futures and replays them against the trade's
 * SL and the next-unhit TP using candle high/low (paper-trader semantics:
 * for LONG, low triggers SL and high triggers TP; SHORT is mirrored). If a
 * crossing is found we feed two synthetic ticks (worst-case first) through
 * trackLiveTrade so the existing exit machinery (MARKET reduceOnly, closes[]
 * record, SL retrail, Telegram, money recompute) does the work.
 *
 * This complements aggTrade WS — both can fire for the same level; the
 * tradeBusy lock + closes[] idempotency check in exitLiveTradeSlice make
 * duplicates safe.
 */

import { prisma } from '../../db/prisma'
import { fetchKlines } from '../klines'
import { LOG, state, ACTIVE_STATUSES } from './state'
import { trackLiveTrade } from './virtualSltp'

const WATCHDOG_INTERVAL_MS = 30 * 1000
const KLINE_LOOKBACK_MIN = 10  // 10 × 1m candles per check (covers >5min gaps)

export const watchdogGuard: { busy: boolean } = { busy: false }

/**
 * One pass: load active LIVE-C trades, group by symbol (one kline fetch per
 * symbol), replay against each trade's levels. Writes lastPriceCheckAt at the
 * end so subsequent passes only consider freshly closed candles.
 */
export async function runKlineWatchdog(): Promise<void> {
  if (watchdogGuard.busy) return
  if (!state.current) return
  watchdogGuard.busy = true

  try {
    const trades = await prisma.breakoutLiveTradeC.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
    })
    if (trades.length === 0) return

    const bySymbol = new Map<string, typeof trades>()
    for (const t of trades) {
      const arr = bySymbol.get(t.symbol) ?? []
      arr.push(t)
      bySymbol.set(t.symbol, arr)
    }

    for (const [symbol, syms] of bySymbol) {
      let candles: Array<{ time: number; high: number; low: number; close: number }>
      try {
        candles = await fetchKlines(symbol, '1m', KLINE_LOOKBACK_MIN, 'binance-futures')
      } catch (e: any) {
        console.warn(`${LOG} watchdog: klines ${symbol} failed: ${e?.message ?? e}`)
        continue
      }
      if (candles.length === 0) continue

      for (const trade of syms) {
        await replayCandlesForTrade(trade, candles).catch((e) =>
          console.warn(`${LOG} watchdog: replay #${trade.id} ${trade.symbol} threw: ${e?.message ?? e}`),
        )
      }
    }
  } catch (e: any) {
    console.error(`${LOG} watchdog: ${e?.message ?? e}`)
  } finally {
    watchdogGuard.busy = false
  }
}

/**
 * Walk newly closed candles for this trade and feed worst-case → best-case
 * synthetic ticks through trackLiveTrade. If the trade closes mid-replay we
 * stop (trackLiveTrade itself checks status and returns early).
 *
 * sinceMs = max(lastPriceCheckAt, openedAt). Anything older was processed
 * by a prior watchdog pass.
 */
async function replayCandlesForTrade(
  trade: any,
  candles: Array<{ time: number; high: number; low: number; close: number }>,
): Promise<void> {
  const sinceMs = trade.lastPriceCheckAt
    ? new Date(trade.lastPriceCheckAt).getTime()
    : new Date(trade.openedAt).getTime()

  // fetchKlines returns time in SECONDS — convert to ms to compare.
  const newCandles = candles.filter((c) => c.time * 1000 > sinceMs)
  if (newCandles.length === 0) return

  const isLong = trade.side === 'BUY'

  for (const c of newCandles) {
    const candleTs = c.time * 1000
    // Worst case first (SL side), then best case (TP side). trackLiveTrade
    // handles SL hit + early return; if SL didn't fire, TP check follows.
    const worst = isLong ? c.low : c.high
    const best = isLong ? c.high : c.low

    // Re-read the row each call — trackLiveTrade may have advanced status /
    // closes[] / currentStop between iterations.
    const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
    if (!fresh) return
    if (!ACTIVE_STATUSES.includes(fresh.status as any)) return

    await trackLiveTrade(fresh, worst, candleTs)

    const fresh2 = await prisma.breakoutLiveTradeC.findUnique({ where: { id: trade.id } })
    if (!fresh2) return
    if (!ACTIVE_STATUSES.includes(fresh2.status as any)) return

    await trackLiveTrade(fresh2, best, candleTs)
  }

  const lastCandleMs = newCandles[newCandles.length - 1].time * 1000
  await prisma.breakoutLiveTradeC.updateMany({
    where: { id: trade.id, status: { in: [...ACTIVE_STATUSES] } },
    data: { lastPriceCheckAt: new Date(lastCandleMs), lastPriceCheck: newCandles[newCandles.length - 1].close },
  }).catch(() => { /* noop */ })
}

export function getWatchdogInterval(): number { return WATCHDOG_INTERVAL_MS }
