import { TradeStats, TradeLive } from '../../api/client'
import { pnlColor, fmt2, fmt2Signed } from '../../lib/formatters'

export default function StatsPanel({ stats, livePrices }: { stats: TradeStats | null; livePrices: Record<number, TradeLive> }) {
  if (!stats) return null

  const unrealizedTotal = Object.values(livePrices).reduce((sum, lp) => sum + lp.unrealizedPnl, 0)
  const totalPnl = stats.totalPnl + unrealizedTotal

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Всего</div>
        <div className="text-2xl font-bold text-text-primary">{stats.total}</div>
        <div className="text-xs text-text-secondary">{stats.open} открытых</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Win Rate</div>
        <div className={`text-2xl font-bold ${stats.winRate >= 50 ? 'text-long' : 'text-short'}`}>{fmt2(stats.winRate)}%</div>
        <div className="text-xs text-text-secondary">{stats.wins}W / {stats.losses}L</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Общий P&L</div>
        <div className={`text-2xl font-bold font-mono ${pnlColor(totalPnl)}`}>
          {fmt2Signed(totalPnl)}$
        </div>
        {unrealizedTotal !== 0 && (
          <div className={`text-xs font-mono ${pnlColor(unrealizedTotal)}`}>
            unrealized: {fmt2Signed(unrealizedTotal)}$
          </div>
        )}
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Средний Win</div>
        <div className="text-lg font-bold font-mono text-long">+{fmt2(stats.avgWin)}$</div>
        <div className="text-xs text-text-secondary">Avg Loss: {fmt2(stats.avgLoss)}$</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">LONG</div>
        <div className={`text-lg font-bold font-mono ${pnlColor(stats.longStats.pnl)}`}>
          {fmt2Signed(stats.longStats.pnl)}$
        </div>
        <div className="text-xs text-text-secondary">{stats.longStats.count} сделок</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">SHORT</div>
        <div className={`text-lg font-bold font-mono ${pnlColor(stats.shortStats.pnl)}`}>
          {fmt2Signed(stats.shortStats.pnl)}$
        </div>
        <div className="text-xs text-text-secondary">{stats.shortStats.count} сделок</div>
      </div>
    </div>
  )
}
