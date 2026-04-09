import { useState } from 'react'
import { Signal } from '../api/client'
import SignalBadge from './SignalBadge'
import ConfirmDialog from './ConfirmDialog'
import { formatPrice, formatDateShort as formatDate } from '../lib/formatters'

interface Props {
  signals: Signal[]
  prices: Record<string, number | null>
  onSelect: (signal: Signal) => void
  showChannel?: boolean
  tradingMode?: string
  onModeToggle?: (mode: 'manual' | 'auto') => void
  onExecuteSignal?: (signal: Signal) => void
}

const CHANNEL_LABELS: Record<string, string> = {
  'Near512-LowCap': 'Low-Cap',
  'Near512-MidHigh': 'Mid-High',
  'Near512-Spot': 'Spot',
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

export default function SignalTable({
  signals, prices, onSelect, showChannel,
  tradingMode, onModeToggle, onExecuteSignal,
}: Props) {
  const [confirmSignal, setConfirmSignal] = useState<Signal | null>(null)
  const [executing, setExecuting] = useState(false)

  const handleExecuteConfirm = () => {
    if (!confirmSignal || !onExecuteSignal) return
    setExecuting(true)
    onExecuteSignal(confirmSignal)
    setConfirmSignal(null)
    setExecuting(false)
  }

  const isManual = tradingMode === 'manual'
  const canTrade = (status: string) => status === 'ENTRY_WAIT' || status === 'ACTIVE'

  if (signals.length === 0) {
    return (
      <div className="text-center py-12 text-text-secondary">
        Нет сигналов за последнюю неделю
      </div>
    )
  }

  return (
    <>
      {/* Mode toggle */}
      {onModeToggle && (
        <div className="flex items-center gap-2 px-3 py-3 border-b border-card">
          <span className="text-sm text-text-secondary">Режим:</span>
          <button
            onClick={() => onModeToggle('manual')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
              tradingMode === 'manual'
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'bg-input text-text-secondary'
            }`}
          >
            Ручной
          </button>
          <button
            onClick={() => onModeToggle('auto')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
              tradingMode === 'auto'
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'bg-input text-text-secondary'
            }`}
          >
            Авто
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary text-xs border-b border-card">
              <th className="text-left py-3 px-3 font-medium">Дата</th>
              {showChannel && <th className="text-left py-3 px-3 font-medium">Топик</th>}
              <th className="text-left py-3 px-3 font-medium">Тип</th>
              <th className="text-left py-3 px-3 font-medium">Монета</th>
              <th className="text-right py-3 px-3 font-medium">Цена</th>
              <th className="text-right py-3 px-3 font-medium">Плечо</th>
              <th className="text-right py-3 px-3 font-medium">Вход</th>
              <th className="text-right py-3 px-3 font-medium">SL</th>
              <th className="text-left py-3 px-3 font-medium">Take Profits</th>
              <th className="text-left py-3 px-3 font-medium">Статус</th>
              <th className="text-right py-3 px-3 font-medium">P&L</th>
              {isManual && <th className="text-center py-3 px-3 font-medium">Действие</th>}
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
                  {showChannel && (
                    <td className="py-3 px-3">
                      <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded">
                        {CHANNEL_LABELS[signal.channel] || signal.channel}
                      </span>
                    </td>
                  )}
                  <td className="py-3 px-3">
                    <span className={`font-bold text-xs ${signal.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                      {signal.type}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <span className="font-mono font-bold text-text-primary">{signal.coin}</span>
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-text-primary">
                    {prices[signal.coin] != null ? formatPrice(prices[signal.coin]!) : '\u2014'}
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
                  {isManual && (
                    <td className="py-3 px-3 text-center">
                      {canTrade(signal.status) && (
                        <button
                          onClick={e => { e.stopPropagation(); setConfirmSignal(signal) }}
                          className="bg-accent/10 text-accent border border-accent/30 px-3 py-1 rounded text-xs font-semibold hover:bg-accent/20 transition-colors"
                        >
                          Открыть
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Trade confirmation dialog */}
      <ConfirmDialog
        open={confirmSignal !== null}
        title="Открыть сделку"
        variant="primary"
        confirmLabel="Подтвердить"
        loading={executing}
        onConfirm={handleExecuteConfirm}
        onCancel={() => setConfirmSignal(null)}
      >
        {confirmSignal && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xl font-bold text-text-primary">{confirmSignal.coin}</span>
              <span className={`font-bold ${confirmSignal.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                {confirmSignal.type}
              </span>
              <span className="text-text-secondary font-mono">{confirmSignal.leverage}x</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-input rounded-lg p-2">
                <div className="text-xs text-text-secondary">Вход</div>
                <div className="font-mono text-text-primary">
                  {formatPrice(confirmSignal.entryMin)}
                  {confirmSignal.entryMin !== confirmSignal.entryMax && ` - ${formatPrice(confirmSignal.entryMax)}`}
                </div>
              </div>
              <div className="bg-input rounded-lg p-2">
                <div className="text-xs text-text-secondary">Stop Loss</div>
                <div className="font-mono text-short">{formatPrice(confirmSignal.stopLoss)}</div>
              </div>
            </div>
            <div className="text-xs text-text-secondary">
              Размер позиции по настройкам
            </div>
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}
