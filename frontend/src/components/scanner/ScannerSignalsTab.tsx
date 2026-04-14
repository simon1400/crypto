import { useState, useEffect } from 'react'
import { sanitizeCsvField } from '../../utils/sanitizeCsv'
import {
  getScannerSignals, deleteSignal, deleteAllSignals, deleteUnusedSignals,
  ScannerSignal,
} from '../../api/client'
import UnifiedSignalCard from './UnifiedSignalCard'

interface ScannerSignalsTabProps {
  balance: number
  riskPct: number
  refreshKey: number  // incremented by parent when scan tab modifies signals
  onShowChart: (signal: ScannerSignal) => void
}

export default function ScannerSignalsTab({ balance, riskPct, refreshKey, onShowChart }: ScannerSignalsTabProps) {
  const [signals, setSignals] = useState<ScannerSignal[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [sortBy, setSortBy] = useState<'score' | 'date'>('score')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [confirmDeleteUnused, setConfirmDeleteUnused] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [csvExporting, setCsvExporting] = useState(false)

  useEffect(() => {
    loadSignals()
  }, [page, statusFilter, dateFrom, dateTo, refreshKey])

  async function loadSignals() {
    try {
      const res = await getScannerSignals(page, statusFilter || undefined, dateFrom || undefined, dateTo || undefined)
      setSignals(res.data.filter((s: ScannerSignal) => s.strategy !== 'entry_analysis'))
      setTotalPages(res.totalPages)
      setTotalCount(res.total)
    } catch (err) { console.error('[ScannerSignalsTab] Failed to load signals:', err) }
  }

  async function handleDelete(id: number) {
    try {
      await deleteSignal(id)
      setSignals(prev => prev.filter(s => s.id !== id))
    } catch (err) { console.error('[ScannerSignalsTab] Failed to delete signal:', err) }
  }

  async function exportTakenCSV() {
    setCsvExporting(true)
    try {
      const allSignals: ScannerSignal[] = []
      let p = 1
      while (true) {
        const res = await getScannerSignals(p)
        allSignals.push(...res.data)
        if (p >= res.totalPages) break
        p++
      }
      const taken = allSignals.filter(s => s.takenAt)

      const esc = (v: string) => `"${sanitizeCsvField(v).replace(/"/g, '""')}"`

      const header = [
        'Signal ID', 'Монета', 'Тип', 'Стратегия', 'Score', 'Setup Score', 'Setup Category', 'Execution Type', 'Entry Model', 'Плечо',
        'Цена входа', 'Initial Stop', 'Current Stop', 'SL %',
        'TP1 цена', 'TP1 R:R', 'TP2 цена', 'TP2 R:R', 'TP3 цена', 'TP3 R:R',
        'Размер (маржа)', 'Размер (с плечом)', '% от депозита',
        'Реализовано P&L', 'Закрыто %', 'Статус', 'Exit Reason',
        'Создан', 'Взят', 'Закрыт', 'Время в сделке (мин)',
        'Закрытие 1 цена', 'Закрытие 1 %', 'Закрытие 1 P&L', 'Закрытие 1 дата', 'Закрытие 1 SL?',
        'Закрытие 2 цена', 'Закрытие 2 %', 'Закрытие 2 P&L', 'Закрытие 2 дата', 'Закрытие 2 SL?',
        'Закрытие 3 цена', 'Закрытие 3 %', 'Закрытие 3 P&L', 'Закрытие 3 дата', 'Закрытие 3 SL?',
        'Fear & Greed', 'Режим рынка', 'Категория', 'Фандинг', 'OI изм.',
        'Stop → BE', 'Trailing', 'MFE %', 'MAE %', 'TP1 Hit', 'TP2 Hit', 'TP3 Hit',
        // New context fields
        'RSI 1h', 'ADX 1h', 'Volume Ratio', 'Funding Rate', 'OI Δ 1h', 'OI Δ 4h',
        'Distance to EMA20', 'Distance to VWAP', 'Impulse Extension',
        'Data Completeness',
        'GPT анализ',
      ]

      const fmt2 = (n: number) => Number(n).toFixed(2)

      const rows = taken.map(s => {
        const tps = s.takeProfits || []
        const closes = s.closes || []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mc = (s.marketContext as any) || {}
        const sc = mc.signal_context || {}
        const dir = s.type === 'LONG' ? 1 : -1
        const initialStop = s.initialStop ?? mc.initial_stop ?? s.stopLoss
        const currentStop = s.currentStop ?? mc.current_stop ?? s.stopLoss
        const slPct = ((initialStop - s.entry) / s.entry) * 100 * dir * s.leverage

        const closeData = (i: number) => {
          const c = closes[i]
          if (!c) return ['', '', '', '', '']
          return [c.price, c.percent + '%', fmt2(c.pnl) + '$', c.closedAt, c.isSL ? 'Да' : 'Нет']
        }

        return [
          s.id,
          s.coin,
          s.type,
          s.strategy,
          s.score,
          s.setupScore ?? mc.setup_score ?? '',
          s.setupCategory ?? mc.setup_category ?? '',
          s.executionType ?? mc.execution_type ?? '',
          s.entryModel ?? mc.entry_model ?? mc.bestEntryType ?? '',
          s.leverage,
          s.entry,
          initialStop,
          currentStop,
          fmt2(slPct) + '%',
          tps[0]?.price ?? '', tps[0]?.rr ?? '',
          tps[1]?.price ?? '', tps[1]?.rr ?? '',
          tps[2]?.price ?? '', tps[2]?.rr ?? '',
          fmt2(s.amount),
          fmt2(s.amount * s.leverage),
          s.positionPct + '%',
          fmt2(s.realizedPnl),
          s.closedPct + '%',
          s.status,
          s.exitReason ?? '',
          s.createdAt,
          s.takenAt || '',
          s.closedAt || '',
          s.timeInTradeMin ?? '',
          ...closeData(0),
          ...closeData(1),
          ...closeData(2),
          mc.fearGreed ?? mc.fearGreedZone ?? '',
          mc.regime ?? '',
          mc.category ?? '',
          mc.funding != null ? (typeof mc.funding === 'object' ? fmt2(mc.funding.fundingRate * 100) + '%' : fmt2(mc.funding)) : '',
          mc.oi != null ? (typeof mc.oi === 'object' ? fmt2(mc.oi.oiChangePct1h) + '%' : fmt2(mc.oiChange) + '%') : '',
          s.stopMovedToBe ? 'Да' : 'Нет',
          s.trailingActivated ? 'Да' : 'Нет',
          s.mfe != null ? fmt2(s.mfe) + '%' : '',
          s.mae != null ? fmt2(s.mae) + '%' : '',
          s.tp1HitTimestamp ? 'Да' : 'Нет',
          s.tp2HitTimestamp ? 'Да' : 'Нет',
          s.tp3HitTimestamp ? 'Да' : 'Нет',
          // Context fields from signal_context
          sc.rsi_1h ?? '',
          sc.adx_1h ?? '',
          sc.volume_ratio ?? '',
          sc.funding_rate != null ? fmt2(sc.funding_rate * 100) + '%' : '',
          sc.oi_change_1h != null ? fmt2(sc.oi_change_1h) + '%' : '',
          sc.oi_change_4h != null ? fmt2(sc.oi_change_4h) + '%' : '',
          sc.distance_to_ema20 != null ? fmt2(sc.distance_to_ema20) + '%' : '',
          sc.distance_to_vwap != null ? fmt2(sc.distance_to_vwap) + '%' : '',
          sc.impulse_extension_at_entry_atr_1h ?? '',
          sc.data_completeness != null ? fmt2(sc.data_completeness * 100) + '%' : '',
          esc(s.aiAnalysis || ''),
        ].map(v => typeof v === 'string' && v.startsWith('"') ? v : esc(String(v)))
      })

      const bom = '\uFEFF'
      const csv = bom + [header.map(h => esc(h)).join(';'), ...rows.map(r => r.join(';'))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `signals_taken_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[ScannerSignalsTab] CSV export error:', err)
    } finally {
      setCsvExporting(false)
    }
  }

  const sortedSignals = [...signals].sort((a, b) => {
    if (sortBy === 'score') return b.score - a.score
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
  const INITIAL_LIMIT = 8
  const visibleSignals = showAll ? sortedSignals : sortedSignals.slice(0, INITIAL_LIMIT)
  const hasMore = sortedSignals.length > INITIAL_LIMIT

  return (
    <>
      {/* Filters row */}
      <div className="overflow-x-auto scrollbar-hide -mx-4 px-4">
        <div className="flex gap-1 min-w-max">
          {[
            { value: '', label: 'Все' },
            { value: 'NEW', label: 'Новые' },
            { value: 'PENDING', label: 'Ожидание' },
            { value: 'ACTIVE', label: 'Открытые' },
            { value: 'FINISHED', label: 'Завершённые' },
            { value: 'CANCELLED', label: 'Отменённые' },
          ].map(f => (
            <button
              key={f.value}
              onClick={() => { setStatusFilter(f.value); setPage(1); setShowAll(false) }}
              className={`px-3 py-1 text-xs rounded-lg whitespace-nowrap transition-colors ${statusFilter === f.value ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Date range + sort + actions */}
      {signals.length > 0 && (
        <div className="space-y-3">
          {/* Date range */}
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); setPage(1); setShowAll(false) }}
              className="bg-input text-text-primary text-xs rounded px-2 py-2 border border-transparent focus:border-accent/40 focus:outline-none"
            />
            <span className="text-text-secondary text-xs">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => { setDateTo(e.target.value); setPage(1); setShowAll(false) }}
              className="bg-input text-text-primary text-xs rounded px-2 py-2 border border-transparent focus:border-accent/40 focus:outline-none"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(''); setDateTo(''); setPage(1) }}
                className="text-xs text-text-secondary hover:text-short transition-colors p-1.5"
                title="Сбросить даты"
              >
                ✕
              </button>
            )}
          </div>

          {/* Sort + count */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">Сортировка:</span>
            <button
              onClick={() => setSortBy('score')}
              className={`px-3 py-1.5 text-xs rounded ${sortBy === 'score' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
            >
              По скору ↓
            </button>
            <button
              onClick={() => setSortBy('date')}
              className={`px-3 py-1.5 text-xs rounded ${sortBy === 'date' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
            >
              По дате
            </button>
            <span className="text-xs text-text-secondary ml-auto">{signals.length} сигналов</span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button onClick={exportTakenCSV} disabled={csvExporting}
              className="px-3 py-1.5 bg-card text-text-secondary rounded-lg text-xs font-medium hover:text-text-primary hover:bg-input transition disabled:opacity-50 flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {csvExporting ? '...' : 'CSV'}
            </button>

            {confirmDeleteUnused ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-secondary">Невзятые?</span>
                <button disabled={bulkLoading} onClick={async () => { setBulkLoading(true); try { await deleteUnusedSignals(); loadSignals() } catch (err: any) { alert(err?.message || 'Failed to delete unused signals') } finally { setBulkLoading(false); setConfirmDeleteUnused(false) } }}
                  className="px-3 py-1.5 bg-accent text-black rounded text-xs font-medium disabled:opacity-50">{bulkLoading ? '...' : 'Да'}</button>
                <button onClick={() => setConfirmDeleteUnused(false)} className="px-3 py-1.5 bg-input text-text-secondary rounded text-xs">Нет</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDeleteUnused(true)}
                className="px-3 py-1.5 bg-accent/10 text-accent rounded-lg text-xs font-medium hover:bg-accent/20 transition whitespace-nowrap">
                Удалить невзятые
              </button>
            )}

            {confirmDeleteAll ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-short">ВСЕ?</span>
                <button disabled={bulkLoading} onClick={async () => { setBulkLoading(true); try { await deleteAllSignals(); loadSignals() } catch (err: any) { alert(err?.message || 'Failed to delete all signals') } finally { setBulkLoading(false); setConfirmDeleteAll(false) } }}
                  className="px-3 py-1.5 bg-short text-white rounded text-xs font-medium disabled:opacity-50">{bulkLoading ? '...' : 'Да'}</button>
                <button onClick={() => setConfirmDeleteAll(false)} className="px-3 py-1.5 bg-input text-text-secondary rounded text-xs">Нет</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDeleteAll(true)}
                className="px-3 py-1.5 bg-short/10 text-short rounded-lg text-xs font-medium hover:bg-short/20 transition whitespace-nowrap">
                Очистить всё
              </button>
            )}
          </div>
        </div>
      )}

      {signals.length === 0 ? (
        <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
          Нет сигналов. Запустите сканер чтобы найти торговые возможности.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {visibleSignals.map(s => (
              <UnifiedSignalCard key={s.id} mode="saved" signal={s} onStatusChange={loadSignals} onDelete={handleDelete} balance={balance} riskPct={riskPct} onShowChart={onShowChart} />
            ))}
          </div>
          {hasMore && !showAll && (
            <div className="flex justify-center">
              <button
                onClick={() => setShowAll(true)}
                className="px-4 py-2 text-sm rounded-lg bg-card text-text-secondary hover:text-accent hover:bg-card/80 transition-colors"
              >
                Показать все ({sortedSignals.length})
              </button>
            </div>
          )}
          {showAll && hasMore && (
            <div className="flex justify-center">
              <button
                onClick={() => setShowAll(false)}
                className="px-4 py-2 text-sm rounded-lg bg-card text-text-secondary hover:text-accent hover:bg-card/80 transition-colors"
              >
                Свернуть
              </button>
            </div>
          )}
        </>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <span className="text-xs text-text-secondary mr-2">
            {(page - 1) * 20 + 1}–{Math.min(page * 20, totalCount)} из {totalCount}
          </span>
          <button
            onClick={() => setPage(1)}
            disabled={page === 1}
            className="px-2 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary text-sm"
          >
            «
          </button>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-2 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary text-sm"
          >
            ‹
          </button>
          {(() => {
            const pages: number[] = []
            let start = Math.max(1, page - 2)
            let end = Math.min(totalPages, start + 4)
            if (end - start < 4) start = Math.max(1, end - 4)
            for (let i = start; i <= end; i++) pages.push(i)
            return pages.map(p => (
              <button
                key={p}
                onClick={() => { setPage(p); setShowAll(false) }}
                className={`px-2.5 py-1 rounded text-sm transition-colors ${
                  p === page ? 'bg-accent/20 text-accent font-bold' : 'bg-card text-text-secondary hover:text-text-primary'
                }`}
              >
                {p}
              </button>
            ))
          })()}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-2 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary text-sm"
          >
            ›
          </button>
          <button
            onClick={() => setPage(totalPages)}
            disabled={page === totalPages}
            className="px-2 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary text-sm"
          >
            »
          </button>
        </div>
      )}
    </>
  )
}
