import { useState, useEffect, useCallback } from 'react'
import {
  getTrades, getTradeStats, getTradeLivePrices, closeAllTrades, deleteAllTrades,
  Trade, TradeStats, TradeLive,
} from '../api/client'
import { sanitizeCsvField } from '../utils/sanitizeCsv'
import { pnlColor, fmt2, fmt2Signed } from '../lib/formatters'
import NewTradeForm from '../components/trades/NewTradeForm'
import CloseModal from '../components/trades/CloseModal'
import TradeDetail from '../components/trades/TradeDetail'
import StatsPanel from '../components/trades/StatsPanel'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import TradesFilterBar from '../components/trades/TradesFilterBar'
import TradesTable from '../components/trades/TradesTable'
import CancelTradeModal from '../components/trades/CancelTradeModal'
import Pagination from '../components/Pagination'

function tradeToPosition(t: Trade, currentPrice: number | null): PositionChartPosition {
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
  const [minScore, setMinScore] = useState(70)
  const [selected, setSelected] = useState<Trade | null>(null)
  const [closing, setClosing] = useState<Trade | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [chartTrade, setChartTrade] = useState<Trade | null>(null)
  const [cancelling, setCancelling] = useState<Trade | null>(null)
  const [exporting, setExporting] = useState(false)
  const [showCoinPnl, setShowCoinPnl] = useState(false)

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
    } catch (err) { console.error('[Trades] Failed to load trades:', err) } finally { setLoading(false) }
  }, [page, statusFilter])

  useEffect(() => { load() }, [load])

  // Poll live prices for open trades every 3 seconds
  // Auto-reload full trade data when status or closedPct changes (e.g. TP hit)
  useEffect(() => {
    const controller = new AbortController()
    async function fetchLive() {
      try {
        const data = await getTradeLivePrices(controller.signal)
        const map: Record<number, TradeLive> = {}
        data.forEach(d => { map[d.id] = d })
        setLivePrices(map)

        // Detect if any trade changed status/closedPct or disappeared from live (fully closed)
        const openStatuses = ['PENDING_ENTRY', 'OPEN', 'PARTIALLY_CLOSED']
        const changed = trades.some(t => {
          const live = map[t.id]
          if (!live) return openStatuses.includes(t.status) // was open but gone from live = closed
          return live.status !== t.status || (live.closedPct != null && live.closedPct !== t.closedPct)
        })
        if (changed) load()
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        console.error('[Trades] Failed to fetch live prices:', err)
      }
    }
    fetchLive()
    const interval = setInterval(fetchLive, 3000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [trades, load])

  async function exportCSV() {
    setExporting(true)
    try {
      const allTrades: Trade[] = []
      for (let p = 1; ; p++) {
        const res = await getTrades({ status: 'FINAL', page: p })
        allTrades.push(...res.data)
        if (p >= res.totalPages) break
      }
      const esc = (v: string) => `"${sanitizeCsvField(v).replace(/"/g, '""')}"`
      const bool = (b: boolean | null | undefined) => b ? 'Да' : 'Нет'
      const iso = (v: string | null | undefined) => v || ''
      const num = (v: number | null | undefined) => v == null ? '' : String(v)
      const money = (v: number | null | undefined) => v == null ? '' : fmt2(v)

      const closeCols = (i: number) => [
        `Закрытие ${i + 1} цена`, `Закрытие ${i + 1} %`, `Закрытие ${i + 1} P&L`,
        `Закрытие ${i + 1} P&L %`, `Закрытие ${i + 1} Fee`, `Закрытие ${i + 1} дата`, `Закрытие ${i + 1} SL?`,
      ]

      const header = [
        'ID', 'Монета', 'Тип', 'Плечо', 'Источник', 'Модель входа',
        'Цена входа', 'Тип ордера', 'Stop Loss (current)', 'Initial Stop', 'Current Stop',
        'TP1 цена', 'TP1 %', 'TP2 цена', 'TP2 %', 'TP3 цена', 'TP3 %',
        'Цена закрытия', 'Размер (маржа)', 'Размер (с плечом)', 'Closed %',
        'Реализовано P&L (gross)', 'Комиссии', 'Фандинг', 'P&L (net)', 'P&L %',
        'Статус', 'Exit Reason',
        'Создана', 'Открыта', 'Закрыта', 'Длительность', 'Time in trade (min)',
        'Stop moved to BE?', 'Причина перевода SL', 'Trailing активирован?', 'Trailing время',
        'TP1 время', 'TP2 время', 'TP3 время',
        'MFE %', 'MAE %',
        ...closeCols(0), ...closeCols(1), ...closeCols(2),
        'Σ(close.pnl)', 'Realized − Σ(close.pnl) (должно быть 0)',
        'Entry fee (implied)', 'Score', 'Заметки',
      ]

      const rows = allTrades.map(t => {
        const closes = t.closes || []
        const tps = t.takeProfits || []
        const cp = closes.length > 0 ? closes[closes.length - 1].price : null
        const fees = t.fees || 0
        const funding = t.fundingPaid || 0
        const netPnl = t.realizedPnl - fees - funding
        const pnlPct = t.amount > 0 ? (netPnl / t.amount) * 100 : 0
        const score = t.notes?.match(/Score:\s*(\d+)/)?.[1] || ''
        const dur = (() => {
          if (!t.closedAt || !t.openedAt) return ''
          const ms = new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()
          if (ms < 0) return ''
          const mins = Math.floor(ms / 60000), hours = Math.floor(mins / 60), days = Math.floor(hours / 24)
          return days > 0 ? `${days}д ${hours % 24}ч` : hours > 0 ? `${hours}ч ${mins % 60}м` : `${mins}м`
        })()
        const closeData = (i: number) => {
          const c = closes[i] as any
          return c
            ? [num(c.price), c.percent + '%', money(c.pnl), c.pnlPercent != null ? fmt2(c.pnlPercent) + '%' : '',
               c.fee != null ? String(c.fee) : '', iso(c.closedAt), bool(c.isSL)]
            : ['', '', '', '', '', '', '']
        }
        const sumClosesPnl = closes.reduce((s, c: any) => s + (c.pnl || 0), 0)
        const sumExitFees = closes.reduce((s, c: any) => s + (c.fee || 0), 0)
        const entryFeeImplied = Math.max(0, fees - sumExitFees)

        return [
          t.id, t.coin, t.type, t.leverage, t.source,
          t.notes?.match(/Model:\s*(\w+)/)?.[1] || '',
          t.entryPrice, t.entryOrderType, t.stopLoss,
          num(t.initialStop), num(t.currentStop),
          tps[0]?.price ?? '', tps[0]?.percent ? tps[0].percent + '%' : '',
          tps[1]?.price ?? '', tps[1]?.percent ? tps[1].percent + '%' : '',
          tps[2]?.price ?? '', tps[2]?.percent ? tps[2].percent + '%' : '',
          cp ?? '', fmt2(t.amount), fmt2(t.amount * t.leverage), fmt2(t.closedPct || 0) + '%',
          fmt2(t.realizedPnl), fmt2(fees), fmt2(funding), fmt2(netPnl), fmt2(pnlPct) + '%',
          t.status, t.exitReason || '',
          iso(t.createdAt), iso(t.openedAt), iso(t.closedAt), dur, num(t.timeInTradeMin),
          bool(t.stopMovedToBe), t.stopMoveReason || '', bool(t.trailingActivated), iso(t.trailingActivationTime),
          iso(t.tp1HitTimestamp), iso(t.tp2HitTimestamp), iso(t.tp3HitTimestamp),
          num(t.mfe), num(t.mae),
          ...closeData(0), ...closeData(1), ...closeData(2),
          fmt2(sumClosesPnl), fmt2(t.realizedPnl - sumClosesPnl),
          fmt2(entryFeeImplied), score, esc(t.notes || ''),
        ].map(v => typeof v === 'string' && v.startsWith('"') ? v : esc(String(v)))
      })

      const csv = '\uFEFF' + [header.map(h => esc(h)).join(';'), ...rows.map(r => r.join(';'))].join('\n')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: `trades_${new Date().toISOString().slice(0, 10)}.csv` })
      a.click(); URL.revokeObjectURL(url)
    } catch (err) { console.error('[Trades] CSV export error:', err) }
    finally { setExporting(false) }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-text-primary">Журнал сделок</h1>
        <div className="flex gap-2">
          {confirmCloseAll ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">Закрыть все по рынку?</span>
              <button onClick={async () => { setBulkLoading(true); try { await closeAllTrades(); load() } catch (err: any) { alert(err?.message || 'Failed to close all trades') } finally { setBulkLoading(false); setConfirmCloseAll(false) } }}
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
              <button onClick={async () => { setBulkLoading(true); try { await deleteAllTrades(); load() } catch (err: any) { alert(err?.message || 'Failed to delete all trades') } finally { setBulkLoading(false); setConfirmDeleteAll(false) } }}
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

      {/* Монеты P&L — collapsible */}
      {stats && Object.keys(stats.byCoin).length > 0 && (
        <div>
          <button
            onClick={() => setShowCoinPnl(v => !v)}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            <span className={`transition-transform ${showCoinPnl ? 'rotate-90' : ''}`}>▶</span>
            Монеты P&L ({Object.keys(stats.byCoin).length})
          </button>
          {showCoinPnl && (
            <div className="flex gap-1.5 flex-wrap mt-2">
              {Object.entries(stats.byCoin)
                .sort((a, b) => b[1].pnl - a[1].pnl)
                .map(([coin, d]) => (
                  <span key={coin} className="inline-flex items-center gap-1 bg-card rounded px-2 py-1 text-xs">
                    <span className="font-mono font-medium text-text-primary">{coin}</span>
                    <span className={`font-mono ${pnlColor(d.pnl)}`}>{fmt2Signed(d.pnl)}$</span>
                    <span className="text-text-secondary">({d.wins}/{d.trades})</span>
                  </span>
                ))}
            </div>
          )}
        </div>
      )}

      <TradesFilterBar
        statusFilter={statusFilter}
        onStatusChange={(s) => { setStatusFilter(s); setPage(1) }}
        minScore={minScore}
        onMinScoreChange={(n) => { setMinScore(n); setPage(1) }}
        isFinished={statusFilter === 'FINISHED'}
        exporting={exporting}
        onExport={exportCSV}
      />

      <TradesTable
        trades={trades.filter(t => {
          if (minScore <= 0) return true
          const m = t.notes?.match(/Score:\s*(\d+)/)
          if (!m) return true
          return Number(m[1]) >= minScore
        })}
        livePrices={livePrices}
        statusFilter={statusFilter}
        loading={loading}
        onSelectTrade={setSelected}
        onCloseTrade={setClosing}
        onCancelTrade={setCancelling}
        onChartTrade={setChartTrade}
      />

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Модалки */}
      {closing && <CloseModal trade={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); load() }} />}
      {selected && <TradeDetail trade={selected} onClose={() => setSelected(null)} onRefresh={load} currentPrice={livePrices[selected.id]?.currentPrice ?? undefined} />}
      {cancelling && (
        <CancelTradeModal
          trade={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); load() }}
        />
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
