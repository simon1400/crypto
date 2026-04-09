import { Trade } from '../../api/client'
import { formatDate, pnlColor } from '../../lib/formatters'
import { TradeStatusBadge } from '../StatusBadge'

interface Props {
  trades: Trade[]
  sessionPnl: number
}

export default function TradeHistory({ trades, sessionPnl }: Props) {
  return (
    <div className="bg-card rounded-xl p-4 border border-card mt-3">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-lg font-semibold text-text-primary">Сделки сессии</span>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-text-secondary">{trades.length} сделок</span>
          <span className={`font-mono font-semibold ${pnlColor(sessionPnl)}`}>
            {sessionPnl >= 0 ? '+' : ''}{sessionPnl.toFixed(2)} USDT
          </span>
        </div>
      </div>

      {/* Table */}
      {trades.length > 0 ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary border-b border-card">
                <th className="text-left pb-2 font-medium">Монета</th>
                <th className="text-left pb-2 font-medium">Тип</th>
                <th className="text-right pb-2 font-medium">Вход</th>
                <th className="text-right pb-2 font-medium">Выход</th>
                <th className="text-right pb-2 font-medium">P&amp;L</th>
                <th className="text-right pb-2 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card">
              {trades.map(t => {
                const exitPrice = t.closes && t.closes.length > 0 ? t.closes[0].price : null
                return (
                  <tr key={t.id} className="text-sm">
                    <td className="py-1.5 font-mono text-text-primary">{t.coin}</td>
                    <td className="py-1.5">
                      <span className={`font-medium text-sm ${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                        {t.type}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-mono text-text-secondary">
                      {t.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    </td>
                    <td className="py-1.5 text-right font-mono text-text-secondary">
                      {exitPrice != null
                        ? exitPrice.toLocaleString('en-US', { maximumFractionDigits: 4 })
                        : '—'}
                    </td>
                    <td className={`py-1.5 text-right font-mono font-semibold ${pnlColor(t.realizedPnl)}`}>
                      {t.realizedPnl >= 0 ? '+' : ''}{t.realizedPnl.toFixed(2)}$
                    </td>
                    <td className="py-1.5 text-right">
                      <TradeStatusBadge status={t.status} pnl={t.realizedPnl} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-text-secondary text-sm py-4 text-center">
          Нет сделок. Откройте позицию в режиме воспроизведения.
        </div>
      )}
    </div>
  )
}
