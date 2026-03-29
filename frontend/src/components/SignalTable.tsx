import { Signal } from '../api/client'
import SignalBadge from './SignalBadge'

interface Props {
  signals: Signal[]
  onSelect: (signal: Signal) => void
}

function formatPrice(n: number): string {
  if (n >= 1) return n.toFixed(2)
  if (n >= 0.01) return n.toFixed(4)
  return n.toFixed(5)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function pnl(signal: Signal): { text: string; color: string } | null {
  if (signal.status === 'SL_HIT') {
    const entry = (signal.entryMin + signal.entryMax) / 2
    const diff = signal.type === 'LONG'
      ? ((signal.stopLoss - entry) / entry) * 100
      : ((entry - signal.stopLoss) / entry) * 100
    const leveraged = diff * signal.leverage
    return { text: `${leveraged.toFixed(1)}%`, color: 'text-short' }
  }

  if (signal.status.startsWith('TP')) {
    const tpIdx = parseInt(signal.status.replace('TP', '').replace('_HIT', '')) - 1
    const tp = signal.takeProfits[tpIdx]
    if (tp == null) return null
    const entry = (signal.entryMin + signal.entryMax) / 2
    const diff = signal.type === 'LONG'
      ? ((tp - entry) / entry) * 100
      : ((entry - tp) / entry) * 100
    const leveraged = diff * signal.leverage
    return { text: `+${leveraged.toFixed(1)}%`, color: 'text-long' }
  }

  return null
}

export default function SignalTable({ signals, onSelect }: Props) {
  if (signals.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        Нет сигналов за последнюю неделю
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-secondary text-xs border-b border-card">
            <th className="text-left py-3 px-3 font-medium">Дата</th>
            <th className="text-left py-3 px-3 font-medium">Тип</th>
            <th className="text-left py-3 px-3 font-medium">Монета</th>
            <th className="text-right py-3 px-3 font-medium">Плечо</th>
            <th className="text-right py-3 px-3 font-medium">Вход</th>
            <th className="text-right py-3 px-3 font-medium">SL</th>
            <th className="text-left py-3 px-3 font-medium">Take Profits</th>
            <th className="text-left py-3 px-3 font-medium">Статус</th>
            <th className="text-right py-3 px-3 font-medium">P&L</th>
          </tr>
        </thead>
        <tbody>
          {signals.map(signal => {
            const result = pnl(signal)
            return (
              <tr
                key={signal.id}
                onClick={() => onSelect(signal)}
                className="border-b border-card/50 hover:bg-card/50 cursor-pointer transition-colors"
              >
                <td className="py-3 px-3 text-text-secondary text-xs whitespace-nowrap">
                  {formatDate(signal.publishedAt)}
                </td>
                <td className="py-3 px-3">
                  <span className={`font-bold text-xs ${signal.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                    {signal.type}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <span className="font-mono font-bold text-text-primary">{signal.coin}</span>
                </td>
                <td className="py-3 px-3 text-right font-mono text-text-secondary">
                  {signal.leverage}x
                </td>
                <td className="py-3 px-3 text-right font-mono text-text-primary whitespace-nowrap">
                  {formatPrice(signal.entryMin)}
                  {signal.entryMin !== signal.entryMax && (
                    <span className="text-text-secondary"> - {formatPrice(signal.entryMax)}</span>
                  )}
                </td>
                <td className="py-3 px-3 text-right font-mono text-short">
                  {formatPrice(signal.stopLoss)}
                </td>
                <td className="py-3 px-3">
                  <div className="flex gap-1.5 flex-wrap">
                    {signal.takeProfits.map((tp, i) => {
                      const tpHit = signal.status.startsWith('TP')
                        && parseInt(signal.status.replace('TP', '').replace('_HIT', '')) > i
                      return (
                        <span
                          key={i}
                          className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                            tpHit
                              ? 'bg-long/20 text-long'
                              : 'text-text-secondary'
                          }`}
                        >
                          {formatPrice(tp)}
                        </span>
                      )
                    })}
                  </div>
                </td>
                <td className="py-3 px-3">
                  <SignalBadge status={signal.status} type={signal.type} />
                </td>
                <td className="py-3 px-3 text-right">
                  {result && (
                    <span className={`font-mono font-bold ${result.color}`}>
                      {result.text}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
