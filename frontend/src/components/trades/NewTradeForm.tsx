import { useState } from 'react'
import { createTrade, getSignalPrices, TradeTP } from '../../api/client'
import { useCoinSearch } from '../../hooks/useCoinSearch'

export default function NewTradeForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const coinSearch = useCoinSearch('BTC')
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
  const [fetchingPrice, setFetchingPrice] = useState(false)

  async function fetchMarketPrice() {
    const coin = coinSearch.getValue()
    if (!coin) return
    setFetchingPrice(true)
    try {
      const prices = await getSignalPrices([coin])
      const p = prices[coin]
      if (p) setEntryPrice(String(p))
    } catch {} finally { setFetchingPrice(false) }
  }

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
      await createTrade({
        coin: coinSearch.getValue(), type, leverage: Number(leverage),
        entryPrice: Number(entryPrice), amount: Number(amount),
        stopLoss: Number(stopLoss), takeProfits,
        fees: fees ? Number(fees) : undefined,
        notes: notes || undefined,
      })
      setOpen(false)
      coinSearch.reset('BTC'); setType('LONG'); setLeverage('10')
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
        <div ref={coinSearch.ref} className="relative">
          <label className="text-xs text-text-secondary">Монета</label>
          <input type="text" value={coinSearch.query}
            onChange={e => coinSearch.setQuery(e.target.value)}
            onFocus={() => coinSearch.setShowSuggestions(true)}
            placeholder="BTC, ETH, SOL..."
            className="w-full bg-input rounded px-3 py-2 text-text-primary font-mono" required />
          {coinSearch.showSuggestions && coinSearch.suggestions.length > 0 && (
            <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-input border border-card rounded-lg max-h-48 overflow-y-auto shadow-lg">
              {coinSearch.suggestions.map(s => (
                <button key={s} type="button"
                  onClick={() => coinSearch.select(s)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-card transition ${s === coinSearch.coin ? 'text-accent' : 'text-text-primary'}`}>
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
          <div className="flex items-center justify-between mb-0.5">
            <label className="text-xs text-text-secondary">Цена входа</label>
            <button type="button" onClick={fetchMarketPrice} disabled={fetchingPrice}
              className="text-xs text-accent hover:text-accent/80 transition disabled:opacity-50">
              {fetchingPrice ? '...' : 'По рынку'}
            </button>
          </div>
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
