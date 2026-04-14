import { useState } from 'react'
import { Trade, TradeLive } from '../../api/client'
import { formatDate, pnlColor, fmt2, fmt2Signed } from '../../lib/formatters'
import { TradeStatusBadge } from '../StatusBadge'
import TradeCard from './TradeCard'

function formatDuration(openedAt: string, closedAt: string | null): string {
  if (!closedAt) return '—'
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime()
  if (ms < 0) return '—'
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}д ${hours % 24}ч`
  if (hours > 0) return `${hours}ч ${mins % 60}м`
  return `${mins}м`
}

function getClosePrice(t: Trade): number | null {
  const closes = t.closes || []
  if (closes.length === 0) return null
  return closes[closes.length - 1].price
}

interface TradesTableProps {
  trades: Trade[]
  livePrices: Record<number, TradeLive>
  statusFilter: string
  onSelectTrade: (t: Trade) => void
  onCloseTrade: (t: Trade) => void
  onCancelTrade: (t: Trade) => void
  onChartTrade: (t: Trade) => void
  loading: boolean
}

export default function TradesTable({
  trades, livePrices, statusFilter,
  onSelectTrade, onCloseTrade, onCancelTrade, onChartTrade, loading,
}: TradesTableProps) {
  const [sortCol, setSortCol] = useState<string>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const isFinished = statusFilter === 'FINISHED'

  if (loading) return <div className="text-center py-12 text-text-secondary">Загрузка...</div>
  if (trades.length === 0) return <div className="text-center py-12 text-text-secondary">Нет сделок</div>

  const sortedTrades = [...trades].sort((a, b) => {
    const d = sortDir === 'desc' ? -1 : 1
    const getScore = (t: Trade) => Number(t.notes?.match(/Score:\s*(\d+)/)?.[1] || 0)
    const getPnl = (t: Trade) => {
      const live = livePrices[t.id]
      if ((t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED') && live) return live.unrealizedPnl
      return t.realizedPnl - (t.fees || 0)
    }
    const getRemaining = (t: Trade) => t.amount * ((100 - t.closedPct) / 100)
    let va = 0, vb = 0
    switch (sortCol) {
      case 'date': va = new Date(a.openedAt || a.createdAt).getTime(); vb = new Date(b.openedAt || b.createdAt).getTime(); break
      case 'coin': return d * (a.coin.localeCompare(b.coin) || getScore(b) - getScore(a))
      case 'entry': va = a.entryPrice; vb = b.entryPrice; break
      case 'price': va = livePrices[a.id]?.currentPrice || 0; vb = livePrices[b.id]?.currentPrice || 0; break
      case 'size': va = getRemaining(a); vb = getRemaining(b); break
      case 'sl': {
        const slA = Math.abs((a.stopLoss - a.entryPrice) / a.entryPrice) * 100 * a.leverage
        const slB = Math.abs((b.stopLoss - b.entryPrice) / b.entryPrice) * 100 * b.leverage
        va = slA; vb = slB; break
      }
      case 'tp': {
        const tpsA = (a.takeProfits as any[]) || []; const tpsB = (b.takeProfits as any[]) || []
        const maxA = tpsA.length ? Math.abs((tpsA[tpsA.length - 1].price - a.entryPrice) / a.entryPrice) * 100 * a.leverage : 0
        const maxB = tpsB.length ? Math.abs((tpsB[tpsB.length - 1].price - b.entryPrice) / b.entryPrice) * 100 * b.leverage : 0
        va = maxA; vb = maxB; break
      }
      case 'closed': va = a.closedPct; vb = b.closedPct; break
      case 'realized': va = a.realizedPnl - (a.fees || 0); vb = b.realizedPnl - (b.fees || 0); break
      case 'pnl': va = getPnl(a); vb = getPnl(b); break
      default: va = new Date(a.openedAt || a.createdAt).getTime(); vb = new Date(b.openedAt || b.createdAt).getTime()
    }
    return d * (va - vb)
  })

  return (
    <>
    {/* Mobile cards */}
    <div className="md:hidden space-y-2">
      {(isFinished
        ? [...trades].sort((a, b) => new Date(b.closedAt || 0).getTime() - new Date(a.closedAt || 0).getTime())
        : sortedTrades
      ).map(t => (
        <TradeCard
          key={t.id}
          trade={t}
          live={livePrices[t.id]}
          statusFilter={statusFilter}
          onSelect={() => onSelectTrade(t)}
          onClose={() => onCloseTrade(t)}
          onCancel={() => onCancelTrade(t)}
          onChart={() => onChartTrade(t)}
        />
      ))}
    </div>

    {/* Desktop table */}
    <div className="hidden md:block overflow-x-auto">
      {isFinished ? (
        /* === Таблица для завершённых сделок === */
        <table className="w-full text-sm min-w-[850px]">
          <thead>
            <tr className="text-text-secondary text-xs border-b border-input">
              <th className="text-left py-3 px-2">Открыта</th>
              <th className="text-left py-3 px-2">Монета</th>
              <th className="text-left py-3 px-2">Закрыта</th>
              <th className="text-left py-3 px-2">Длительность</th>
              <th className="text-right py-3 px-2">Размер</th>
              <th className="text-right py-3 px-2">Вход</th>
              <th className="text-right py-3 px-2">Закрытие</th>
              <th className="text-right py-3 px-2">Изм.</th>
              <th className="text-right py-3 px-2">P&L</th>
              <th className="text-center py-3 px-2">Статус</th>
            </tr>
          </thead>
          <tbody>
            {[...trades].sort((a, b) => new Date(b.closedAt || 0).getTime() - new Date(a.closedAt || 0).getTime()).map(t => {
              const closePrice = getClosePrice(t)
              const dir = t.type === 'LONG' ? 1 : -1
              const changePct = closePrice ? ((closePrice - t.entryPrice) / t.entryPrice) * 100 * dir * t.leverage : null
              return (
                <tr key={t.id} className="border-b border-input/50 hover:bg-card/50 cursor-pointer"
                  onClick={() => onSelectTrade(t)}>
                  <td className="py-3 px-2 text-text-secondary text-xs">{formatDate(t.openedAt)}</td>
                  <td className="py-3 px-2 font-mono font-medium text-text-primary">
                    <span className="flex items-center gap-2">
                      {(() => {
                        const scoreMatch = t.notes?.match(/Score:\s*(\d+)/)
                        return scoreMatch ? (
                          <span className="font-mono text-xs text-accent">{scoreMatch[1]}</span>
                        ) : <span className="text-text-secondary">—</span>
                      })()}
                      <span className={`${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>{t.coin.replace('USDT', '')} - {t.leverage}x</span>
                      {t.source === 'SCANNER' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Сканер">W</span>}
                      {t.source === 'ENTRY_ANALYZER' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Анализ входа">E</span>}
                      {t.source === 'SIGNAL' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400" title="Telegram-сигнал">T</span>}
                      {t.notes?.includes('Model: aggressive') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-long/15 text-long" title="Агрессивный вход">A</span>}
                      {t.notes?.includes('Model: confirmation') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Подтверждение">C</span>}
                      {t.notes?.includes('Model: pullback') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400" title="Откат">P</span>}
                      <button
                        onClick={e => { e.stopPropagation(); onChartTrade(t) }}
                        className="text-text-secondary hover:text-accent transition-colors"
                        title="График позиции"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                      </button>
                    </span>
                  </td>
                  <td className="py-3 px-2 text-text-secondary text-xs">{t.closedAt ? formatDate(t.closedAt) : '—'}</td>
                  <td className="py-3 px-2 text-text-secondary text-xs">{formatDuration(t.openedAt, t.closedAt)}</td>
                  <td className="py-3 px-2 text-right font-mono">
                    <span className="text-text-primary">${fmt2(t.amount)}</span>
                    {t.leverage > 1 && (
                      <div className="text-xs text-text-secondary">${fmt2(t.amount * t.leverage)}</div>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right font-mono text-text-primary">${t.entryPrice}</td>
                  <td className="py-3 px-2 text-right font-mono">
                    {closePrice ? (
                      <span className={pnlColor(t.realizedPnl - (t.fees || 0))}>${closePrice}</span>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right font-mono text-xs">
                    {changePct !== null ? (
                      <span className={pnlColor(changePct)}>{fmt2Signed(changePct)}%</span>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right font-mono font-semibold">
                    <span className={pnlColor(t.realizedPnl - (t.fees || 0))} title={t.fees > 0 ? `Gross: ${fmt2Signed(t.realizedPnl)}$ · Комиссии: -${fmt2(t.fees)}$` : undefined}>
                      {fmt2Signed(t.realizedPnl - (t.fees || 0))}$
                    </span>
                  </td>
                  <td className="py-3 px-2 text-center"><TradeStatusBadge status={t.status} pnl={t.realizedPnl} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        /* === Таблица для остальных табов === */
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-text-secondary text-xs border-b border-input">
              {([
                { key: 'date', label: 'Дата', align: 'text-left' },
                { key: 'coin', label: 'Монета', align: 'text-left' },
                { key: 'entry', label: 'Вход', align: 'text-right' },
                { key: 'price', label: 'Цена', align: 'text-right' },
                { key: 'size', label: 'Размер', align: 'text-right' },
                { key: 'sl', label: 'SL', align: 'text-right' },
                { key: 'tp', label: 'TP', align: 'text-right' },
              ] as const).map(col => (
                <th key={col.key}
                  className={`${col.align} py-3 px-2 cursor-pointer hover:text-accent transition-colors select-none`}
                  onClick={() => { setSortDir(sortCol === col.key && sortDir === 'desc' ? 'asc' : 'desc'); setSortCol(col.key) }}
                >
                  {col.label}{sortCol === col.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                </th>
              ))}
              {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && (
                <th className="text-center py-3 px-2 cursor-pointer hover:text-accent transition-colors select-none"
                  onClick={() => { setSortDir(sortCol === 'closed' && sortDir === 'desc' ? 'asc' : 'desc'); setSortCol('closed') }}
                >Закрыто{sortCol === 'closed' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
              )}
              {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && (
                <th className="text-right py-3 px-2 cursor-pointer hover:text-accent transition-colors select-none"
                  onClick={() => { setSortDir(sortCol === 'realized' && sortDir === 'desc' ? 'asc' : 'desc'); setSortCol('realized') }}
                >Рлз.{sortCol === 'realized' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
              )}
              <th className="text-right py-3 px-2 cursor-pointer hover:text-accent transition-colors select-none"
                onClick={() => { setSortDir(sortCol === 'pnl' && sortDir === 'desc' ? 'asc' : 'desc'); setSortCol('pnl') }}
              >{statusFilter === 'CANCELLED' ? 'Причина' : 'P&L'}{sortCol === 'pnl' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
              <th className="text-center py-3 px-2">Статус</th>
              <th className="text-right py-3 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {sortedTrades.map(t => (
              <tr key={t.id} className="border-b border-input/50 hover:bg-card/50 cursor-pointer"
                onClick={() => onSelectTrade(t)}>
                <td className="py-3 px-2 text-text-secondary text-xs">{formatDate(t.openedAt)}</td>
                <td className="py-3 px-2 font-mono font-medium text-text-primary">
                  <span className="flex items-center gap-2">
                    {(() => {
                      const scoreMatch = t.notes?.match(/Score:\s*(\d+)/)
                      return scoreMatch ? (
                        <span className="font-mono text-xs text-accent">{scoreMatch[1]}</span>
                      ) : <span className="text-text-secondary">—</span>
                    })()}
                    <span className={`${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>{t.coin.replace('USDT', '')} - {t.leverage}x</span>
                    {t.source === 'SCANNER' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Сканер">W</span>}
                    {t.source === 'ENTRY_ANALYZER' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Анализ входа">E</span>}
                    {t.source === 'SIGNAL' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400" title="Telegram-сигнал">T</span>}
                    {t.notes?.includes('Model: aggressive') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-long/15 text-long" title="Агрессивный вход">A</span>}
                    {t.notes?.includes('Model: confirmation') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Подтверждение">C</span>}
                    {t.notes?.includes('Model: pullback') && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400" title="Откат">P</span>}

                    <button
                      onClick={e => { e.stopPropagation(); onChartTrade(t) }}
                      className="text-text-secondary hover:text-accent transition-colors"
                      title="График позиции"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                    </button>
                  </span>
                </td>
                <td className="py-3 px-2 text-right font-mono text-text-primary">${t.entryPrice}</td>
                <td className="py-3 px-2 text-right font-mono">
                  {livePrices[t.id]?.currentPrice ? (
                    <span className={pnlColor(livePrices[t.id].unrealizedPnl)}>
                      ${livePrices[t.id].currentPrice}
                    </span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right font-mono">
                  {(() => {
                    const remaining = t.amount * ((100 - t.closedPct) / 100)
                    const isReduced = t.closedPct > 0 && t.closedPct < 100
                    return (
                      <>
                        <span className="text-text-primary" title={isReduced ? `Изначально: $${fmt2(t.amount)}` : undefined}>
                          ${fmt2(remaining)}
                        </span>
                        {t.leverage > 1 && (
                          <div className="text-xs text-text-secondary">${fmt2(remaining * t.leverage)}</div>
                        )}
                      </>
                    )
                  })()}
                </td>
                <td className="py-3 px-2 text-right font-mono">
                  {(() => {
                    const dir = t.type === 'LONG' ? 1 : -1
                    const diff = (t.stopLoss - t.entryPrice) * dir
                    const pct = (diff / t.entryPrice) * 100 * t.leverage
                    const remaining = t.amount * ((100 - t.closedPct) / 100)
                    const loss = remaining * (pct / 100)
                    return (
                      <span title={`${fmt2(loss)}$ (${fmt2(pct)}%)`} className="cursor-help">
                        <span className="text-short">${t.stopLoss}</span>
                        <div className="text-xs text-short/70">{fmt2(pct)}%</div>
                      </span>
                    )
                  })()}
                </td>
                <td className="py-3 px-2 text-right font-mono">
                  {(() => {
                    const tps = (t.takeProfits as { price: number; percent?: number }[]) || []
                    const maxTp = tps.length > 0 ? tps[tps.length - 1] : null
                    if (!maxTp) return <span className="text-text-secondary">—</span>
                    const dir = t.type === 'LONG' ? 1 : -1
                    const diff = (maxTp.price - t.entryPrice) * dir
                    const pct = (diff / t.entryPrice) * 100 * t.leverage
                    const remaining = t.amount * ((100 - t.closedPct) / 100)
                    const profit = remaining * (pct / 100)
                    return (
                      <span title={`+${fmt2(profit)}$ (+${fmt2(pct)}%)`} className="cursor-help">
                        <span className="text-long">${maxTp.price}</span>
                        <div className="text-xs text-long/70">+{fmt2(pct)}%</div>
                      </span>
                    )
                  })()}
                </td>

                {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && <td className="py-3 px-2 text-center text-text-secondary">{t.closedPct}%</td>}
                {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && <td className="py-3 px-2 text-right font-mono text-sm">
                  {t.closedPct > 0 && t.closedPct < 100 ? (
                    <span className={pnlColor(t.realizedPnl - (t.fees || 0))} title={t.fees > 0 ? `Gross: ${fmt2Signed(t.realizedPnl)}$ · Комиссии: -${fmt2(t.fees)}$` : undefined}>
                      {fmt2Signed(t.realizedPnl - (t.fees || 0))}$
                    </span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>}
                <td className="py-3 px-2 text-right font-mono font-semibold">
                  {t.status === 'CANCELLED' ? (
                    <span className="text-text-secondary text-xs font-sans">
                      {{
                        PRICE_PASSED: 'Цена прошла мимо',
                        TP1_REACHED: 'Достиг TP1',
                        SETUP_INVALIDATED: 'Сетап сломался',
                        CHANGED_MIND: 'Передумал',
                        BETTER_ENTRY: 'Лучший вход',
                        MANUAL_CANCEL: 'Вручную',
                      }[t.exitReason || ''] || t.exitReason || '—'}
                    </span>
                  ) : (t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED') && livePrices[t.id] ? (
                    <span className={pnlColor(livePrices[t.id].unrealizedPnl)}>
                      {fmt2Signed(livePrices[t.id].unrealizedPnl)}$
                      <span className="text-xs ml-1 opacity-70">
                        ({fmt2Signed(livePrices[t.id].unrealizedPnlPct)}%)
                      </span>
                    </span>
                  ) : (
                    <span className={pnlColor(t.realizedPnl - (t.fees || 0))} title={t.fees > 0 ? `Gross: ${fmt2Signed(t.realizedPnl)}$ · Комиссии: -${fmt2(t.fees)}$` : undefined}>
                      {fmt2Signed(t.realizedPnl - (t.fees || 0))}$
                    </span>
                  )}
                </td>
                <td className="py-3 px-2 text-center"><TradeStatusBadge status={t.status} pnl={t.realizedPnl} /></td>
                <td className="py-3 px-2 text-right">
                  {t.status === 'PENDING_ENTRY' && (
                    <button onClick={e => { e.stopPropagation(); onCancelTrade(t) }}
                      className="p-1.5 bg-short/10 text-short rounded hover:bg-short/20 transition" title="Отменить">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                  {(t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED') && (
                    <button onClick={e => { e.stopPropagation(); onCloseTrade(t) }}
                      className="p-1.5 bg-accent/10 text-accent rounded hover:bg-accent/20 transition" title="Закрыть">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    </>
  )
}
