/**
 * Deposit accounting — currentDepositUsd is always derived from the trade
 * table (startingDepositUsd + Σ trade-level net P&L), not incrementally.
 *
 * Rationale: incremental `current + delta` drifts if delta is ever applied
 * twice (e.g. WS-tick + slow-tick race). Absolute recompute is idempotent
 * regardless of how many times any path triggers it.
 */

import { BreakoutVariant, configModel, tradeModel } from '../breakoutVariant'
import { PaperConfig } from './types'

export async function applyDepositDelta(cfg: PaperConfig, delta: number, variant: BreakoutVariant): Promise<void> {
  // delta=0 still recomputes totalPnLUsd/totalTrades from the trade table —
  // useful when an entry fee was decremented directly (e.g. variant C limit fill)
  // and we need totalPnLUsd to stay in sync with currentDepositUsd.
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any

  // currentDepositUsd derived from startingDepositUsd + sum of trade-table P&L.
  // Old version did `cfg.currentDepositUsd + delta`, which drifts if delta is
  // ever applied twice (e.g. WS-tick + slow-tick race). totalPnLUsd was already
  // recomputed from the table below, so currentDeposit being incremental left
  // the two fields free to diverge — exactly what happened with DOGE B (race
  // applied +$2.38 twice, totalPnLUsd recomputed correctly, currentDeposit didn't).
  void delta

  const trades = await tm.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
  })
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
  const closedOnly = trades.filter((t: any) => closedStatuses.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter((t: any) => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter((t: any) => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a: number, t: any) => {
    const realizedNet = closedStatuses.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
    return a + realizedNet
  }, 0)

  const newDeposit = cfg.startingDepositUsd + totalPnLUsd
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0

  await cm.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}
