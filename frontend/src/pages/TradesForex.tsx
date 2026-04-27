import { useState, useEffect, useCallback } from 'react'
import {
  getForexTrades,
  getForexTradesStats,
  closeForexTrade,
  slHitForexTrade,
  moveForexStop,
  cancelForexTrade,
  deleteForexTrade,
  updateForexTrade,
  type ForexTrade,
  type ForexTradeStats,
  type ForexTradeStatus,
} from '../api/client'

type Filter = 'ALL' | 'OPEN' | 'CLOSED' | 'SL_HIT' | 'CANCELLED'

export default function TradesForex() {
  const [trades, setTrades] = useState<ForexTrade[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [stats, setStats] = useState<ForexTradeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ForexTrade | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const statusParam = filter === 'ALL' ? undefined : filter
      const [list, s] = await Promise.all([
        getForexTrades(page, 20, { status: statusParam }),
        getForexTradesStats({}),
      ])
      setTrades(list.data)
      setTotal(list.total)
      setStats(s)
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [page, filter])

  useEffect(() => {
    load()
  }, [load])

  const refresh = () => load()

  const handleClose = async (trade: ForexTrade, price: number, percent: number) => {
    try {
      const upd = await closeForexTrade(trade.id, price, percent)
      setTrades((prev) => prev.map((t) => (t.id === upd.id ? upd : t)))
      if (selected?.id === upd.id) setSelected(upd)
      refresh()
    } catch (e: any) {
      alert(e.message || 'Ошибка закрытия')
    }
  }

  const handleSlHit = async (trade: ForexTrade) => {
    if (!confirm('Отметить SL?')) return
    try {
      const upd = await slHitForexTrade(trade.id)
      setTrades((prev) => prev.map((t) => (t.id === upd.id ? upd : t)))
      if (selected?.id === upd.id) setSelected(upd)
      refresh()
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  const handleMoveStop = async (trade: ForexTrade, newStop: number, reason?: string) => {
    try {
      const upd = await moveForexStop(trade.id, newStop, reason)
      setTrades((prev) => prev.map((t) => (t.id === upd.id ? upd : t)))
      if (selected?.id === upd.id) setSelected(upd)
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  const handleCancel = async (trade: ForexTrade) => {
    if (!confirm('Отменить сделку без P&L?')) return
    try {
      const upd = await cancelForexTrade(trade.id)
      setTrades((prev) => prev.map((t) => (t.id === upd.id ? upd : t)))
      if (selected?.id === upd.id) setSelected(upd)
      refresh()
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  const handleDelete = async (trade: ForexTrade) => {
    const isActive = trade.status === 'OPEN' || trade.status === 'PARTIALLY_CLOSED'
    const hasPnl = trade.realizedUsdPnl !== 0
    let msg = `Удалить сделку #${trade.id} (${trade.instrument} ${trade.type} ${trade.lots} лот)?`
    if (isActive) {
      msg += `\n\n⚠ Статус: ${trade.status}.`
    }
    if (hasPnl) {
      msg += `\n⚠ Реализованный P&L: ${trade.realizedUsdPnl >= 0 ? '+' : ''}$${trade.realizedUsdPnl.toFixed(2)} — будет вычеркнут из статистики.`
    }
    msg += `\n\nЗапись удалится из журнала. На MT5/Bybit это никак не повлияет.`
    if (!confirm(msg)) return
    try {
      await deleteForexTrade(trade.id)
      setTrades((prev) => prev.filter((t) => t.id !== trade.id))
      if (selected?.id === trade.id) setSelected(null)
      refresh()
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  const handleSaveNotes = async (trade: ForexTrade, notes: string) => {
    try {
      const upd = await updateForexTrade(trade.id, { notes })
      setTrades((prev) => prev.map((t) => (t.id === upd.id ? upd : t)))
      if (selected?.id === upd.id) setSelected(upd)
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Forex Trades</h1>
        <p className="text-xs text-text-secondary mt-1">
          Журнал форекс-сделок. P&L считается в пипсах и долларах через лоты и pipSize.
        </p>
      </div>

      {error && (
        <div className="bg-short/10 border border-short/30 text-short text-sm rounded p-3">{error}</div>
      )}

      {stats && <StatsCard stats={stats} />}

      <div className="flex items-center gap-2 flex-wrap">
        {(['ALL', 'OPEN', 'CLOSED', 'SL_HIT', 'CANCELLED'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f)
              setPage(1)
            }}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              filter === f ? 'bg-accent/20 text-accent' : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-text-secondary ml-2">Всего: {total}</span>
      </div>

      {loading ? (
        <p className="text-text-secondary text-sm">Загрузка...</p>
      ) : trades.length === 0 ? (
        <p className="text-text-secondary text-sm">Сделок нет.</p>
      ) : (
        <TradesTable trades={trades} onClick={(t) => setSelected(t)} />
      )}

      {selected && (
        <TradeModal
          trade={selected}
          onClose={() => setSelected(null)}
          onCloseTrade={handleClose}
          onSlHit={handleSlHit}
          onMoveStop={handleMoveStop}
          onCancel={handleCancel}
          onDelete={handleDelete}
          onSaveNotes={handleSaveNotes}
        />
      )}
    </div>
  )
}

// ===================== Helpers =====================

function formatPrice(instrument: string, v: number): string {
  if (/^US30|NAS100|SPX500|GER40|UK100/.test(instrument)) return v.toFixed(2)
  if (/JPY/.test(instrument)) return v.toFixed(3)
  if (/^XAU/.test(instrument)) return v.toFixed(2)
  if (/^XAG/.test(instrument)) return v.toFixed(3)
  return v.toFixed(5)
}

function statusColor(status: ForexTradeStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-accent/20 text-accent'
    case 'PARTIALLY_CLOSED':
      return 'bg-long/20 text-long'
    case 'CLOSED':
      return 'bg-neutral/20 text-neutral'
    case 'SL_HIT':
      return 'bg-short/20 text-short'
    case 'CANCELLED':
      return 'bg-neutral/20 text-neutral'
  }
}

function pnlColor(v: number): string {
  if (v > 0) return 'text-long'
  if (v < 0) return 'text-short'
  return 'text-text-secondary'
}

// ===================== Stats =====================

function StatsCard({ stats }: { stats: ForexTradeStats }) {
  return (
    <div className="bg-card rounded-lg p-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Сделок" value={String(stats.totalTrades)} />
        <Stat label="Win Rate" value={`${stats.winRate}%`} sub={`${stats.wins}W / ${stats.losses}L`} />
        <Stat
          label="P&L USD"
          value={`${stats.totalUsdPnl >= 0 ? '+' : ''}${stats.totalUsdPnl.toFixed(2)}$`}
          valueClass={pnlColor(stats.totalUsdPnl)}
        />
        <Stat
          label="P&L пипсы"
          value={`${stats.totalPipsPnl >= 0 ? '+' : ''}${stats.totalPipsPnl.toFixed(1)}`}
          valueClass={pnlColor(stats.totalPipsPnl)}
        />
        <Stat
          label="Лучший инструмент"
          value={
            Object.keys(stats.byInstrument).length
              ? Object.entries(stats.byInstrument).sort(
                  ([, a], [, b]) => b.usdPnl - a.usdPnl,
                )[0][0]
              : '—'
          }
        />
      </div>
    </div>
  )
}

function Stat({ label, value, sub, valueClass = '' }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div>
      <p className="text-[10px] text-text-secondary uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-mono font-semibold ${valueClass || 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-[10px] text-text-secondary">{sub}</p>}
    </div>
  )
}

// ===================== Table =====================

function TradesTable({ trades, onClick }: { trades: ForexTrade[]; onClick: (t: ForexTrade) => void }) {
  return (
    <div className="bg-card rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Дата</th>
              <th className="text-left px-3 py-2">Инструмент</th>
              <th className="text-left px-3 py-2">Тип</th>
              <th className="text-right px-3 py-2">Лоты</th>
              <th className="text-right px-3 py-2">Вход</th>
              <th className="text-right px-3 py-2">SL</th>
              <th className="text-right px-3 py-2">TP</th>
              <th className="text-right px-3 py-2">P&L (пипсы)</th>
              <th className="text-right px-3 py-2">P&L ($)</th>
              <th className="text-left px-3 py-2">Статус</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr
                key={t.id}
                onClick={() => onClick(t)}
                className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
              >
                <td className="px-3 py-2 text-text-secondary whitespace-nowrap">
                  {new Date(t.createdAt).toLocaleDateString('ru-RU')}
                </td>
                <td className="px-3 py-2 font-mono text-text-primary">{t.instrument}</td>
                <td className={`px-3 py-2 font-semibold ${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                  {t.type}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">{t.lots.toFixed(2)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">
                  {formatPrice(t.instrument, t.entryPrice)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-short">
                  {formatPrice(t.instrument, t.currentStop ?? t.stopLoss)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-long">
                  {(() => {
                    const tps = t.takeProfits as { price: number }[]
                    if (!tps?.length) return '—'
                    if (tps.length === 1) return formatPrice(t.instrument, tps[0].price)
                    // Старые multi-TP сделки (до варианта А) — показываем диапазон
                    return `${formatPrice(t.instrument, tps[0].price)}…${formatPrice(t.instrument, tps[tps.length - 1].price)}`
                  })()}
                </td>
                {/* P&L показываем только когда сделка реально что-то закрыла.
                    Для OPEN тут всегда 0 — система не подтягивает live-цену, юзер не должен думать что это unrealized. */}
                {t.status === 'OPEN' ? (
                  <>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">—</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">—</td>
                  </>
                ) : (
                  <>
                    <td className={`px-3 py-2 text-right font-mono ${pnlColor(t.realizedPipsPnl)}`}>
                      {t.realizedPipsPnl > 0 ? '+' : ''}
                      {t.realizedPipsPnl.toFixed(1)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${pnlColor(t.realizedUsdPnl)}`}>
                      {t.realizedUsdPnl > 0 ? '+' : ''}${t.realizedUsdPnl.toFixed(2)}
                    </td>
                  </>
                )}
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${statusColor(t.status)}`}>
                    {t.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ===================== Modal =====================

function TradeModal({
  trade,
  onClose,
  onCloseTrade,
  onSlHit,
  onMoveStop,
  onCancel,
  onDelete,
  onSaveNotes,
}: {
  trade: ForexTrade
  onClose: () => void
  onCloseTrade: (t: ForexTrade, price: number, percent: number) => void
  onSlHit: (t: ForexTrade) => void
  onMoveStop: (t: ForexTrade, newStop: number, reason?: string) => void
  onCancel: (t: ForexTrade) => void
  onDelete: (t: ForexTrade) => void
  onSaveNotes: (t: ForexTrade, notes: string) => void
}) {
  const [closePrice, setClosePrice] = useState('')
  const [closePct, setClosePct] = useState('50')
  const [newStop, setNewStop] = useState('')
  const [notes, setNotes] = useState(trade.notes ?? '')

  useEffect(() => {
    setNotes(trade.notes ?? '')
  }, [trade.id, trade.notes])

  const canClose = trade.status === 'OPEN' || trade.status === 'PARTIALLY_CLOSED'
  const remaining = 100 - trade.closedPct
  // Сделки из multi-take имеют один TP с percent=100. Для них нет смысла закрывать "часть":
  // вся позиция = одна нога MT5, либо закрыта целиком, либо по SL.
  const isSingleTp = (trade.takeProfits as { price: number; percent: number }[]).length === 1
  const tp1Price = (trade.takeProfits as { price: number }[])[0]?.price

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-primary border border-card rounded-lg p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              <span className="font-mono">{trade.instrument}</span>{' '}
              <span className={trade.type === 'LONG' ? 'text-long' : 'text-short'}>{trade.type}</span>
              <span className="text-sm text-text-secondary ml-2">{trade.lots.toFixed(2)} лот</span>
            </h2>
            <p className="text-xs text-text-secondary mt-1">
              Сделка #{trade.id} · {new Date(trade.createdAt).toLocaleString('ru-RU')}
              {trade.source === 'SCANNER' && trade.signalId && (
                <> · из сигнала #{trade.signalId}</>
              )}
              {trade.session && ` · ${trade.session}`}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 bg-card rounded p-3 text-sm">
          <span className="text-text-secondary">Вход</span>
          <span className="font-mono text-text-primary">{formatPrice(trade.instrument, trade.entryPrice)}</span>

          <span className="text-text-secondary">Stop Loss {trade.stopMovedToBe && <span className="text-[10px] text-accent">BE</span>}</span>
          <span className="font-mono text-short">
            {formatPrice(trade.instrument, trade.currentStop ?? trade.stopLoss)}
            {trade.initialStop != null && trade.currentStop !== trade.initialStop && (
              <span className="text-[10px] text-text-secondary ml-2">
                (был {formatPrice(trade.instrument, trade.initialStop)})
              </span>
            )}
          </span>

          {trade.takeProfits.map((tp, i) => (
            <div key={`tp-${i}`} className="contents">
              <span className="text-text-secondary">
                TP{i + 1} <span className="text-[10px]">({tp.percent}%)</span>
              </span>
              <span className="font-mono text-long">
                {formatPrice(trade.instrument, tp.price)}
                {tp.rr != null && <span className="text-[10px] text-text-secondary ml-2">R:R 1:{tp.rr}</span>}
              </span>
            </div>
          ))}

          <span className="text-text-secondary">Статус</span>
          <span>
            <span className={`px-2 py-0.5 text-xs font-semibold rounded ${statusColor(trade.status)}`}>
              {trade.status}
            </span>
            {trade.closedPct > 0 && (
              <span className="text-xs text-text-secondary ml-2">закрыто {trade.closedPct}%</span>
            )}
          </span>

          <span className="text-text-secondary">P&L</span>
          <span>
            <span className={`font-mono ${pnlColor(trade.realizedUsdPnl)}`}>
              {trade.realizedUsdPnl >= 0 ? '+' : ''}${trade.realizedUsdPnl.toFixed(2)}
            </span>
            <span className="text-xs text-text-secondary ml-2">
              ({trade.realizedPipsPnl >= 0 ? '+' : ''}
              {trade.realizedPipsPnl.toFixed(1)} пипс)
            </span>
          </span>

          {trade.timeInTradeMin != null && (
            <>
              <span className="text-text-secondary">В сделке</span>
              <span className="font-mono text-text-primary text-xs">
                {Math.floor(trade.timeInTradeMin / 60)}ч {trade.timeInTradeMin % 60}м
              </span>
            </>
          )}
        </div>

        {/* Actions */}
        {canClose && (
          <>
            <div className="bg-card rounded p-3 space-y-2">
              {isSingleTp ? (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-text-secondary">
                      Закрыть позицию ({trade.lots.toFixed(2)} лот)
                    </p>
                    {tp1Price != null && (
                      <button
                        type="button"
                        onClick={() => setClosePrice(String(tp1Price))}
                        className="text-[10px] text-accent hover:text-accent/80"
                      >
                        Подставить TP1 ({formatPrice(trade.instrument, tp1Price)})
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      type="number"
                      value={closePrice}
                      onChange={(e) => setClosePrice(e.target.value)}
                      placeholder="Цена закрытия"
                      className="bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
                    />
                    <button
                      onClick={() => {
                        const p = Number(closePrice)
                        if (!p) return alert('Введи цену закрытия')
                        onCloseTrade(trade, p, 100)
                        setClosePrice('')
                      }}
                      className="px-3 py-1.5 bg-long/20 text-long text-xs rounded hover:bg-long/30"
                    >
                      Закрыть всю
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-text-secondary">Закрыть часть (осталось {remaining}%)</p>
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="number"
                      value={closePrice}
                      onChange={(e) => setClosePrice(e.target.value)}
                      placeholder="Цена"
                      className="bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
                    />
                    <input
                      type="number"
                      value={closePct}
                      onChange={(e) => setClosePct(e.target.value)}
                      placeholder="% от позиции"
                      max={remaining}
                      className="bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
                    />
                    <button
                      onClick={() => {
                        const p = Number(closePrice)
                        const pct = Number(closePct)
                        if (!p || !pct) return alert('Нужны цена и %')
                        onCloseTrade(trade, p, pct)
                        setClosePrice('')
                      }}
                      className="px-3 py-1.5 bg-long/20 text-long text-xs rounded hover:bg-long/30"
                    >
                      Закрыть
                    </button>
                  </div>
                </>
              )}

              <div className="flex gap-2 flex-wrap pt-1 border-t border-input">
                <button
                  onClick={() => onSlHit(trade)}
                  className="px-3 py-1.5 bg-short/20 text-short text-xs rounded hover:bg-short/30"
                >
                  SL сработал
                </button>
                <button
                  onClick={() => onMoveStop(trade, trade.entryPrice, 'Moved to breakeven')}
                  className="px-3 py-1.5 bg-accent/20 text-accent text-xs rounded hover:bg-accent/30"
                >
                  SL → BE
                </button>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={newStop}
                    onChange={(e) => setNewStop(e.target.value)}
                    placeholder="Новый SL"
                    className="w-28 bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
                  />
                  <button
                    onClick={() => {
                      const v = Number(newStop)
                      if (!v) return
                      onMoveStop(trade, v, 'Manual move')
                      setNewStop('')
                    }}
                    className="px-3 py-1.5 bg-accent/20 text-accent text-xs rounded hover:bg-accent/30"
                  >
                    Сдвинуть
                  </button>
                </div>
                <button
                  onClick={() => onCancel(trade)}
                  className="px-3 py-1.5 bg-neutral/20 text-text-secondary text-xs rounded hover:bg-neutral/30"
                >
                  Отменить (без P&L)
                </button>
              </div>
            </div>
          </>
        )}

        {/* Closes history */}
        {trade.closes.length > 0 && (
          <div className="bg-card rounded p-3 text-xs space-y-1">
            <p className="text-text-secondary font-medium">История:</p>
            {trade.closes.map((c, i) => (
              <div key={i} className="grid grid-cols-5 gap-2 font-mono">
                <span className="text-text-secondary">{c.percent}%</span>
                <span>{formatPrice(trade.instrument, c.price)}</span>
                <span className={pnlColor(c.pipsPnl)}>
                  {c.pipsPnl >= 0 ? '+' : ''}
                  {c.pipsPnl.toFixed(1)} пипс
                </span>
                <span className={pnlColor(c.usdPnl)}>
                  {c.usdPnl >= 0 ? '+' : ''}${c.usdPnl.toFixed(2)}
                </span>
                <span className="text-[10px] text-text-secondary">
                  {c.isSL && '⚠️ SL '}
                  {new Date(c.closedAt).toLocaleString('ru-RU')}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Notes */}
        <div className="bg-card rounded p-3 space-y-2">
          <label className="text-xs text-text-secondary">Заметки</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Почему взял, что пошло не так, уроки..."
            className="w-full bg-input text-text-primary text-xs rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent"
          />
          {notes !== (trade.notes ?? '') && (
            <button
              onClick={() => onSaveNotes(trade, notes)}
              className="text-xs px-3 py-1 bg-accent/20 text-accent rounded hover:bg-accent/30"
            >
              Сохранить заметки
            </button>
          )}
        </div>

        <button
          onClick={() => onDelete(trade)}
          className="text-xs text-short hover:text-short/80"
        >
          Удалить сделку
        </button>
      </div>
    </div>
  )
}
