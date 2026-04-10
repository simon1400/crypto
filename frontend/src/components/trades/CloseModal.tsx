import { useState, useEffect } from 'react'
import { closeTrade, hitStopLoss, getTradeLivePrices, Trade, TradeTP, TradeClose } from '../../api/client'
import { fmt2Signed } from '../../lib/formatters'

export default function CloseModal({ trade, onClose, onDone }: { trade: Trade; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState('')
  const [percent, setPercent] = useState(String(100 - trade.closedPct))
  const [loading, setLoading] = useState(false)
  const [marketPrice, setMarketPrice] = useState<number | null>(null)

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

  const previewPnl = price ? (() => {
    const dir = trade.type === 'LONG' ? 1 : -1
    const diff = (Number(price) - trade.entryPrice) * dir
    const pct = (diff / trade.entryPrice) * 100 * trade.leverage
    const portion = trade.amount * (Number(percent) / 100)
    return { usd: portion * (pct / 100), pct }
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

        {previewPnl && (
          <div className={`text-center font-mono font-bold ${previewPnl.usd >= 0 ? 'text-long' : 'text-short'}`}>
            {fmt2Signed(previewPnl.usd)}$ ({fmt2Signed(previewPnl.pct)}%)
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
