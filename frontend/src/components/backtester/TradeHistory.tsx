import { Trade } from '../../api/client'

interface Props {
  trades: Trade[]
  sessionPnl: number
}

function formatDate(d: string) {
  return new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function pnlColor(v: number) {
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : 'text-text-secondary'
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    OPEN: { bg: 'bg-accent/10', text: 'text-accent', label: 'Открыта' },
    CLOSED: { bg: 'bg-long/10', text: 'text-long', label: 'Закрыта' },
    SL_HIT: { bg: 'bg-short/10', text: 'text-short', label: 'Стоп-лосс' },
    CANCELLED: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Отменена' },
  }
  const s = map[status] || map.CANCELLED
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>
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
                      {statusBadge(t.status)}
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
