import { Signal } from '../../api/client'
import SignalBadge from '../SignalBadge'
import SignalChart from '../SignalChart'
import { formatPrice } from '../../lib/formatters'

export default function SignalModal({ signal, onClose }: { signal: Signal; onClose: () => void }) {
  const entry = (signal.entryMin + signal.entryMax) / 2

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-card rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl font-bold text-text-primary">{signal.coin}</span>
            <span className={`text-lg font-bold ${signal.type === 'LONG' ? 'text-long' : 'text-short'}`}>
              {signal.type}
            </span>
            <span className="text-text-secondary font-mono">{signal.leverage}x</span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">
            ✕
          </button>
        </div>

        {/* Status */}
        <div className="mb-5">
          <SignalBadge status={signal.status} type={signal.type} />
          <span className="ml-3 text-xs text-text-secondary">
            {new Date(signal.publishedAt).toLocaleString('ru-RU')}
          </span>
        </div>

        {/* Price levels grid */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-input rounded-lg p-3">
            <div className="text-xs text-text-secondary mb-1">Вход</div>
            <div className="font-mono font-bold text-accent">
              {formatPrice(signal.entryMin)}
              {signal.entryMin !== signal.entryMax && ` - ${formatPrice(signal.entryMax)}`}
            </div>
          </div>
          <div className="bg-input rounded-lg p-3">
            <div className="text-xs text-text-secondary mb-1">Stop Loss</div>
            <div className="font-mono font-bold text-short">
              {formatPrice(signal.stopLoss)}
              <span className="text-xs text-text-secondary ml-1">
                ({(((Math.abs(signal.stopLoss - entry)) / entry) * 100).toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Take Profits */}
        <div className="mb-5">
          <div className="text-xs text-text-secondary mb-2">Take Profits</div>
          <div className="grid grid-cols-5 gap-2">
            {signal.takeProfits.map((tp, i) => {
              const tpHit = signal.status.startsWith('TP')
                && parseInt(signal.status.replace('TP', '').replace('_HIT', '')) > i
              const diff = ((Math.abs(tp - entry)) / entry) * 100
              return (
                <div
                  key={i}
                  className={`rounded-lg p-2.5 text-center ${
                    tpHit ? 'bg-long/20 border border-long/30' : 'bg-input'
                  }`}
                >
                  <div className="text-xs text-text-secondary mb-1">TP{i + 1}</div>
                  <div className={`font-mono text-sm font-bold ${tpHit ? 'text-long' : 'text-text-primary'}`}>
                    {formatPrice(tp)}
                  </div>
                  <div className="text-xs text-text-secondary">+{diff.toFixed(2)}%</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Chart */}
        <div className="mb-4">
          <div className="text-xs text-text-secondary mb-2">График цены</div>
          <SignalChart signal={signal} />
        </div>

        {/* Metadata */}
        <div className="text-xs text-text-secondary space-y-1">
          <div>Канал: {signal.channel}</div>
          {signal.entryFilledAt && (
            <div>Вход заполнен: {new Date(signal.entryFilledAt).toLocaleString('ru-RU')}</div>
          )}
          {signal.statusUpdatedAt && (
            <div>Обновлено: {new Date(signal.statusUpdatedAt).toLocaleString('ru-RU')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
