import { BybitPosition } from '../api/client'

interface Props {
  position: BybitPosition
  onClose: (id: number) => void
  closingId: number | null
  confirmClose: number | null
  onConfirmClose: (id: number) => void
  onCancelClose: () => void
}

function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return '-'
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

function formatPnl(value: number): string {
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

const statusLabels: Record<string, { label: string; color: string }> = {
  OPEN: { label: 'OPEN', color: 'text-long bg-long/10' },
  PARTIALLY_CLOSED: { label: 'PARTIAL', color: 'text-accent bg-accent/10' },
  PENDING_ENTRY: { label: 'PENDING', color: 'text-neutral bg-neutral/10' },
  CLOSED: { label: 'CLOSED', color: 'text-neutral bg-neutral/10' },
}

export default function PositionCard({
  position,
  onClose,
  closingId,
  confirmClose,
  onConfirmClose,
  onCancelClose,
}: Props) {
  const coin = position.symbol.replace('USDT', '')
  const isLong = position.type === 'LONG'
  const pnlColor = position.unrealisedPnl >= 0 ? 'text-long' : 'text-short'
  const pnlPct = position.margin ? (position.unrealisedPnl / position.margin) * 100 : 0
  const canClose = position.status === 'OPEN' || position.status === 'PARTIALLY_CLOSED'
  const isClosing = closingId === position.id
  const isConfirming = confirmClose === position.id
  const statusInfo = statusLabels[position.status] || statusLabels.OPEN

  return (
    <div className="bg-card rounded-xl p-5 relative">
      {/* Status badge */}
      <span className={`absolute top-4 right-4 px-2 py-0.5 rounded text-xs font-medium ${statusInfo.color}`}>
        {statusInfo.label}
      </span>

      {/* Top row: coin, direction, leverage */}
      <div className="flex items-center gap-3 mb-4">
        <span className="font-mono font-bold text-lg text-text-primary">{coin}</span>
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
          {position.type}
        </span>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent">
          {position.leverage}x
        </span>
      </div>

      {/* Signal source */}
      {position.signal && (
        <div className="mb-3">
          <span className="px-2 py-0.5 rounded text-xs bg-accent/10 text-accent">
            {position.signal.channel}
          </span>
        </div>
      )}

      {/* Unrealized P&L - large */}
      <div className="mb-4">
        <div className={`font-mono font-bold text-2xl ${pnlColor}`}>
          {formatPnl(position.unrealisedPnl)}
        </div>
        <div className={`font-mono text-sm ${pnlColor}`}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Entry Price</div>
          <div className="font-mono text-text-primary">{formatPrice(position.entryPrice)}</div>
        </div>
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Mark Price</div>
          <div className="font-mono text-text-primary">{formatPrice(position.markPrice)}</div>
        </div>
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Stop Loss</div>
          <div className="font-mono text-short">{formatPrice(position.stopLoss)}</div>
        </div>
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Take Profits</div>
          <div className="font-mono text-long text-xs">
            {position.takeProfits.length > 0
              ? position.takeProfits.map((tp, i) => (
                  <span key={i} className={i < Math.floor(position.closedPct / (100 / position.takeProfits.length)) ? 'line-through opacity-50' : ''}>
                    {formatPrice(tp)}{i < position.takeProfits.length - 1 ? ', ' : ''}
                  </span>
                ))
              : '-'}
          </div>
        </div>
      </div>

      {/* Size and margin */}
      <div className="flex items-center gap-4 mb-4 text-sm">
        <div>
          <span className="text-text-secondary text-xs">Size: </span>
          <span className="font-mono text-text-primary">{position.qty} {coin}</span>
        </div>
        <div>
          <span className="text-text-secondary text-xs">Margin: </span>
          <span className="font-mono text-text-primary">{position.margin !== null ? `${position.margin.toFixed(2)} USDT` : '-'}</span>
        </div>
      </div>

      {/* Close button / confirmation */}
      {canClose && (
        <div className="mt-2">
          {isConfirming ? (
            <div className="flex gap-2">
              <button
                onClick={() => onClose(position.id)}
                disabled={isClosing}
                className="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-short/20 text-short hover:bg-short/30 transition-colors disabled:opacity-50"
              >
                {isClosing ? 'Closing...' : 'Confirm close'}
              </button>
              <button
                onClick={onCancelClose}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => onConfirmClose(position.id)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-short hover:bg-short/10 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      )}
    </div>
  )
}
