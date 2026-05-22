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
import { LOG, breakerGuard, snapshot } from './state'
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

  // Slice-level P&L attribution. The OLD method (sumPnl += t.netPnlUsd for every
  // trade closedAt today) over-counted partial closes from prior days: a trade
  // that hit TP1 yesterday (+$50) and SL today (-$470) has netPnlUsd=-$420 with
  // closedAt=today, so the breaker would book -$420 today even though +$50 was
  // realized yesterday. Match the equity-curve attribution in routes/breakoutPaper/
  // helpers.ts so guard % equals what the user sees in "Кривая капитала · % дня".
  //
  // Pull every trade with at least one close — filter close events by their
  // own closedAt below.
  const tradesWithCloses = await prisma.breakoutLiveTradeC.findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      status: true,
      closes: true,
      openedAt: true,
      realizedR: true,
      netPnlUsd: true,
      realizedPnlUsd: true,
      feesPaidUsd: true,
      entryFeeUsd: true,
      fundingPaidUsd: true,
    },
  })

  const dayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'TP3_HIT', 'EXPIRED'])
  let sumR = 0
  let sumPnl = 0
  for (const t of tradesWithCloses) {
    const arr = ((t.closes as any[]) ?? []) as Array<{
      pnlUsd?: number; pnlR?: number; feePaidUsd?: number; closedAt?: string
    }>
    if (arr.length === 0) continue
    // totalNet = netPnlUsd if terminal, else realized − fees (matches helpers.ts).
    // Used to weight per-slice net P&L by gross contribution.
    const totalNet = closedStatuses.has(t.status)
      ? (t.netPnlUsd ?? 0)
      : ((t.realizedPnlUsd ?? 0) - (t.feesPaidUsd ?? 0))
    const grossSum = arr.reduce((a, c) => a + (c.pnlUsd ?? 0), 0)
    for (const c of arr) {
      const ts = c.closedAt ? new Date(c.closedAt).getTime() : new Date(t.openedAt).getTime()
      if (ts < todayStart.getTime() || ts >= dayEnd.getTime()) continue
      const weight = grossSum !== 0 ? (c.pnlUsd ?? 0) / grossSum : 1 / arr.length
      sumPnl += totalNet * weight
      sumR += (c.pnlR ?? 0)
    }
  }

  // Stable SOD wallet reconstruction.
  //
  // The OLD method `cfg.currentDepositUsd - sumPnl` is brittle: currentDepositUsd
  // mirrors availableBalance (drops as margin locks). With 10 open positions
  // and unrealized loss, available collapses → SOD looks small → pnlPct gets
  // amplified to e.g. -18% while real loss is -9%. The breaker would then trip,
  // cancel pending, and stay tripped while positions stayed open.
  //
  // We now read the prior UTC day's wallet snapshot saved by the EOD job
  // (eodEquityByDate[yesterday]) — that IS the start-of-day wallet for today.
  // Falls back to walletTotal (snapshot.total) − sumPnl − sumUnrealized when
  // no prior snapshot exists (e.g. very first day of trading).
  const todayDate = todayStart.toISOString().slice(0, 10)
  const yesterdayDate = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const eodMap = ((cfg as any).eodEquityByDate ?? {}) as Record<string, number>
  let startOfDayDeposit = eodMap[yesterdayDate] ?? eodMap[todayDate] ?? 0
  if (!startOfDayDeposit || startOfDayDeposit < 1) {
    // Fallback: walletTotal − sumPnl removes today's realized closes, giving
    // a deposit number that's at least close to wallet-at-00:00-UTC. Better
    // than availableBalance-based reconstruction.
    const walletTotal = snapshot.current?.total ?? cfg.currentDepositUsd ?? 1
    startOfDayDeposit = Math.max(1, walletTotal - sumPnl)
  }
  // P&L дня = изменение wallet от SOD до текущего. Это включает realized closes,
  // entry fees + funding на ещё открытых позициях И unrealized — ровно то же
  // самое значение что строится в кривой капитала ("P&L дня" = pnl + residual).
  // Без residual гард показывал -6.69% против -7.08% в кривой (разница = fees +
  // funding текущих open). С wallet-дельтой гард 1-в-1 совпадает с UI.
  //
  // sumPnl остаётся в return как "realized closes only" — для логов и audit
  // (отдельно от tripping pct).
  const walletNow = snapshot.current?.total ?? cfg.currentDepositUsd ?? startOfDayDeposit
  const dayPnlForBreaker = walletNow - startOfDayDeposit
  const pnlPct = (dayPnlForBreaker / startOfDayDeposit) * 100

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
