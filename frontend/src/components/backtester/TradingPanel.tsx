import { useState } from 'react'

interface ActiveOrder {
  type: 'LONG' | 'SHORT'
  entry: number
  sl: number
  tps: { price: number; percent: number }[]
  leverage: number
  amount: number
}

interface TradingPanelProps {
  replayMode: boolean
  activeOrder: ActiveOrder | null
  currentPnl: number
  onPlace: (
    type: 'LONG' | 'SHORT',
    entry: number,
    sl: number,
    tps: { price: number; percent: number }[],
    leverage: number,
    amount: number
  ) => void
  onCancel: () => void
  lastPrice: number
}

export default function TradingPanel({
  replayMode,
  activeOrder,
  currentPnl,
  onPlace,
  onCancel,
  lastPrice,
}: TradingPanelProps) {
  const [orderType, setOrderType] = useState<'LONG' | 'SHORT' | null>(null)
  const [entryPrice, setEntryPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [leverage, setLeverage] = useState('10')
  const [amount, setAmount] = useState('100')

  function handleOpenForm(type: 'LONG' | 'SHORT') {
    setOrderType(type)
    setEntryPrice(lastPrice > 0 ? String(lastPrice) : '')
    setStopLoss('')
    setTakeProfit('')
  }

  function handleCancel() {
    setOrderType(null)
    setEntryPrice('')
    setStopLoss('')
    setTakeProfit('')
  }

  function handleSubmit() {
    const entry = Number(entryPrice)
    const sl = Number(stopLoss)
    const tp = Number(takeProfit)
    const lev = Number(leverage) || 10
    const amt = Number(amount) || 100

    if (!entry || !sl || !tp || !orderType) return

    onPlace(
      orderType,
      entry,
      sl,
      [{ price: tp, percent: 100 }],
      lev,
      amt
    )
    setOrderType(null)
    setEntryPrice('')
    setStopLoss('')
    setTakeProfit('')
  }

  const pnlColor = currentPnl > 0 ? 'text-long' : currentPnl < 0 ? 'text-short' : 'text-text-secondary'

  // Not in replay mode — show disabled hint
  if (!replayMode) {
    return (
      <div className="bg-card rounded-xl p-4 mt-3 text-text-secondary text-sm text-center">
        Включите режим воспроизведения для торговли
      </div>
    )
  }

  // Active order — show position info
  if (activeOrder) {
    return (
      <div className="bg-card rounded-xl p-4 mt-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-text-secondary">Активная позиция</span>
          <span
            className={`px-2 py-0.5 rounded text-xs font-semibold ${
              activeOrder.type === 'LONG' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            }`}
          >
            {activeOrder.type}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm mb-3">
          <div>
            <div className="text-text-secondary text-xs">Вход</div>
            <div className="font-mono text-text-primary">${activeOrder.entry.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-text-secondary text-xs">SL</div>
            <div className="font-mono text-short">${activeOrder.sl.toFixed(2)}</div>
          </div>
          {activeOrder.tps.map((tp, i) => (
            <div key={i}>
              <div className="text-text-secondary text-xs">TP{i + 1}</div>
              <div className="font-mono text-long">${tp.price.toFixed(2)}</div>
            </div>
          ))}
          <div>
            <div className="text-text-secondary text-xs">Плечо</div>
            <div className="font-mono text-text-primary">{activeOrder.leverage}x</div>
          </div>
        </div>

        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-text-secondary">P&L</span>
          <span className={`font-mono font-semibold ${pnlColor}`}>
            {currentPnl >= 0 ? '+' : ''}{currentPnl.toFixed(2)} USDT
          </span>
        </div>

        <button
          onClick={onCancel}
          className="w-full py-2 bg-input text-text-secondary rounded-lg text-sm hover:text-text-primary hover:bg-card transition-colors border border-card"
        >
          Закрыть
        </button>
      </div>
    )
  }

  // Order form — opening LONG or SHORT
  if (orderType) {
    return (
      <div className="bg-card rounded-xl p-4 mt-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-text-primary">Новый ордер</span>
          <span
            className={`px-2 py-0.5 rounded text-xs font-semibold ${
              orderType === 'LONG' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'
            }`}
          >
            {orderType}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Вход</label>
            <input
              type="number"
              value={entryPrice}
              onChange={e => setEntryPrice(e.target.value)}
              className="w-full bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-accent"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Stop Loss</label>
            <input
              type="number"
              value={stopLoss}
              onChange={e => setStopLoss(e.target.value)}
              className="w-full bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-short"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Take Profit</label>
            <input
              type="number"
              value={takeProfit}
              onChange={e => setTakeProfit(e.target.value)}
              className="w-full bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-long"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Плечо</label>
            <input
              type="number"
              value={leverage}
              onChange={e => setLeverage(e.target.value)}
              className="w-full bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-accent"
              placeholder="10"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-text-secondary block mb-1">Размер (USDT)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-accent"
              placeholder="100"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleSubmit}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
              orderType === 'LONG'
                ? 'bg-long text-primary hover:bg-long/90'
                : 'bg-short text-primary hover:bg-short/90'
            }`}
          >
            Открыть
          </button>
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-input text-text-secondary rounded-lg text-sm hover:text-text-primary transition-colors"
          >
            Отмена
          </button>
        </div>
      </div>
    )
  }

  // Default: LONG/SHORT buttons
  return (
    <div className="bg-card rounded-xl p-4 mt-3">
      <div className="text-xs text-text-secondary mb-3">Виртуальная торговля</div>
      <div className="flex gap-2">
        <button
          onClick={() => handleOpenForm('LONG')}
          className="flex-1 py-2 bg-long text-primary rounded-lg text-sm font-semibold hover:bg-long/90 transition-colors"
        >
          LONG
        </button>
        <button
          onClick={() => handleOpenForm('SHORT')}
          className="flex-1 py-2 bg-short text-primary rounded-lg text-sm font-semibold hover:bg-short/90 transition-colors"
        >
          SHORT
        </button>
      </div>
    </div>
  )
}
