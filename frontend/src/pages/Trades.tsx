import { useState, useEffect, useCallback } from 'react'
import {
  getTrades, getTradeStats, getTradeLivePrices, closeAllTrades, deleteAllTrades,
  Trade, TradeStats, TradeLive,
} from '../api/client'
import { formatDate, pnlColor } from '../lib/formatters'
import { TradeStatusBadge } from '../components/StatusBadge'
import NewTradeForm from '../components/trades/NewTradeForm'
import CloseModal from '../components/trades/CloseModal'
import TradeDetail from '../components/trades/TradeDetail'
import StatsPanel from '../components/trades/StatsPanel'

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

  const statuses = ['ALL', 'PENDING_ENTRY', 'ACTIVE', 'FINISHED']
  const statusLabels: Record<string, string> = {
    ALL: 'Все', PENDING_ENTRY: 'Ожидание', ACTIVE: 'Открытые', FINISHED: 'Завершённые',
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
                <span className={`ml-2 font-mono ${pnlColor(d.pnl)}`}>{d.pnl > 0 ? '+' : ''}{d.pnl}$</span>
                <span className="ml-1 text-text-secondary text-xs">({d.wins}/{d.trades})</span>
              </div>
            ))}
        </div>
      )}

      {/* Фильтры */}
      <div className="flex gap-2">
        {statuses.map(s => (
          <button key={s} onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm transition ${
              statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'
            }`}>
            {statusLabels[s]}
          </button>
        ))}
      </div>

      {/* Таблица */}
      {loading ? (
        <div className="text-center py-12 text-text-secondary">Загрузка...</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">Нет сделок</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[85px]" />
              <col className="w-[130px]" />
              <col className="w-[60px]" />
              <col className="w-[60px]" />
              <col className="w-[60px]" />
              <col className="w-[70px]" />
              <col className="w-[70px]" />
              <col className="w-[55px]" />
              <col className="w-[55px]" />
              <col className="w-[100px]" />
              <col className="w-[100px]" />
              <col className="w-[30px]" />
            </colgroup>
            <thead>
              <tr className="text-text-secondary text-xs border-b border-input">
                <th className="text-left py-3 px-2">Дата</th>
                <th className="text-left py-3 px-2">Монета</th>
                <th className="text-right py-3 px-2">Вход</th>
                <th className="text-right py-3 px-2">Цена</th>
                <th className="text-right py-3 px-2">Размер</th>
                <th className="text-right py-3 px-2">SL</th>
                <th className="text-right py-3 px-2">TP</th>
                <th className="text-center py-3 px-2">Закрыто</th>
                <th className="text-right py-3 px-2">Рлз.</th>
                <th className="text-right py-3 px-2">P&L</th>
                <th className="text-center py-3 px-2">Статус</th>
                <th className="text-right py-3 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {[...trades].sort((a, b) => {
                const scoreA = Number(a.notes?.match(/Score:\s*(\d+)/)?.[1] || 0)
                const scoreB = Number(b.notes?.match(/Score:\s*(\d+)/)?.[1] || 0)
                return scoreB - scoreA
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

                      <a
                        href={`https://www.tradingview.com/chart/?symbol=BYBIT:${t.coin}.P`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="text-text-secondary hover:text-accent transition-colors"
                        title="TradingView"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
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
                    <span className="text-text-primary">${Math.round(t.amount * 100) / 100}</span>
                    {t.leverage > 1 && (
                      <div className="text-xs text-text-secondary">${Math.round(t.amount * t.leverage * 100) / 100}</div>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right font-mono">
                    {(() => {
                      const dir = t.type === 'LONG' ? 1 : -1
                      const diff = (t.stopLoss - t.entryPrice) * dir
                      const pct = (diff / t.entryPrice) * 100 * t.leverage
                      const remaining = t.amount * ((100 - t.closedPct) / 100)
                      const loss = Math.round(remaining * (pct / 100) * 100) / 100
                      const pctR = Math.round(pct * 100) / 100
                      return (
                        <span title={`${loss}$ (${pctR}%)`} className="cursor-help">
                          <span className="text-short">${t.stopLoss}</span>
                          <div className="text-xs text-short/70">{pctR}%</div>
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
                      const profit = Math.round(remaining * (pct / 100) * 100) / 100
                      const pctR = Math.round(pct * 100) / 100
                      return (
                        <span title={`+${profit}$ (+${pctR}%)`} className="cursor-help">
                          <span className="text-long">${maxTp.price}</span>
                          <div className="text-xs text-long/70">+{pctR}%</div>
                        </span>
                      )
                    })()}
                  </td>

                  <td className="py-3 px-2 text-center text-text-secondary">{t.closedPct}%</td>
                  <td className="py-3 px-2 text-right font-mono text-sm">
                    {t.closedPct > 0 && t.closedPct < 100 ? (
                      <span className={pnlColor(t.realizedPnl - (t.fees || 0))}>
                        {(t.realizedPnl - (t.fees || 0)) > 0 ? '+' : ''}{Math.round((t.realizedPnl - (t.fees || 0)) * 100) / 100}$
                      </span>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right font-mono font-semibold">
                    {(t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED') && livePrices[t.id] ? (
                      <span className={pnlColor(livePrices[t.id].unrealizedPnl)}>
                        {livePrices[t.id].unrealizedPnl > 0 ? '+' : ''}{livePrices[t.id].unrealizedPnl}$
                        <span className="text-xs ml-1 opacity-70">
                          ({livePrices[t.id].unrealizedPnlPct > 0 ? '+' : ''}{livePrices[t.id].unrealizedPnlPct}%)
                        </span>
                      </span>
                    ) : (
                      <span className={pnlColor(t.realizedPnl - (t.fees || 0))}>
                        {(t.realizedPnl - (t.fees || 0)) > 0 ? '+' : ''}{Math.round((t.realizedPnl - (t.fees || 0)) * 100) / 100}$
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-2 text-center"><TradeStatusBadge status={t.status} /></td>
                  <td className="py-3 px-2 text-right">
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
      {selected && <TradeDetail trade={selected} onClose={() => setSelected(null)} onRefresh={load} />}
    </div>
  )
}
