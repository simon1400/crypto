import { useState, useEffect } from 'react'
import { Trade, TradeLive } from '../../api/client'
import { formatDate, pnlColor, fmt2, fmt2Signed } from '../../lib/formatters'
import { TradeStatusBadge } from '../StatusBadge'

function formatElapsed(openedAt: string): string {
  const ms = Date.now() - new Date(openedAt).getTime()
  if (ms < 0) return '0м'
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}д ${hours % 24}ч`
  if (hours > 0) return `${hours}ч ${mins % 60}м`
  return `${mins}м`
}

function LiveTimer({ openedAt }: { openedAt: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])
  return <>{formatElapsed(openedAt)}</>
}

const CANCEL_REASONS: Record<string, string> = {
  PRICE_PASSED: 'Цена прошла мимо',
  TP1_REACHED: 'Достиг TP1',
  SETUP_INVALIDATED: 'Сетап сломался',
  CHANGED_MIND: 'Передумал',
  BETTER_ENTRY: 'Лучший вход',
  MANUAL_CANCEL: 'Вручную',
}

const SOURCE_BADGES: Record<string, { label: string; cls: string }> = {
  SCANNER: { label: 'W', cls: 'bg-accent/15 text-accent' },
  ENTRY_ANALYZER: { label: 'E', cls: 'bg-accent/15 text-accent' },
  SIGNAL: { label: 'T', cls: 'bg-blue-500/15 text-blue-400' },
}

interface TradeCardProps {
  trade: Trade
  live: TradeLive | undefined
  statusFilter: string
  onSelect: () => void
  onClose: () => void
  onCancel: () => void
  onChart: () => void
}

export default function TradeCard({ trade: t, live, statusFilter, onSelect, onClose, onCancel, onChart }: TradeCardProps) {
  const dir = t.type === 'LONG' ? 1 : -1
  const remaining = t.amount * ((100 - t.closedPct) / 100)
  const slPct = ((t.stopLoss - t.entryPrice) * dir / t.entryPrice) * 100 * t.leverage
  const tps = (t.takeProfits as { price: number; percent?: number }[]) || []
  const maxTp = tps.length > 0 ? tps[tps.length - 1] : null
  const tpPct = maxTp ? ((maxTp.price - t.entryPrice) * dir / t.entryPrice) * 100 * t.leverage : null
  const netPnl = t.realizedPnl - (t.fees || 0)
  const scoreMatch = t.notes?.match(/Score:\s*(\d+)/)
  const sourceBadge = SOURCE_BADGES[t.source]
  const isActive = t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED'
  const isPending = t.status === 'PENDING_ENTRY'
  const isCancelled = t.status === 'CANCELLED'
  const showClosed = !['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter)

  return (
    <div className="bg-card rounded-xl p-3 space-y-2" onClick={onSelect}>
      {/* Row 1: coin + type + chart */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{t.coin.replace('USDT', '')}</span>
          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${t.type === 'LONG' ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {t.type} {t.leverage}x
          </span>
          <button onClick={e => { e.stopPropagation(); onChart() }} className="text-text-secondary hover:text-accent transition-colors p-1">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
          </button>
        </div>
        <TradeStatusBadge status={t.status} pnl={t.realizedPnl} />
      </div>

      {/* Row 2: badges + date */}
      <div className="flex items-center gap-1.5">
        {scoreMatch && <span className="font-mono text-xs text-accent">{scoreMatch[1]}</span>}
        {sourceBadge && <span className={`px-1 py-0.5 rounded text-[10px] font-bold ${sourceBadge.cls}`}>{sourceBadge.label}</span>}
        {t.notes?.includes('Model: aggressive') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-long/15 text-long">A</span>}
        {t.notes?.includes('Model: confirmation') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent">C</span>}
        {t.notes?.includes('Model: pullback') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400">P</span>}
        <span className="text-[10px] text-text-secondary ml-auto flex items-center gap-1.5">
          {isActive && <span className="text-accent font-mono"><LiveTimer openedAt={t.openedAt} /></span>}
          {formatDate(t.openedAt)}
        </span>
      </div>

      {/* Body: price grid */}
      <div className="border-t border-input/50 pt-2.5"></div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-text-secondary">Вход</div>
          <div className="font-mono text-text-primary">${t.entryPrice}</div>
        </div>
        <div>
          <div className="text-text-secondary">Цена</div>
          <div className="font-mono">
            {live?.currentPrice ? (
              <span className={pnlColor(live.unrealizedPnl)}>${live.currentPrice}</span>
            ) : <span className="text-text-secondary">—</span>}
          </div>
        </div>
        <div>
          <div className="text-text-secondary">Размер</div>
          <div className="font-mono text-text-primary">${fmt2(remaining)}</div>
          {t.leverage > 1 && <div className="font-mono text-text-secondary text-[10px]">${fmt2(remaining * t.leverage)}</div>}
        </div>
      </div>

      {/* Row 3: SL + TP */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-text-secondary">Stop Loss</div>
          <div className="font-mono">
            <span className="text-short">${t.stopLoss}</span>
            <span className="text-short/70 ml-1">{fmt2(slPct)}%</span>
          </div>
        </div>
        <div>
          <div className="text-text-secondary">Take Profit</div>
          {maxTp ? (
            <div className="font-mono">
              <span className="text-long">${maxTp.price}</span>
              <span className="text-long/70 ml-1">+{fmt2(tpPct!)}%</span>
            </div>
          ) : <div className="text-text-secondary">—</div>}
        </div>
      </div>

      {/* Row 4: closed % */}
      {showClosed && t.closedPct > 0 && (
        <div className="text-xs text-text-secondary">Закрыто: {t.closedPct}%</div>
      )}

      {/* Footer: P&L + action */}
      <div className="flex items-center justify-between pt-2.5 mt-0.5 border-t border-input/50">
        <div>
          {isCancelled ? (
            <span className="text-text-secondary text-xs">{CANCEL_REASONS[t.exitReason || ''] || t.exitReason || '—'}</span>
          ) : isActive && live ? (
            <div>
              <span className={`font-mono font-bold text-base ${pnlColor(live.unrealizedPnl)}`}>
                {fmt2Signed(live.unrealizedPnl)}$
              </span>
              <span className={`font-mono text-xs ml-1.5 ${pnlColor(live.unrealizedPnlPct)}`}>
                {fmt2Signed(live.unrealizedPnlPct)}%
              </span>
            </div>
          ) : netPnl !== 0 ? (
            <span className={`font-mono font-bold text-base ${pnlColor(netPnl)}`}>{fmt2Signed(netPnl)}$</span>
          ) : null}
        </div>
        {isPending && (
          <button onClick={e => { e.stopPropagation(); onCancel() }}
            className="px-3 py-1.5 bg-short/10 text-short rounded text-xs font-medium hover:bg-short/20 transition">
            Отменить
          </button>
        )}
        {isActive && (
          <button onClick={e => { e.stopPropagation(); onClose() }}
            className="px-3 py-1.5 bg-accent/10 text-accent rounded text-xs font-medium hover:bg-accent/20 transition">
            Закрыть
          </button>
        )}
      </div>
    </div>
  )
}
