import type { BreakoutPaperConfig as PaperConfig, BreakoutStats as PaperStats } from '../../api/breakoutPaper'
import type { BreakoutLiveStatus } from '../../api/breakoutLiveC'
import { fmtUsd } from '../../lib/formatters'
import Stat from './Stat'

interface Props {
  config: PaperConfig
  stats: PaperStats | null
  isLive: boolean
  liveStatus: BreakoutLiveStatus | null
  openCount: number
  activeMarginUsd: number
  unrealizedPnlUsd: number
  equityWithOpen: number
}

/**
 * Top 6-card stat strip. LIVE uses Binance margin balance (wallet + unrealized)
 * as the canonical "equity" so доходность compares like-for-like with the
 * baseline snapshot (which was a walletBalance at first enable). Paper variants
 * keep using config.currentDepositUsd as before.
 */
export default function TopStats({
  config, stats, isLive, liveStatus,
  openCount, activeMarginUsd, unrealizedPnlUsd, equityWithOpen,
}: Props) {
  const returnPct = stats?.returnPct ?? 0
  const winRate = stats?.winRate ?? 0

  const liveWalletBalance = isLive ? (liveStatus?.walletBalanceUsdt ?? config.currentDepositUsd) : null
  const liveMarginBalance = isLive ? (liveStatus?.marginBalanceUsdt ?? config.currentDepositUsd) : null
  const liveAvailable = isLive ? (liveStatus?.balanceUsdt ?? config.currentDepositUsd) : null
  const liveUnrealized = isLive ? (liveStatus?.unrealizedPnlUsdt ?? 0) : null
  const liveTotalPnlPct = isLive ? (liveStatus?.totalPnlPct ?? 0) : null
  const liveTotalPnlUsd = isLive ? (liveStatus?.totalPnlUsd ?? 0) : null

  // "Депозит" = только реализованный итог (walletBalance растёт/падает на close).
  // "Депо с открытыми" = walletBalance + unrealized (margin balance в Binance UI).
  const depoValue = isLive ? (liveWalletBalance ?? 0) : config.currentDepositUsd
  const depoSub = isLive
    ? `available $${(liveAvailable ?? 0).toFixed(2)} · baseline $${config.startingDepositUsd.toFixed(2)}`
    : `из $${config.startingDepositUsd}`
  const depoTone: 'long' | 'short' = (isLive ? depoValue >= config.startingDepositUsd : config.currentDepositUsd >= config.startingDepositUsd) ? 'long' : 'short'

  const equityValue = isLive ? (liveMarginBalance ?? 0) : equityWithOpen
  const equityUnrealized = isLive ? (liveUnrealized ?? 0) : unrealizedPnlUsd
  const returnValue = isLive ? (liveTotalPnlPct ?? 0) : returnPct
  const pnlValue = isLive ? (liveTotalPnlUsd ?? 0) : config.totalPnLUsd

  // LIVE: pnlValue = walletBalance − baseline (фактическая дельта кошелька с биржи).
  // Это включает entry-комиссии висящих открытых лимиток и funding.
  // config.totalPnLUsd = сумма закрытых сделок (recompute после close). Разница
  // между ними = "прочее" — комиссии открытых + funding.
  const closedSum = isLive ? config.totalPnLUsd : null
  const otherSum = isLive ? (pnlValue - (closedSum ?? 0)) : 0
  const pnlSub = isLive
    ? `закрытые ${fmtUsd(closedSum ?? 0)} · прочее ${fmtUsd(otherSum)}`
    : undefined

  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
      <Stat label="Депозит" value={`$${depoValue.toFixed(2)}`}
        sub={depoSub} tone={depoTone} />
      <Stat label="Депо с открытыми" value={`$${equityValue.toFixed(2)}`}
        sub={openCount > 0
          ? `${equityUnrealized >= 0 ? '+' : ''}$${equityUnrealized.toFixed(2)} unrealized`
          : 'нет открытых'}
        tone={equityValue >= config.startingDepositUsd ? 'long' : 'short'} />
      <Stat label="Доходность" value={`${returnValue >= 0 ? '+' : ''}${returnValue.toFixed(1)}%`}
        tone={returnValue > 0 ? 'long' : returnValue < 0 ? 'short' : 'neutral'} />
      <Stat label="Total P&L" value={fmtUsd(pnlValue)}
        sub={pnlSub}
        tone={pnlValue > 0 ? 'long' : pnlValue < 0 ? 'short' : 'neutral'} />
      <Stat label="Win Rate" value={`${(winRate * 100).toFixed(0)}%`}
        sub={`${config.totalWins}W / ${config.totalLosses}L`} />
      <Stat label="Открытых" value={openCount.toString()}
        sub={openCount > 0 ? `маржа $${activeMarginUsd.toFixed(2)} · Max DD ${config.maxDrawdownPct.toFixed(1)}%` : `Max DD ${config.maxDrawdownPct.toFixed(1)}%`} />
    </div>
  )
}
