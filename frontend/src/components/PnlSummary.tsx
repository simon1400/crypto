import { PnlStats } from '../api/client'

interface Props {
  stats: PnlStats | null
  period: string
  onPeriodChange: (p: 'day' | 'week' | 'month') => void
  loading: boolean
}

const periods: { key: 'day' | 'week' | 'month'; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
]

function formatPnl(value: number): string {
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

function Skeleton() {
  return <div className="h-8 bg-input rounded animate-pulse" />
}

export default function PnlSummary({ stats, period, onPeriodChange, loading }: Props) {
  const pnlColor = stats && stats.totalPnl >= 0 ? 'text-long' : 'text-short'
  const winRateColor = stats && stats.winRate >= 50 ? 'text-long' : 'text-short'

  return (
    <div>
      {/* Period tabs */}
      <div className="flex gap-2 mb-4">
        {periods.map((p) => (
          <button
            key={p.key}
            onClick={() => onPeriodChange(p.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              period === p.key
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-input rounded-lg p-4">
          <div className="text-text-secondary text-xs mb-1">Total P&L</div>
          {loading ? <Skeleton /> : (
            <div className={`font-mono font-bold text-xl ${pnlColor}`}>
              {stats ? formatPnl(stats.totalPnl) : '-'}
            </div>
          )}
        </div>

        <div className="bg-input rounded-lg p-4">
          <div className="text-text-secondary text-xs mb-1">Win Rate</div>
          {loading ? <Skeleton /> : (
            <div className={`font-mono font-bold text-xl ${winRateColor}`}>
              {stats ? `${stats.winRate.toFixed(1)}%` : '-'}
            </div>
          )}
        </div>

        <div className="bg-input rounded-lg p-4">
          <div className="text-text-secondary text-xs mb-1">Trades</div>
          {loading ? <Skeleton /> : (
            <div className="font-mono font-bold text-xl text-text-primary">
              {stats ? stats.tradesCount : '-'}
            </div>
          )}
        </div>

        <div className="bg-input rounded-lg p-4">
          <div className="text-text-secondary text-xs mb-1">Wins</div>
          {loading ? <Skeleton /> : (
            <div className="font-mono font-bold text-xl text-long">
              {stats ? stats.wins : '-'}
            </div>
          )}
        </div>
      </div>

      {/* By channel */}
      {stats && Object.keys(stats.byChannel).length > 0 && (
        <div>
          <div className="text-text-secondary text-xs mb-2">By Channel</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byChannel).map(([channel, data]) => (
              <div key={channel} className="bg-input rounded-lg px-3 py-2 text-sm">
                <span className="text-accent font-medium">{channel}</span>
                <span className="text-text-secondary mx-2">{data.count} trades</span>
                <span className={`font-mono ${data.pnl >= 0 ? 'text-long' : 'text-short'}`}>
                  {formatPnl(data.pnl)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
