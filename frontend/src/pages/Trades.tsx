import { useState, useEffect, useCallback } from 'react'
import {
  getTrades, getTradeStats, getTradeLivePrices, closeAllTrades, deleteAllTrades, cancelTrade,
  Trade, TradeStats, TradeLive,
} from '../api/client'
import { sanitizeCsvField } from '../utils/sanitizeCsv'
import { formatDate, pnlColor, fmt2, fmt2Signed } from '../lib/formatters'
import { TradeStatusBadge } from '../components/StatusBadge'
import NewTradeForm from '../components/trades/NewTradeForm'
import CloseModal from '../components/trades/CloseModal'
import TradeDetail from '../components/trades/TradeDetail'
import StatsPanel from '../components/trades/StatsPanel'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'

function tradeToPosition(t: Trade, currentPrice: number | null): PositionChartPosition {
  // For closed trades: use last close price as "current" (so the realized zone shows final state).
  // For open trades: use live price polled from the market.
  // For pending trades (limit order not filled): no realized P&L — keep zones flat at entry.
  const isPending = t.status === 'PENDING_ENTRY'
  const closes = t.closes || []
  const effectivePrice = isPending
    ? null
    : currentPrice != null
      ? currentPrice
      : (closes.length > 0 ? closes[closes.length - 1].price : null)
  return {
    coin: t.coin,
    type: t.type,
    entry: t.entryPrice,
    stopLoss: t.stopLoss,
    takeProfits: (t.takeProfits || []).map(tp => tp.price),
    openedAt: isPending ? null : t.openedAt,
    closedAt: t.closedAt,
    currentPrice: effectivePrice,
    partialCloses: closes.map(c => ({
      price: c.price,
      percent: c.percent,
      closedAt: c.closedAt,
      isSL: c.isSL,
    })),
  }
}

export default function Trades() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [stats, setStats] = useState<TradeStats | null>(null)
  const [livePrices, setLivePrices] = useState<Record<number, TradeLive>>({})
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [statusFilter, setStatusFilter] = useState('ACTIVE')
  const [selected, setSelected] = useState<Trade | null>(null)
  const [closing, setClosing] = useState<Trade | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [chartTrade, setChartTrade] = useState<Trade | null>(null)
  const [cancelling, setCancelling] = useState<Trade | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelLoading, setCancelLoading] = useState(false)
  const [sortCol, setSortCol] = useState<string>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tRes, sRes] = await Promise.all([
        getTrades({ status: statusFilter !== 'ALL' ? statusFilter : undefined, page }),
        getTradeStats(),
      ])
      setTrades(tRes.data)
      setTotalPages(tRes.totalPages)
      setStats(sRes)
    } catch { } finally { setLoading(false) }
  }, [page, statusFilter])

  useEffect(() => { load() }, [load])

  // Poll live prices for open trades every 3 seconds
  useEffect(() => {
    async function fetchLive() {
      const data = await getTradeLivePrices()
      const map: Record<number, TradeLive> = {}
      data.forEach(d => { map[d.id] = d })
      setLivePrices(map)
    }
    fetchLive()
    const interval = setInterval(fetchLive, 3000)
    return () => clearInterval(interval)
  }, [trades])

  const statuses = ['ALL', 'PENDING_ENTRY', 'ACTIVE', 'FINISHED', 'CANCELLED']
  const statusLabels: Record<string, string> = {
    ALL: 'Все', PENDING_ENTRY: 'Ожидание', ACTIVE: 'Открытые', FINISHED: 'Завершённые', CANCELLED: 'Отменённые',
  }
  const isFinished = statusFilter === 'FINISHED'

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

  const [exporting, setExporting] = useState(false)

  async function exportCSV() {
    setExporting(true)
    try {
      // Fetch all finished trades (paginate through all pages)
      const allTrades: Trade[] = []
      let p = 1
      while (true) {
        const res = await getTrades({ status: 'FINISHED', page: p })
        allTrades.push(...res.data)
        if (p >= res.totalPages) break
        p++
      }

      const esc = (v: string) => `"${sanitizeCsvField(v).replace(/"/g, '""')}"`
      const header = [
        'ID', 'Монета', 'Тип', 'Плечо', 'Источник', 'Модель входа',
        'Цена входа', 'Тип ордера', 'Stop Loss',
        'TP1 цена', 'TP1 %', 'TP2 цена', 'TP2 %', 'TP3 цена', 'TP3 %',
        'Цена закрытия', 'Размер (маржа)', 'Размер (с плечом)',
        'Реализовано P&L (gross)', 'Комиссии', 'Фандинг', 'P&L (net)',
        'P&L %', 'Статус',
        'Открыта', 'Закрыта', 'Длительность',
        'Закрытие 1 цена', 'Закрытие 1 %', 'Закрытие 1 P&L', 'Закрытие 1 дата', 'Закрытие 1 SL?',
        'Закрытие 2 цена', 'Закрытие 2 %', 'Закрытие 2 P&L', 'Закрытие 2 дата', 'Закрытие 2 SL?',
        'Закрытие 3 цена', 'Закрытие 3 %', 'Закрытие 3 P&L', 'Закрытие 3 дата', 'Закрытие 3 SL?',
        'Score', 'Заметки',
      ]

      const rows = allTrades.map(t => {
        const closes = t.closes || []
        const tps = t.takeProfits || []
        const cp = getClosePrice(t)
        const netPnl = t.realizedPnl - (t.fees || 0) - (t.fundingPaid || 0)
        const pnlPct = t.amount > 0 ? (netPnl / t.amount) * 100 : 0
        const score = t.notes?.match(/Score:\s*(\d+)/)?.[1] || ''

        const closeData = (i: number) => {
          const c = closes[i]
          if (!c) return ['', '', '', '', '']
          return [c.price, c.percent + '%', fmt2(c.pnl) + '$', c.closedAt, c.isSL ? 'Да' : 'Нет']
        }

        return [
          t.id,
          t.coin,
          t.type,
          t.leverage,
          t.source,
          t.notes?.match(/Model:\s*(\w+)/)?.[1] || '',
          t.entryPrice,
          t.entryOrderType,
          t.stopLoss,
          tps[0]?.price ?? '', tps[0]?.percent ? tps[0].percent + '%' : '',
          tps[1]?.price ?? '', tps[1]?.percent ? tps[1].percent + '%' : '',
          tps[2]?.price ?? '', tps[2]?.percent ? tps[2].percent + '%' : '',
          cp ?? '',
          fmt2(t.amount),
          fmt2(t.amount * t.leverage),
          fmt2(t.realizedPnl),
          fmt2(t.fees || 0),
          fmt2(t.fundingPaid || 0),
          fmt2(netPnl),
          fmt2(pnlPct) + '%',
          t.status,
          t.openedAt,
          t.closedAt || '',
          formatDuration(t.openedAt, t.closedAt),
          ...closeData(0),
          ...closeData(1),
          ...closeData(2),
          score,
          esc(t.notes || ''),
        ].map(v => typeof v === 'string' && v.startsWith('"') ? v : esc(String(v)))
      })

      const bom = '\uFEFF'
      const csv = bom + [header.map(h => esc(h)).join(';'), ...rows.map(r => r.join(';'))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[Trades] CSV export error:', err)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Журнал сделок</h1>
        <div className="flex gap-2">
          {confirmCloseAll ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">Закрыть все по рынку?</span>
              <button onClick={async () => { setBulkLoading(true); try { await closeAllTrades(); load() } catch {} finally { setBulkLoading(false); setConfirmCloseAll(false) } }}
                disabled={bulkLoading} className="px-3 py-1.5 bg-accent text-black rounded text-xs font-medium disabled:opacity-50">
                {bulkLoading ? '...' : 'Да'}
              </button>
              <button onClick={() => setConfirmCloseAll(false)} className="px-3 py-1.5 bg-input text-text-secondary rounded text-xs">Нет</button>
            </div>
          ) : (
            <button onClick={() => setConfirmCloseAll(true)}
              className="px-3 py-1.5 bg-accent/10 text-accent rounded-lg text-xs font-medium hover:bg-accent/20 transition">
              Закрыть все
            </button>
          )}
          {confirmDeleteAll ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-short">Удалить ВСЕ сделки?</span>
              <button onClick={async () => { setBulkLoading(true); try { await deleteAllTrades(); load() } catch {} finally { setBulkLoading(false); setConfirmDeleteAll(false) } }}
                disabled={bulkLoading} className="px-3 py-1.5 bg-short text-white rounded text-xs font-medium disabled:opacity-50">
                {bulkLoading ? '...' : 'Да, удалить'}
              </button>
              <button onClick={() => setConfirmDeleteAll(false)} className="px-3 py-1.5 bg-input text-text-secondary rounded text-xs">Отмена</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDeleteAll(true)}
              className="px-3 py-1.5 bg-short/10 text-short rounded-lg text-xs font-medium hover:bg-short/20 transition">
              Очистить историю
            </button>
          )}
        </div>
      </div>
      <NewTradeForm onCreated={load} />

      <StatsPanel stats={stats} livePrices={livePrices} />

      {/* Монеты P&L */}
      {stats && Object.keys(stats.byCoin).length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {Object.entries(stats.byCoin)
            .sort((a, b) => b[1].pnl - a[1].pnl)
            .map(([coin, d]) => (
              <div key={coin} className="bg-card rounded-lg px-3 py-2 text-sm">
                <span className="font-mono font-medium text-text-primary">{coin}</span>
                <span className={`ml-2 font-mono ${pnlColor(d.pnl)}`}>{fmt2Signed(d.pnl)}$</span>
                <span className="ml-1 text-text-secondary text-xs">({d.wins}/{d.trades})</span>
              </div>
            ))}
        </div>
      )}

      {/* Фильтры */}
      <div className="flex gap-2 items-center">
        {statuses.map(s => (
          <button key={s} onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm transition ${
              statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'
            }`}>
            {statusLabels[s]}
          </button>
        ))}
        {isFinished && (
          <button onClick={exportCSV} disabled={exporting}
            className="ml-auto px-3 py-1.5 bg-card text-text-secondary rounded-lg text-xs font-medium hover:text-text-primary hover:bg-input transition disabled:opacity-50 flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {exporting ? 'Экспорт...' : 'CSV'}
          </button>
        )}
      </div>

      {/* Таблица */}
      {loading ? (
        <div className="text-center py-12 text-text-secondary">Загрузка...</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">Нет сделок</div>
      ) : (
        <div className="overflow-x-auto">
          {isFinished ? (
            /* === Таблица для завершённых сделок === */
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[85px]" />
                <col className="w-[130px]" />
                <col className="w-[85px]" />
                <col className="w-[85px]" />
                <col className="w-[55px]" />
                <col className="w-[60px]" />
                <col className="w-[60px]" />
                <col className="w-[60px]" />
                <col className="w-[100px]" />
                <col className="w-[75px]" />
              </colgroup>
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
                      onClick={() => setSelected(t)}>
                      <td className="py-3 px-2 text-text-secondary text-xs">{formatDate(t.openedAt)}</td>
                      <td className="py-3 px-2 font-mono font-medium text-text-primary">
                        <span className="flex items-center gap-1">
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
                            onClick={e => { e.stopPropagation(); setChartTrade(t) }}
                            className="text-text-secondary hover:text-accent transition-colors"
                            title="График позиции"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
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
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[85px]" />
                <col className="w-[130px]" />
                <col className="w-[60px]" />
                <col className="w-[60px]" />
                <col className="w-[60px]" />
                <col className="w-[70px]" />
                <col className="w-[70px]" />
                {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && <col className="w-[55px]" />}
                {!['PENDING_ENTRY', 'CANCELLED'].includes(statusFilter) && <col className="w-[55px]" />}
                <col className="w-[100px]" />
                <col className="w-[100px]" />
                <col className="w-[30px]" />
              </colgroup>
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
                {[...trades].sort((a, b) => {
                  const dir = sortDir === 'desc' ? -1 : 1
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
                    case 'coin': return dir * (a.coin.localeCompare(b.coin) || getScore(b) - getScore(a))
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
                  return dir * (va - vb)
                }).map(t => (
                  <tr key={t.id} className="border-b border-input/50 hover:bg-card/50 cursor-pointer"
                    onClick={() => setSelected(t)}>
                    <td className="py-3 px-2 text-text-secondary text-xs">{formatDate(t.openedAt)}</td>
                    <td className="py-3 px-2 font-mono font-medium text-text-primary">
                      <span className="flex items-center gap-1">
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
                          onClick={e => { e.stopPropagation(); setChartTrade(t) }}
                          className="text-text-secondary hover:text-accent transition-colors"
                          title="График позиции"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
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
                        <button onClick={e => { e.stopPropagation(); setCancelling(t) }}
                          className="p-1.5 bg-short/10 text-short rounded hover:bg-short/20 transition" title="Отменить">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      )}
                      {(t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED') && (
                        <button onClick={e => { e.stopPropagation(); setClosing(t) }}
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
      )}

      {/* Пагинация */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          {Array.from({ length: totalPages }, (_, i) => (
            <button key={i} onClick={() => setPage(i + 1)}
              className={`w-8 h-8 rounded text-sm ${page === i + 1 ? 'bg-accent text-black' : 'bg-input text-text-secondary hover:text-text-primary'}`}>
              {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Модалки */}
      {closing && <CloseModal trade={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); load() }} />}
      {selected && <TradeDetail trade={selected} onClose={() => setSelected(null)} onRefresh={load} currentPrice={livePrices[selected.id]?.currentPrice ?? undefined} />}
      {cancelling && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => { setCancelling(null); setCancelReason('') }}>
          <div className="bg-card border border-input rounded-lg p-6 w-[400px]" onClick={e => e.stopPropagation()}>
            <h3 className="text-text-primary font-semibold mb-1">Отменить сделку</h3>
            <p className="text-text-secondary text-sm mb-4">{cancelling.coin.replace('USDT', '')} {cancelling.type} ${cancelling.entryPrice}</p>
            <div className="space-y-2 mb-4">
              {[
                { value: 'PRICE_PASSED', label: 'Цена прошла мимо' },
                { value: 'TP1_REACHED', label: 'Цена достигла TP1' },
                { value: 'SETUP_INVALIDATED', label: 'Сетап сломался' },
                { value: 'CHANGED_MIND', label: 'Передумал' },
                { value: 'BETTER_ENTRY', label: 'Нашёл лучший вход' },
              ].map(r => (
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
                onClick={() => { setCancelling(null); setCancelReason('') }}
                className="flex-1 py-2 rounded bg-input text-text-secondary hover:text-text-primary transition text-sm"
              >
                Назад
              </button>
              <button
                disabled={!cancelReason || cancelLoading}
                onClick={async () => {
                  setCancelLoading(true)
                  try {
                    await cancelTrade(cancelling.id, cancelReason)
                    setCancelling(null)
                    setCancelReason('')
                    load()
                  } catch {}
                  setCancelLoading(false)
                }}
                className="flex-1 py-2 rounded bg-short/20 text-short hover:bg-short/30 transition text-sm disabled:opacity-40"
              >
                {cancelLoading ? 'Отмена...' : 'Отменить'}
              </button>
            </div>
          </div>
        </div>
      )}
      {chartTrade && (
        <PositionChartModal
          position={tradeToPosition(chartTrade, livePrices[chartTrade.id]?.currentPrice ?? null)}
          onClose={() => setChartTrade(null)}
        />
      )}
    </div>
  )
}
