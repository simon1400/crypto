import { useEffect, useState } from 'react'
import {
  getBreakoutPaperTrades,
  type BreakoutTrade as PaperTrade,
} from '../api/breakoutPaper'
import { formatDate, fmt2, fmt2Signed, fmtPrice, pnlColor } from '../lib/formatters'

interface Props {
  symbol: string
  onClose: () => void
  onSelectTrade?: (trade: PaperTrade) => void
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Открыта',
  TP1_HIT: 'TP1 ✓',
  TP2_HIT: 'TP2 ✓',
  TP3_HIT: 'TP3 ✓',
  CLOSED: 'Закрыта',
  SL_HIT: 'SL',
  EXPIRED: 'Истёк',
}

function statusBadgeClasses(status: string, pnl: number): string {
  if (status === 'OPEN' || status === 'TP1_HIT' || status === 'TP2_HIT') {
    return 'bg-accent/15 text-accent'
  }
  if (status === 'SL_HIT') return 'bg-short/15 text-short'
  if (pnl > 0) return 'bg-long/15 text-long'
  if (pnl < 0) return 'bg-short/10 text-short'
  return 'bg-neutral/15 text-neutral'
}

export default function SymbolHistoryModal({ symbol, onClose, onSelectTrade }: Props) {
  const [trades, setTrades] = useState<PaperTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getBreakoutPaperTrades({ symbol, limit: 500, orderBy: 'closedAt' })
      .then(r => { if (!cancelled) setTrades(r.data) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [symbol])

  const total = trades.length
  const wins = trades.filter(t => t.netPnlUsd > 0).length
  const losses = trades.filter(t => t.netPnlUsd < 0).length
  const totalPnl = trades.reduce((a, t) => a + (t.netPnlUsd || 0), 0)
  const wr = total > 0 ? (wins / total) * 100 : 0

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-input rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-input">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              История · <span className="font-mono text-accent">{symbol}</span>
            </h2>
            <div className="text-xs text-text-secondary mt-0.5">
              {total} {total === 1 ? 'сделка' : 'сделок'} · WR {wr.toFixed(0)}% · {wins}W / {losses}L ·
              <span className={pnlColor(totalPnl) + ' ml-1'}>{fmt2Signed(totalPnl)}$</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-2xl leading-none px-2"
            title="Закрыть"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="text-center py-12 text-text-secondary">Загрузка...</div>
          )}
          {error && (
            <div className="text-center py-12 text-short">{error}</div>
          )}
          {!loading && !error && trades.length === 0 && (
            <div className="text-center py-12 text-text-secondary">
              По инструменту {symbol} ещё нет сделок.
            </div>
          )}
          {!loading && !error && trades.length > 0 && (
            <table className="w-full text-sm font-mono">
              <thead className="text-text-secondary text-xs sticky top-0 bg-card">
                <tr className="border-b border-input">
                  <th className="text-left px-3 py-2">Дата</th>
                  <th className="text-left px-3 py-2">Сторона</th>
                  <th className="text-right px-3 py-2">Вход</th>
                  <th className="text-right px-3 py-2">Выход</th>
                  <th className="text-right px-3 py-2">Маржа</th>
                  <th className="text-right px-3 py-2">P&L</th>
                  <th className="text-center px-3 py-2">Статус</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const isOpen = ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)
                  const sideText = t.side === 'BUY' ? 'LONG' : 'SHORT'
                  const sideCls = t.side === 'BUY' ? 'text-long' : 'text-short'
                  const closes = t.closes ?? []
                  const lastClose = closes.length > 0 ? closes[closes.length - 1] : null
                  const exitPrice = lastClose?.price ?? null
                  const lev = t.leverage && t.leverage > 0
                    ? t.leverage
                    : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
                      ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
                      : 1)
                  const margin = t.marginUsd ?? (t.positionSizeUsd / lev)
                  const pnlPct = t.depositAtEntryUsd > 0
                    ? (t.netPnlUsd / t.depositAtEntryUsd) * 100
                    : 0

                  const clickable = !!onSelectTrade
                  return (
                    <tr
                      key={t.id}
                      className={`border-t border-input ${clickable ? 'hover:bg-input/50 cursor-pointer' : ''} transition-colors`}
                      onClick={() => onSelectTrade?.(t)}
                    >
                      <td className="px-3 py-2 text-text-secondary whitespace-nowrap leading-tight">
                        <div className="text-text-primary text-[11px]">
                          {formatDate(t.closedAt ?? t.openedAt)}
                        </div>
                        {t.closedAt && (
                          <div className="text-[10px] text-text-secondary">
                            откр: {formatDate(t.openedAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-medium ${sideCls}`}>{sideText}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-text-primary">
                        ${fmtPrice(t.entryPrice)}
                      </td>
                      <td className="px-3 py-2 text-right text-text-primary">
                        {exitPrice != null ? `$${fmtPrice(exitPrice)}` : <span className="text-text-secondary">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-text-primary leading-tight">
                        ${fmt2(margin)}
                        <div className="text-[10px] text-accent/80">×{lev.toFixed(1)}</div>
                      </td>
                      <td className="px-3 py-2 text-right leading-tight">
                        {isOpen ? (
                          <span className="text-text-secondary">—</span>
                        ) : (
                          <span
                            className={pnlColor(t.netPnlUsd)}
                            title={t.feesPaidUsd > 0
                              ? `Gross: ${fmt2Signed(t.realizedPnlUsd)}$ · Комиссии: -${fmt2(t.feesPaidUsd)}$`
                              : undefined}
                          >
                            {fmt2Signed(t.netPnlUsd)}$
                            {t.netPnlUsd !== 0 && (
                              <div className="text-[10px] opacity-70">({fmt2Signed(pnlPct)}%)</div>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${statusBadgeClasses(t.status, t.netPnlUsd)}`}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
