import { useState } from 'react'
import { Trade, cancelTrade } from '../../api/client'

const cancelReasons = [
  { value: 'PRICE_PASSED', label: 'Цена прошла мимо' },
  { value: 'TP1_REACHED', label: 'Цена достигла TP1' },
  { value: 'SETUP_INVALIDATED', label: 'Сетап сломался' },
  { value: 'CHANGED_MIND', label: 'Передумал' },
  { value: 'BETTER_ENTRY', label: 'Нашёл лучший вход' },
]

interface CancelTradeModalProps {
  trade: Trade
  onClose: () => void
  onDone: () => void
}

export default function CancelTradeModal({ trade, onClose, onDone }: CancelTradeModalProps) {
  const [cancelReason, setCancelReason] = useState('')
  const [cancelLoading, setCancelLoading] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card border border-input rounded-lg p-6 w-[400px]" onClick={e => e.stopPropagation()}>
        <h3 className="text-text-primary font-semibold mb-1">Отменить сделку</h3>
        <p className="text-text-secondary text-sm mb-4">{trade.coin.replace('USDT', '')} {trade.type} ${trade.entryPrice}</p>
        <div className="space-y-2 mb-4">
          {cancelReasons.map(r => (
            <button key={r.value}
              onClick={() => setCancelReason(r.value)}
              className={`w-full text-left px-3 py-2 rounded text-sm transition ${
                cancelReason === r.value
                  ? 'bg-short/15 text-short border border-short/30'
                  : 'bg-input text-text-secondary hover:text-text-primary'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded bg-input text-text-secondary hover:text-text-primary transition text-sm"
          >
            Назад
          </button>
          <button
            disabled={!cancelReason || cancelLoading}
            onClick={async () => {
              setCancelLoading(true)
              try {
                await cancelTrade(trade.id, cancelReason)
                onDone()
              } catch (err: any) { alert(err?.message || 'Failed to cancel trade') }
              setCancelLoading(false)
            }}
            className="flex-1 py-2 rounded bg-short/20 text-short hover:bg-short/30 transition text-sm disabled:opacity-40"
          >
            {cancelLoading ? 'Отмена...' : 'Отменить'}
          </button>
        </div>
      </div>
    </div>
  )
}
