import { useState } from 'react'
import { updateTrade, deleteTrade, Trade, TradeTP, TradeClose } from '../../api/client'
import { formatDate, pnlColor } from '../../lib/formatters'
import { TradeStatusBadge } from '../StatusBadge'
import { useCoinSearch } from '../../hooks/useCoinSearch'

export default function TradeDetail({ trade, onClose, onRefresh }: { trade: Trade; onClose: () => void; onRefresh: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const editCoinSearch = useCoinSearch(trade.coin.replace('USDT', ''))
  const [eType, setEType] = useState(trade.type)
  const [eLeverage, setELeverage] = useState(String(trade.leverage))
  const [eEntry, setEEntry] = useState(String(trade.entryPrice))
  const [eAmount, setEAmount] = useState(String(trade.amount))
  const [eSL, setESL] = useState(String(trade.stopLoss))
  const [eTps, setETps] = useState<{ price: string; percent: string }[]>(
    (trade.takeProfits as TradeTP[]).map(tp => ({ price: String(tp.price), percent: String(tp.percent) }))
  )
  const [eFees, setEFees] = useState(String(trade.fees || ''))
  const [eNotes, setENotes] = useState(trade.notes || '')
  const [eError, setEError] = useState('')

  function addEditTP() { setETps([...eTps, { price: '', percent: '' }]) }
  function removeEditTP(i: number) { setETps(eTps.filter((_, idx) => idx !== i)) }
  function updateEditTP(i: number, field: 'price' | 'percent', value: string) {
    const copy = [...eTps]; copy[i] = { ...copy[i], [field]: value }; setETps(copy)
  }

  async function saveEdit() {
    setEError('')
    const takeProfits: TradeTP[] = eTps.filter(t => t.price && t.percent).map(t => ({ price: Number(t.price), percent: Number(t.percent) }))
    if (!takeProfits.length) { setEError('Добавьте хотя бы один TP'); return }
    const totalPct = takeProfits.reduce((s, t) => s + t.percent, 0)
    if (totalPct !== 100) { setEError(`Сумма % = ${totalPct}, нужно 100`); return }

    setSaving(true)
    try {
      await updateTrade(trade.id, {
        coin: editCoinSearch.getValue(),
        type: eType, leverage: Number(eLeverage),
        entryPrice: Number(eEntry), amount: Number(eAmount),
        stopLoss: Number(eSL), takeProfits, fees: eFees ? Number(eFees) : undefined, notes: eNotes,
      })
      setEditing(false)
      onRefresh()
    } catch (err: any) { setEError(err.message) } finally { setSaving(false) }
  }

  const tps = trade.takeProfits as TradeTP[]
  const closes = trade.closes as TradeClose[]
  const direction = trade.type === 'LONG' ? 1 : -1
  const slPct = Math.abs(((trade.stopLoss - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold text-text-primary font-mono">{trade.coin.replace('USDT', '')}</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.type === 'LONG' ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
              {trade.type} {trade.leverage}x
            </span>
            <TradeStatusBadge status={trade.status} />
          </div>
          <div className="flex items-center gap-2">
            {!editing && (
              <button onClick={() => setEditing(true)} className="text-text-secondary hover:text-accent text-sm">
                &#9998;
              </button>
            )}
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">&times;</button>
          </div>
        </div>

        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div ref={editCoinSearch.ref} className="relative">
                <label className="text-xs text-text-secondary">Монета</label>
                <input type="text" value={editCoinSearch.query}
                  onChange={e => editCoinSearch.setQuery(e.target.value)}
                  onFocus={() => editCoinSearch.setShowSuggestions(true)}
                  className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
                {editCoinSearch.showSuggestions && editCoinSearch.suggestions.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-input border border-card rounded-lg max-h-48 overflow-y-auto shadow-lg">
                    {editCoinSearch.suggestions.map(s => (
                      <button key={s} type="button"
                        onClick={() => editCoinSearch.select(s)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-card transition ${s === editCoinSearch.coin ? 'text-accent' : 'text-text-primary'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-text-secondary">Направление</label>
                <div className="flex gap-1 mt-1">
                  <button type="button" onClick={() => setEType('LONG')}
                    className={`flex-1 py-2 rounded font-medium text-xs ${eType === 'LONG' ? 'bg-long text-black' : 'bg-input text-text-secondary'}`}>LONG</button>
                  <button type="button" onClick={() => setEType('SHORT')}
                    className={`flex-1 py-2 rounded font-medium text-xs ${eType === 'SHORT' ? 'bg-short text-white' : 'bg-input text-text-secondary'}`}>SHORT</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary">Плечо</label>
                <input type="number" value={eLeverage} onChange={e => setELeverage(e.target.value)}
                  min="1" max="125" className="w-full bg-input rounded px-3 py-2 text-text-primary text-sm" />
              </div>
              <div>
                <label className="text-xs text-text-secondary">Размер</label>
                <input type="number" value={eAmount} onChange={e => setEAmount(e.target.value)}
                  step="0.01" className="w-full bg-input rounded px-3 py-2 text-text-primary text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-secondary">Цена входа</label>
                <input type="number" value={eEntry} onChange={e => setEEntry(e.target.value)}
                  step="any" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
              </div>
              <div>
                <label className="text-xs text-text-secondary">Stop Loss</label>
                <input type="number" value={eSL} onChange={e => setESL(e.target.value)}
                  step="any" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-text-secondary">Take Profits</label>
                <button type="button" onClick={addEditTP} className="text-xs text-accent hover:underline">+ TP</button>
              </div>
              {eTps.map((tp, i) => (
                <div key={i} className="flex gap-2 items-center mb-1">
                  <span className="text-xs text-text-secondary w-8">TP{i + 1}</span>
                  <input type="number" value={tp.price} onChange={e => updateEditTP(i, 'price', e.target.value)}
                    step="any" placeholder="Цена" className="flex-1 bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
                  <input type="number" value={tp.percent} onChange={e => updateEditTP(i, 'percent', e.target.value)}
                    min="1" max="100" placeholder="%" className="w-20 bg-input rounded px-3 py-2 text-text-primary text-sm" />
                  <span className="text-xs text-text-secondary">%</span>
                  {eTps.length > 1 && (
                    <button type="button" onClick={() => removeEditTP(i)} className="text-short text-sm">&times;</button>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-secondary">Комиссии USDT</label>
                <input type="number" value={eFees} onChange={e => setEFees(e.target.value)}
                  step="0.01" placeholder="0.00" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
              </div>
              <div>
                <label className="text-xs text-text-secondary">Заметки</label>
                <input type="text" value={eNotes} onChange={e => setENotes(e.target.value)}
                  className="w-full bg-input rounded px-3 py-2 text-text-primary text-sm" />
              </div>
            </div>

            {eError && <div className="text-short text-sm">{eError}</div>}

            <div className="flex gap-2">
              <button onClick={saveEdit} disabled={saving}
                className="flex-1 py-2 bg-accent text-black rounded-lg font-medium text-sm disabled:opacity-50">
                {saving ? 'Сохраняю...' : 'Сохранить'}
              </button>
              <button onClick={() => setEditing(false)}
                className="px-4 py-2 bg-input text-text-secondary rounded-lg text-sm">Отмена</button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="bg-input rounded-lg p-3">
                <div className="text-text-secondary text-xs">Вход</div>
                <div className="text-text-primary font-mono font-semibold">${trade.entryPrice}</div>
              </div>
              <div className="bg-input rounded-lg p-3">
                <div className="text-text-secondary text-xs">Stop Loss</div>
                <div className="text-short font-mono font-semibold">${trade.stopLoss}</div>
                <div className="text-short text-xs">-{slPct.toFixed(1)}%</div>
              </div>
              <div className="bg-input rounded-lg p-3">
                <div className="text-text-secondary text-xs">Размер</div>
                <div className="text-text-primary font-mono font-semibold">${trade.amount}</div>
              </div>
            </div>

            <div>
              <div className="text-xs text-text-secondary mb-2">Take Profits</div>
              <div className="space-y-1">
                {tps.map((tp, i) => {
                  const tpPct = ((tp.price - trade.entryPrice) * direction / trade.entryPrice) * 100 * trade.leverage
                  const hit = closes.find((c, ci) => ci === i && !c.isSL)
                  return (
                    <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${hit ? 'bg-long/5' : 'bg-input'}`}>
                      <span className="text-text-secondary">TP{i + 1}</span>
                      <span className="font-mono text-text-primary">${tp.price}</span>
                      <span className="text-long text-xs">+{tpPct.toFixed(1)}%</span>
                      <span className="text-text-secondary text-xs">{tp.percent}%</span>
                      {hit && <span className="text-long text-xs">&#10003;</span>}
                    </div>
                  )
                })}
              </div>
            </div>

            {closes.length > 0 && (
              <div>
                <div className="text-xs text-text-secondary mb-2">История закрытий</div>
                <div className="space-y-1">
                  {closes.map((c, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2 bg-input rounded-lg text-sm">
                      <span className="text-text-secondary text-xs">{formatDate(c.closedAt)}</span>
                      <span className="font-mono text-text-primary">${c.price}</span>
                      <span className="text-text-secondary">{c.percent}%</span>
                      <span className={`font-mono font-semibold ${pnlColor(c.pnl)}`}>
                        {c.pnl > 0 ? '+' : ''}{c.pnl}$
                      </span>
                      {c.isSL && <span className="text-short text-xs">SL</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-3 py-3 bg-input rounded-lg">
              <span className="text-text-secondary text-sm">Реализовано ({trade.closedPct}%)</span>
              <div className="text-right">
                <span className={`font-mono font-bold text-lg ${pnlColor(trade.realizedPnl - (trade.fees || 0))}`}>
                  {(trade.realizedPnl - (trade.fees || 0)) > 0 ? '+' : ''}{Math.round((trade.realizedPnl - (trade.fees || 0)) * 100) / 100}$
                </span>
                {trade.fees > 0 && (
                  <div className="text-xs text-text-secondary font-mono">
                    P&L: {trade.realizedPnl > 0 ? '+' : ''}{trade.realizedPnl}$ · Комиссии: -{trade.fees}$
                  </div>
                )}
              </div>
            </div>

            {trade.notes && (
              <div className="text-sm text-text-secondary bg-input rounded-lg p-3">
                <span className="text-xs text-text-secondary block mb-1">Заметки</span>
                {trade.notes}
              </div>
            )}

            <div className="text-xs text-text-secondary">
              Открыта: {formatDate(trade.openedAt)}
              {trade.closedAt && <> | Закрыта: {formatDate(trade.closedAt)}</>}
            </div>

            <div className="pt-2 border-t border-input">
              {!confirmDelete ? (
                <button onClick={() => setConfirmDelete(true)} className="text-xs text-text-secondary hover:text-short">
                  Удалить сделку
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-short">Точно удалить?</span>
                  <button onClick={async () => { await deleteTrade(trade.id); onClose(); onRefresh() }}
                    className="px-3 py-1 bg-short text-white rounded text-xs">Да</button>
                  <button onClick={() => setConfirmDelete(false)} className="px-3 py-1 bg-input text-text-secondary rounded text-xs">Нет</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
