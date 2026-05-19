/**
 * Gating helpers — checks that decide whether a new paper trade should open.
 *
 * - `isVariantBusyOnSymbol`: per-day, per-symbol entry guard
 * - `isCircuitBreakerTripped`: daily UTC loss limit (R or %)
 */

import { BreakoutVariant, tradeModel } from '../breakoutVariant'
import { PaperConfig } from './types'

/**
 * Returns true if a variant already "took" the symbol for this UTC day and
 * should not open another trade on it. A variant is considered busy when:
 *   1. There is any trade with openedAt in the current UTC day (regardless of
 *      its current status — OPEN, TP1_HIT, CLOSED, SL_HIT, EXPIRED — once today's
 *      slot was used, it stays used until midnight UTC).
 *   2. There is an active trade right now (OPEN/TP1_HIT/TP2_HIT) regardless of
 *      open date — covers a TP1+ trade carrying over from a previous day. Such a
 *      position is still in the market and a new entry would conflict on Bybit.
 *
 * A trade that opened yesterday and closed earlier today is NOT busy: that's
 * yesterday's setup running to completion, today's slot is still free for a
 * fresh breakout.
 */
export async function isVariantBusyOnSymbol(
  symbol: string,
  utcDate: string,
  variant: BreakoutVariant,
): Promise<boolean> {
  const tm = tradeModel(variant) as any
  const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`)

  const found = await tm.findFirst({
    where: {
      symbol,
      OR: [
        // Rule 1: any trade opened today (regardless of current status)
        { openedAt: { gte: dayStart, lte: dayEnd } },
        // Rule 2: any currently active trade (carrying over from prior day)
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      ],
    },
    select: { id: true },
  })
  return !!found
}

// In-memory dedup for circuit-breaker Telegram alerts. Key = `${variant}-${utcDate}`.
// Cleared on process restart — acceptable since CB state itself is recomputed each tick.
export const cbTelegramSent = new Set<string>()

/**
 * Daily circuit breaker — trip if EITHER condition holds for today's UTC closed trades:
 *   1. sum(realizedR) <= -dailyLossLimitR (default -8R)
 *   2. sum(netPnlUsd) / startOfDayDeposit <= -dailyLossLimitPct/100 (default -10%)
 *
 * Start-of-day deposit is reconstructed as currentDepositUsd − sum(netPnlUsd today UTC),
 * so it represents the deposit at 00:00 UTC before any of today's trades closed.
 *
 * Open positions continue to be tracked (trailing SL, EOD-FLAT still run). Only
 * NEW entries are blocked until next UTC day. Resets automatically at 00:00 UTC
 * because the today-UTC filter excludes prior days.
 */
export async function isCircuitBreakerTripped(
  cfg: PaperConfig, variant: BreakoutVariant,
): Promise<{ tripped: boolean; reason?: string; pnlPctToday?: number; rToday?: number }> {
  const tm = tradeModel(variant) as any
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const closedToday = await tm.findMany({
    where: {
      status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] },
      closedAt: { gte: todayStart },
    },
    select: { realizedR: true, netPnlUsd: true },
  })
  if (closedToday.length === 0) return { tripped: false }

  const sumR = closedToday.reduce((s: number, t: any) => s + (t.realizedR ?? 0), 0)
  const sumPnl = closedToday.reduce((s: number, t: any) => s + (t.netPnlUsd ?? 0), 0)
  // Start-of-day deposit = current − today's realised PnL. Defensive max(1) so
  // a depleted account doesn't divide by ~0.
  const startOfDayDeposit = Math.max(1, cfg.currentDepositUsd - sumPnl)
  const pnlPct = (sumPnl / startOfDayDeposit) * 100

  const rLimitTripped = sumR <= -cfg.dailyLossLimitR
  const pctLimitTripped = pnlPct <= -cfg.dailyLossLimitPct

  if (rLimitTripped || pctLimitTripped) {
    const reasons: string[] = []
    if (rLimitTripped) reasons.push(`R за день ${sumR.toFixed(2)} <= -${cfg.dailyLossLimitR}`)
    if (pctLimitTripped) reasons.push(`P&L за день ${pnlPct.toFixed(1)}% <= -${cfg.dailyLossLimitPct}%`)
    return {
      tripped: true,
      reason: `daily circuit breaker: ${reasons.join(' и ')} (${closedToday.length} закрытых сегодня)`,
      pnlPctToday: pnlPct,
      rToday: sumR,
    }
  }
  return { tripped: false, pnlPctToday: pnlPct, rToday: sumR }
}
