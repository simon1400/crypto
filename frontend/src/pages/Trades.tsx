import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getTrades, getTradeStats, createTrade, closeTrade, hitStopLoss, deleteTrade,
  updateTrade, searchSymbols, getTradeLivePrices, closeAllTrades, deleteAllTrades,
  Trade, TradeStats, TradeTP, TradeClose, TradeLive,
} from '../api/client'

function formatDate(d: string) {
  return new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function pnlColor(v: number) {
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : 'text-text-secondary'
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    PENDING_ENTRY: { bg: 'bg-purple-500/10', text: 'text-purple-400', label: 'Ожидание входа' },
    OPEN: { bg: 'bg-accent/10', text: 'text-accent', label: 'Открыта' },
    PARTIALLY_CLOSED: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Частично' },
    CLOSED: { bg: 'bg-long/10', text: 'text-long', label: 'Закрыта' },
    SL_HIT: { bg: 'bg-short/10', text: 'text-short', label: 'Стоп-лосс' },
    CANCELLED: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Отменена' },
  }
  const s = map[status] || map.CANCELLED
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>
}

// ===================== NEW TRADE FORM =====================
function NewTradeForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [coin, setCoin] = useState('BTC')
  const [coinQuery, setCoinQuery] = useState('BTC')
  const [coinSuggestions, setCoinSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const coinRef = useRef<HTMLDivElement>(null)
  const [type, setType] = useState<'LONG' | 'SHORT'>('LONG')
  const [leverage, setLeverage] = useState('10')
  const [entryPrice, setEntryPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [tps, setTps] = useState<{ price: string; percent: string }[]>([
    { price: '', percent: '50' },
    { price: '', percent: '50' },
  ])
  const [fees, setFees] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Поиск монет с биржи
  useEffect(() => {
    if (!coinQuery || coinQuery.length < 1) { setCoinSuggestions([]); return }
    const timer = setTimeout(async () => {
      const results = await searchSymbols(coinQuery.toUpperCase())
      setCoinSuggestions(results)
    }, 200)
    return () => clearTimeout(timer)
  }, [coinQuery])

  // Клик вне списка — закрыть
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (coinRef.current && !coinRef.current.contains(e.target as Node)) setShowSuggestions(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function addTP() {
    setTps([...tps, { price: '', percent: '' }])
  }
  function removeTP(i: number) {
    setTps(tps.filter((_, idx) => idx !== i))
  }
  function updateTP(i: number, field: 'price' | 'percent', value: string) {
    const copy = [...tps]
    copy[i] = { ...copy[i], [field]: value }
    setTps(copy)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const takeProfits: TradeTP[] = tps
      .filter(t => t.price && t.percent)
      .map(t => ({ price: Number(t.price), percent: Number(t.percent) }))

    if (!takeProfits.length) { setError('Добавьте хотя бы один Take Profit'); return }
    const totalPct = takeProfits.reduce((s, t) => s + t.percent, 0)
    if (totalPct !== 100) { setError(`Сумма % должна быть 100 (сейчас ${totalPct})`); return }

    setLoading(true)
    try {
      const finalCoin = coinQuery.toUpperCase() || coin
      await createTrade({
        coin: finalCoin, type, leverage: Number(leverage),
        entryPrice: Number(entryPrice), amount: Number(amount),
        stopLoss: Number(stopLoss), takeProfits,
        fees: fees ? Number(fees) : undefined,
        notes: notes || undefined,
      })
      setOpen(false)
      setCoin('BTC'); setCoinQuery('BTC'); setType('LONG'); setLeverage('10')
      setEntryPrice(''); setAmount(''); setStopLoss('')
      setTps([{ price: '', percent: '50' }, { price: '', percent: '50' }])
      setFees('')
      setNotes('')
      onCreated()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return open ? (
    <form onSubmit={submit} className="bg-card rounded-xl p-5 space-y-4 border border-card col-span-full">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-text-primary">Новая сделка</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-text-secondary hover:text-text-primary">&times;</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div ref={coinRef} className="relative">
          <label className="text-xs text-text-secondary">Монета</label>
          <input type="text" value={coinQuery}
            onChange={e => { setCoinQuery(e.target.value.toUpperCase()); setShowSuggestions(true) }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="BTC, ETH, SOL..."
            className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" required />
          {showSuggestions && coinSuggestions.length > 0 && (
            <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-input border border-card rounded-lg max-h-48 overflow-y-auto shadow-lg">
              {coinSuggestions.map(s => (
                <button key={s} type="button"
                  onClick={() => { setCoin(s); setCoinQuery(s); setShowSuggestions(false) }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-card transition ${s === coin ? 'text-accent' : 'text-text-primary'}`}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="text-xs text-text-secondary">Направление</label>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={() => setType('LONG')}
              className={`flex-1 py-2 rounded font-medium text-sm ${type === 'LONG' ? 'bg-long text-black' : 'bg-input text-text-secondary'}`}>
              LONG
            </button>
            <button type="button" onClick={() => setType('SHORT')}
              className={`flex-1 py-2 rounded font-medium text-sm ${type === 'SHORT' ? 'bg-short text-white' : 'bg-input text-text-secondary'}`}>
              SHORT
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs text-text-secondary">Плечо</label>
          <input type="number" value={leverage} onChange={e => setLeverage(e.target.value)}
            min="1" max="125" className="w-full bg-input rounded px-3 py-2 text-text-primary" />
        </div>
        <div>
          <label className="text-xs text-text-secondary">Размер (USDT)</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            step="0.01" placeholder="100" className="w-full bg-input rounded px-3 py-2 text-text-primary" required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-text-secondary">Цена входа</label>
          <input type="number" value={entryPrice} onChange={e => setEntryPrice(e.target.value)}
            step="any" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" required />
        </div>
        <div>
          <label className="text-xs text-text-secondary">Stop Loss</label>
          <input type="number" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
            step="any" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" required />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-text-secondary">Take Profits</label>
          <button type="button" onClick={addTP} className="text-xs text-accent hover:underline">+ Добавить TP</button>
        </div>
        <div className="space-y-2">
          {tps.map((tp, i) => (
            <div key={i} className="flex gap-2 items-center">
              <span className="text-xs text-text-secondary w-8">TP{i + 1}</span>
              <input type="number" value={tp.price} onChange={e => updateTP(i, 'price', e.target.value)}
                step="any" placeholder="Цена" className="flex-1 bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" required />
              <input type="number" value={tp.percent} onChange={e => updateTP(i, 'percent', e.target.value)}
                min="1" max="100" placeholder="%" className="w-20 bg-input rounded px-3 py-2 text-text-primary text-sm" required />
              <span className="text-xs text-text-secondary">%</span>
              {tps.length > 1 && (
                <button type="button" onClick={() => removeTP(i)} className="text-short text-sm hover:text-short/70">&times;</button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-text-secondary">Комиссии USDT (опционально)</label>
          <input type="number" value={fees} onChange={e => setFees(e.target.value)}
            step="0.01" placeholder="0.00" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" />
        </div>
        <div>
          <label className="text-xs text-text-secondary">Заметки (опционально)</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="" className="w-full bg-input rounded px-3 py-2 text-text-primary text-sm" />
        </div>
      </div>

      {error && <div className="text-short text-sm">{error}</div>}

      <button type="submit" disabled={loading}
        className="w-full py-2.5 bg-accent text-black rounded-lg font-medium hover:bg-accent/90 transition disabled:opacity-50">
        {loading ? 'Создаю...' : 'Записать сделку'}
      </button>
    </form>
  ) : (
    <button onClick={() => setOpen(true)}
      className="px-4 py-2 bg-accent text-black rounded-lg font-medium hover:bg-accent/90 transition">
      + Новая сделка
    </button>
  )
}

// ===================== CLOSE TRADE MODAL =====================
function CloseModal({ trade, onClose, onDone }: { trade: Trade; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState('')
  const [percent, setPercent] = useState(String(100 - trade.closedPct))
  const [loading, setLoading] = useState(false)
  const [marketPrice, setMarketPrice] = useState<number | null>(null)

  // Предзаполнить цену из следующего TP
  useEffect(() => {
    const nextTP = (trade.takeProfits as TradeTP[]).find((tp, i) => {
      const hitCount = (trade.closes as TradeClose[]).filter(c => !c.isSL).length
      return i >= hitCount
    })
    if (nextTP) {
      setPrice(String(nextTP.price))
      setPercent(String(Math.min(nextTP.percent, 100 - trade.closedPct)))
    }
  }, [trade])

  // Fetch market price
  useEffect(() => {
    async function fetchPrice() {
      const data = await getTradeLivePrices()
      const live = data.find(d => d.id === trade.id)
      if (live?.currentPrice) setMarketPrice(live.currentPrice)
    }
    fetchPrice()
    const interval = setInterval(fetchPrice, 3000)
    return () => clearInterval(interval)
  }, [trade.id])

  async function submit() {
    setLoading(true)
    try {
      await closeTrade(trade.id, Number(price), Number(percent))
      onDone()
    } catch { } finally { setLoading(false) }
  }

  async function doSL() {
    setLoading(true)
    try {
      await hitStopLoss(trade.id)
      onDone()
    } catch { } finally { setLoading(false) }
  }

  function setMarket() {
    if (marketPrice) setPrice(String(marketPrice))
  }

  const remaining = 100 - trade.closedPct

  // Preview P&L
  const previewPnl = price ? (() => {
    const dir = trade.type === 'LONG' ? 1 : -1
    const diff = (Number(price) - trade.entryPrice) * dir
    const pct = (diff / trade.entryPrice) * 100 * trade.leverage
    const portion = trade.amount * (Number(percent) / 100)
    return { usd: Math.round(portion * (pct / 100) * 100) / 100, pct: Math.round(pct * 100) / 100 }
  })() : null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl p-5 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text-primary">
          Закрыть {trade.coin.replace('USDT', '')} — {remaining}% осталось
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-secondary">Цена закрытия</label>
            <input type="number" value={price} onChange={e => setPrice(e.target.value)}
              step="any" className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" />
          </div>
          <div>
            <label className="text-xs text-text-secondary">% позиции</label>
            <input type="number" value={percent} onChange={e => setPercent(e.target.value)}
              min="1" max={remaining} className="w-full bg-input rounded px-3 py-2 text-text-primary" />
          </div>
        </div>

        {/* Быстрые кнопки: рыночная цена */}
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={setMarket}
            className={`px-3 py-1 rounded text-xs font-medium transition ${marketPrice ? 'bg-accent/15 text-accent hover:bg-accent/25' : 'bg-input text-text-secondary opacity-50'}`}>
            По рынку{marketPrice ? `: $${marketPrice}` : ''}
          </button>
          {(trade.takeProfits as TradeTP[]).map((tp, i) => (
            <button key={i} type="button"
              onClick={() => { setPrice(String(tp.price)); setPercent(String(Math.min(tp.percent, remaining))) }}
              className="px-3 py-1 bg-input rounded text-xs text-text-secondary hover:text-accent transition">
              TP{i + 1}: ${tp.price}
            </button>
          ))}
        </div>

        {/* Быстрые кнопки % */}
        <div className="flex gap-2">
          {[25, 50, 75, 100].map(p => {
            const val = Math.min(p, remaining)
            return (
              <button key={p} type="button" onClick={() => setPercent(String(val))}
                className={`flex-1 py-1 rounded text-xs transition ${Number(percent) === val ? 'bg-accent/15 text-accent' : 'bg-input text-text-secondary hover:text-text-primary'}`}>
                {p}%
              </button>
            )
          })}
        </div>

        {/* P&L preview */}
        {previewPnl && (
          <div className={`text-center font-mono font-bold ${previewPnl.usd >= 0 ? 'text-long' : 'text-short'}`}>
            {previewPnl.usd >= 0 ? '+' : ''}{previewPnl.usd}$ ({previewPnl.pct >= 0 ? '+' : ''}{previewPnl.pct}%)
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={submit} disabled={loading || !price || !percent}
            className="flex-1 py-2 bg-long text-black rounded-lg font-medium disabled:opacity-50">
            Зафиксировать
          </button>
          <button onClick={doSL} disabled={loading}
            className="px-4 py-2 bg-short text-white rounded-lg font-medium disabled:opacity-50">
            SL Hit
          </button>
        </div>
      </div>
    </div>
  )
}

// ===================== TRADE DETAIL MODAL =====================
function TradeDetail({ trade, onClose, onRefresh }: { trade: Trade; onClose: () => void; onRefresh: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  // Editable fields
  const [eCoin, setECoin] = useState(trade.coin.replace('USDT', ''))
  const [eCoinQuery, setECoinQuery] = useState(trade.coin.replace('USDT', ''))
  const [eCoinSuggestions, setECoinSuggestions] = useState<string[]>([])
  const [eShowSuggestions, setEShowSuggestions] = useState(false)
  const eCoinRef = useRef<HTMLDivElement>(null)
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

  // Coin search for edit mode
  useEffect(() => {
    if (!editing || !eCoinQuery || eCoinQuery.length < 1) { setECoinSuggestions([]); return }
    const timer = setTimeout(async () => {
      const results = await searchSymbols(eCoinQuery.toUpperCase())
      setECoinSuggestions(results)
    }, 200)
    return () => clearTimeout(timer)
  }, [eCoinQuery, editing])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (eCoinRef.current && !eCoinRef.current.contains(e.target as Node)) setEShowSuggestions(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

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
        coin: (eCoinQuery || eCoin).toUpperCase(),
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
            {statusBadge(trade.status)}
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
          /* ===== EDIT MODE ===== */
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div ref={eCoinRef} className="relative">
                <label className="text-xs text-text-secondary">Монета</label>
                <input type="text" value={eCoinQuery}
                  onChange={e => { setECoinQuery(e.target.value.toUpperCase()); setEShowSuggestions(true) }}
                  onFocus={() => setEShowSuggestions(true)}
                  className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono text-sm" />
                {eShowSuggestions && eCoinSuggestions.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-input border border-card rounded-lg max-h-48 overflow-y-auto shadow-lg">
                    {eCoinSuggestions.map(s => (
                      <button key={s} type="button"
                        onClick={() => { setECoin(s); setECoinQuery(s); setEShowSuggestions(false) }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-card transition ${s === eCoin ? 'text-accent' : 'text-text-primary'}`}>
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
          /* ===== VIEW MODE ===== */
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

            {/* Take Profit уровни */}
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

            {/* История закрытий */}
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

            {/* Итого */}
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

            {/* Удаление */}
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

// ===================== STATS PANEL =====================
function StatsPanel({ stats, livePrices }: { stats: TradeStats | null; livePrices: Record<number, TradeLive> }) {
  if (!stats) return null

  const unrealizedTotal = Math.round(Object.values(livePrices).reduce((sum, lp) => sum + lp.unrealizedPnl, 0) * 100) / 100
  const totalPnl = Math.round((stats.totalPnl + unrealizedTotal) * 100) / 100

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Всего</div>
        <div className="text-2xl font-bold text-text-primary">{stats.total}</div>
        <div className="text-xs text-text-secondary">{stats.open} открытых</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Win Rate</div>
        <div className={`text-2xl font-bold ${stats.winRate >= 50 ? 'text-long' : 'text-short'}`}>{stats.winRate}%</div>
        <div className="text-xs text-text-secondary">{stats.wins}W / {stats.losses}L</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Общий P&L</div>
        <div className={`text-2xl font-bold font-mono ${pnlColor(totalPnl)}`}>
          {totalPnl > 0 ? '+' : ''}{totalPnl}$
        </div>
        {unrealizedTotal !== 0 && (
          <div className={`text-xs font-mono ${pnlColor(unrealizedTotal)}`}>
            unrealized: {unrealizedTotal > 0 ? '+' : ''}{unrealizedTotal}$
          </div>
        )}
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">Средний Win</div>
        <div className="text-lg font-bold font-mono text-long">+{stats.avgWin}$</div>
        <div className="text-xs text-text-secondary">Avg Loss: {stats.avgLoss}$</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">LONG</div>
        <div className={`text-lg font-bold font-mono ${pnlColor(stats.longStats.pnl)}`}>
          {stats.longStats.pnl > 0 ? '+' : ''}{stats.longStats.pnl}$
        </div>
        <div className="text-xs text-text-secondary">{stats.longStats.count} сделок</div>
      </div>
      <div className="bg-card rounded-xl p-4">
        <div className="text-xs text-text-secondary">SHORT</div>
        <div className={`text-lg font-bold font-mono ${pnlColor(stats.shortStats.pnl)}`}>
          {stats.shortStats.pnl > 0 ? '+' : ''}{stats.shortStats.pnl}$
        </div>
        <div className="text-xs text-text-secondary">{stats.shortStats.count} сделок</div>
      </div>
    </div>
  )
}

// ===================== MAIN PAGE =====================
export default function Trades() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [stats, setStats] = useState<TradeStats | null>(null)
  const [livePrices, setLivePrices] = useState<Record<number, TradeLive>>({})
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [statusFilter, setStatusFilter] = useState('ALL')
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

  // Poll live prices for open trades every 15 seconds
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

  const statuses = ['ALL', 'PENDING_ENTRY', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSED', 'SL_HIT']
  const statusLabels: Record<string, string> = {
    ALL: 'Все', PENDING_ENTRY: 'Ожидание', OPEN: 'Открытые', PARTIALLY_CLOSED: 'Частичные', CLOSED: 'Закрытые', SL_HIT: 'Стоп-лосс',
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
              <col className="w-[120px]" />
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
                      {t.source === 'SCALP' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-400" title="Скальп-сканер">S</span>}
                      {t.source === 'SCANNER' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Свинг-сканер">W</span>}
                      {t.source === 'SIGNAL' && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-400" title="Telegram-сигнал">T</span>}
                       
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
                    <span className="text-text-primary">${t.amount}</span>
                    {t.leverage > 1 && (
                      <div className="text-xs text-text-secondary">${t.amount * t.leverage}</div>
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
                  <td className="py-3 px-2 text-center">{statusBadge(t.status)}</td>
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
