/**
 * Circuit breaker — daily loss limit for live trading.
 *
 * Trips when EITHER threshold is exceeded:
 *   - sum(realizedR) <= -cfg.dailyLossLimitR   (default -8R)
 *   - sum(netPnlUsd) / startOfDayDeposit <= -cfg.dailyLossLimitPct / 100   (default -10%)
 *
 * When tripped: block new placements + cancel any still-pending limits on the
 * exchange. Existing OPEN positions are left alone (their SL/TP run normally).
 */

import { prisma } from '../../db/prisma'
import type { BinanceFuturesClient } from '../exchanges/binanceFutures'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, breakerGuard } from './state'
import { fmtPnl } from './formatters'
import { sendLiveTelegram } from './telegram'

export interface CircuitBreakerResult {
  tripped: boolean
  reason: string
  realizedR: number
  netPnlUsd: number
  pnlPct: number
}

/**
 * Compute today's UTC realized loss across all live C trades closed today.
 *
 * Start-of-day deposit is reconstructed as currentDepositUsd - sum(netPnlUsd today),
 * same approach as paper C. We pull currentDepositUsd from the most recent
 * snapshot rather than calling Binance — the breaker needs to be cheap (called
 * every placement cycle).
 */
export async function isLiveCircuitBreakerTripped(cfg: any): Promise<CircuitBreakerResult> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  // Sum from rows closed today UTC.
  const closedToday = await prisma.breakoutLiveTradeC.findMany({
    where: {
      closedAt: { gte: todayStart },
      status: { in: ['CLOSED', 'SL_HIT', 'TP3_HIT'] },
    },
    select: { realizedR: true, netPnlUsd: true },
  })

  let sumR = 0
  let sumPnl = 0
  for (const t of closedToday) {
    sumR += t.realizedR ?? 0
    sumPnl += t.netPnlUsd ?? 0
  }

  const startOfDayDeposit = Math.max(1, (cfg.currentDepositUsd ?? 1) - sumPnl)
  const pnlPct = (sumPnl / startOfDayDeposit) * 100

  const rLimit = -Math.abs(cfg.dailyLossLimitR ?? 8)
  const pctLimit = -Math.abs(cfg.dailyLossLimitPct ?? 10)

  if (sumR <= rLimit) {
    return {
      tripped: true,
      reason: `daily R breaker: ${sumR.toFixed(2)}R <= ${rLimit}R`,
      realizedR: sumR, netPnlUsd: sumPnl, pnlPct,
    }
  }
  if (pnlPct <= pctLimit) {
    return {
      tripped: true,
      reason: `daily PnL breaker: ${pnlPct.toFixed(2)}% <= ${pctLimit}%`,
      realizedR: sumR, netPnlUsd: sumPnl, pnlPct,
    }
  }
  return { tripped: false, reason: '', realizedR: sumR, netPnlUsd: sumPnl, pnlPct }
}

/**
 * When the breaker trips, cancel all still-pending entry limits on the
 * exchange so no new exposure opens. Existing OPEN positions are left alone
 * (they have real SL/TP children that will close them in normal flow).
 */
export async function cancelAllPendingForBreaker(client: BinanceFuturesClient, reason: string): Promise<void> {
  const pending = await prisma.breakoutLiveTradeC.findMany({
    where: { limitOrderState: 'PENDING_LIMIT' },
  })
  for (const t of pending) {
    try {
      if (t.binanceClientOrderId) {
        await client.cancelOrder(t.symbol, { origClientOrderId: t.binanceClientOrderId })
      }
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} breaker cancel ${t.symbol} failed: ${e.message}`)
      }
    }
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: new Date(),
      },
    })
  }
  if (pending.length > 0) {
    console.log(`${LOG} breaker cancelled ${pending.length} PENDING limits (${reason})`)
  }
}

export async function maybeNotifyBreaker(cb: { reason: string; realizedR: number; netPnlUsd: number; pnlPct: number }): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (breakerGuard.notifiedDate === today) return
  breakerGuard.notifiedDate = today
  await sendLiveTelegram([
    `🛑 <b>Circuit breaker</b>  · сегодняшняя торговля остановлена`,
    `━━━━━━━━━━━━━━━━━━`,
    `❗ ${cb.reason}`,
    `📈 Σ R    ${cb.realizedR.toFixed(2)}R`,
    `💵 Σ P&L  <b>${fmtPnl(cb.netPnlUsd)}</b> (${cb.pnlPct.toFixed(2)}%)`,
    `🚫 Новые лимитки заблокированы, висящие отменены до следующего UTC дня.`,
  ].join('\n'))
}
