import { useState, useEffect } from 'react'
import { BybitPosition } from '../api/client'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  position: BybitPosition
  onClose: (id: number) => void
  onMarketEntry: (id: number) => void
  onCancel: (id: number) => void
  closingId: number | null
  actionId: number | null
}

function formatElapsedTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 60) return `${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  const remainMin = diffMin % 60
  if (diffHours < 24) return `${diffHours}h ${remainMin}m`
  const diffDays = Math.floor(diffHours / 24)
  const remainHours = diffHours % 24
  return `${diffDays}d ${remainHours}h`
}

function useElapsedTime(dateStr: string | null): string {
  const [elapsed, setElapsed] = useState(() => dateStr ? formatElapsedTime(dateStr) : '')
  useEffect(() => {
    if (!dateStr) return
    setElapsed(formatElapsedTime(dateStr))
    const timer = setInterval(() => setElapsed(formatElapsedTime(dateStr)), 60000)
    return () => clearInterval(timer)
  }, [dateStr])
  return elapsed
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

function calcPnlForecast(
  margin: number | null,
  leverage: number,
  entryPrice: number | null,
  targetPrice: number,
  type: 'LONG' | 'SHORT',
  closedPct: number
): number | null {
  if (!margin || !entryPrice || entryPrice === 0) return null
  const remainingMargin = margin * (1 - closedPct / 100)
  if (type === 'LONG') {
    return remainingMargin * leverage * (targetPrice - entryPrice) / entryPrice
  } else {
    return remainingMargin * leverage * (entryPrice - targetPrice) / entryPrice
  }
}

const originColors: Record<string, { label: string; bg: string; text: string }> = {
  'Auto': { label: 'Auto', bg: 'bg-accent/10', text: 'text-accent' },
  'Bybit': { label: 'Bybit', bg: 'bg-neutral/10', text: 'text-neutral' },
  'Auto (Modified)': { label: 'Modified', bg: 'bg-yellow-500/10', text: 'text-yellow-500' },
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
  onMarketEntry,
  onCancel,
  closingId,
  actionId,
}: Props) {
  const [confirmType, setConfirmType] = useState<'market-entry' | 'cancel' | 'close' | null>(null)

  const coin = position.symbol.replace('USDT', '')
  const isLong = position.type === 'LONG'
  const pnlColor = position.unrealisedPnl >= 0 ? 'text-long' : 'text-short'
  const pnlPct = position.margin ? (position.unrealisedPnl / position.margin) * 100 : 0
  const canClose = position.status === 'OPEN' || position.status === 'PARTIALLY_CLOSED'
  const isPending = position.status === 'PENDING_ENTRY'
  const isClosing = closingId === position.id
  const isActioning = actionId === position.id
  const statusInfo = statusLabels[position.status] || statusLabels.OPEN

  const hasTpSl = position.stopLoss > 0 || position.takeProfits.length > 0
  const refDate = isPending ? position.createdAt : (position.filledAt || position.createdAt)
  const elapsed = useElapsedTime(refDate)

  return (
    <div className="bg-card rounded-xl p-5 relative border border-input shadow-lg shadow-black/20">
      {/* Status + origin badges */}
      <div className="absolute top-4 right-4 flex items-center gap-1.5">
        {position.origin && position.origin !== 'Auto' && (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${originColors[position.origin]?.bg} ${originColors[position.origin]?.text}`}>
            {originColors[position.origin]?.label}
          </span>
        )}
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusInfo.color}`}>
          {statusInfo.label}
        </span>
      </div>

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

      {/* Elapsed time */}
      <div className="mb-3 text-text-secondary text-xs">
        {isPending ? (
          <span>Ожидание: {elapsed}</span>
        ) : (
          <span>В позиции: {elapsed}</span>
        )}
      </div>

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
      <div className={`grid grid-cols-2 gap-3 mb-4 text-sm`}>
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Entry Price</div>
          <div className="font-mono text-text-primary">{formatPrice(position.entryPrice)}</div>
        </div>
        <div>
          <div className="text-text-secondary text-xs mb-0.5">Mark Price</div>
          <div className="font-mono text-text-primary">{formatPrice(position.markPrice)}</div>
        </div>
        {/* Only show SL/TP for positions that have them (not external Bybit positions) */}
        {hasTpSl && (
          <>
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
          </>
        )}
      </div>

      {/* P&L Forecast */}
      {hasTpSl && position.entryPrice && position.margin && (
        <div className="mb-4">
          <div className="text-text-secondary text-xs mb-1">P&L Forecast</div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {position.takeProfits.map((tp, i) => {
              const tpHitCount = position.takeProfits.length > 0
                ? Math.floor(position.closedPct / (100 / position.takeProfits.length))
                : 0
              if (i < tpHitCount) return null
              const pnl = calcPnlForecast(position.margin, position.leverage, position.entryPrice, tp, position.type, position.closedPct)
              if (pnl === null) return null
              return (
                <span key={i} className="font-mono text-long text-sm">
                  TP{i + 1}: +${Math.abs(pnl).toFixed(2)}
                </span>
              )
            })}
            {position.stopLoss > 0 && (() => {
              const slPnl = calcPnlForecast(position.margin, position.leverage, position.entryPrice, position.stopLoss, position.type, position.closedPct)
              if (slPnl === null) return null
              return (
                <span className="font-mono text-short text-sm">
                  SL: -${Math.abs(slPnl).toFixed(2)}
                </span>
              )
            })()}
          </div>
        </div>
      )}

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

      {/* PENDING_ENTRY: Market Entry + Cancel buttons */}
      {isPending && position.id > 0 && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => setConfirmType('market-entry')}
            className="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-long/20 text-long hover:bg-long/30 transition-colors"
          >
            Market Entry
          </button>
          <button
            onClick={() => setConfirmType('cancel')}
            className="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-short/20 text-short hover:bg-short/30 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* OPEN / PARTIALLY_CLOSED: Close button */}
      {canClose && position.id > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setConfirmType('close')}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-short hover:bg-short/10 transition-colors"
          >
            Close
          </button>
        </div>
      )}

      {/* Confirmation dialogs */}
      <ConfirmDialog
        open={confirmType === 'market-entry'}
        title={`Войти по рынку ${coin} ${position.type}?`}
        confirmLabel="Войти"
        variant="danger"
        loading={isActioning}
        onConfirm={() => { onMarketEntry(position.id); setConfirmType(null) }}
        onCancel={() => setConfirmType(null)}
      >
        <p className="text-text-secondary text-sm">
          Позиция будет открыта по текущей рыночной цене.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmType === 'cancel'}
        title={`Отменить ордер ${coin} ${position.type}?`}
        confirmLabel="Отменить ордер"
        variant="danger"
        loading={isActioning}
        onConfirm={() => { onCancel(position.id); setConfirmType(null) }}
        onCancel={() => setConfirmType(null)}
      >
        <p className="text-text-secondary text-sm">
          Лимитный ордер будет отменён на бирже.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmType === 'close'}
        title={`Закрыть позицию ${coin} ${position.type}?`}
        confirmLabel="Закрыть"
        variant="danger"
        loading={isClosing}
        onConfirm={() => { onClose(position.id); setConfirmType(null) }}
        onCancel={() => setConfirmType(null)}
      >
        <p className="text-text-secondary text-sm">
          Позиция будет закрыта по рынку.
        </p>
      </ConfirmDialog>
    </div>
  )
}
