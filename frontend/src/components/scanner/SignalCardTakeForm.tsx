import { useEffect, useState } from 'react'
import { fmt2 } from '../../lib/formatters'
import { getSignalPrices } from '../../api/client'
import { CardData, EntryModelData } from './types'

interface SignalCardTakeFormProps {
  data: CardData
  active: EntryModelData | undefined
  amount: string
  onAmountChange: (v: string) => void
  customLeverage: string
  onCustomLeverageChange: (v: string) => void
  orderType: 'market' | 'limit'
  onOrderTypeChange: (v: 'market' | 'limit') => void
  onConfirm: () => void
  onCancel: () => void
  loading: boolean
  balance: number
  riskPct?: number
  calcRiskAmount: (lev?: number) => string
}

// Real-risk sizing: amount = targetRisk / (realSlPct/100 × leverage)
function calcAmountForRealRisk(balance: number, riskPct: number, realSlPct: number, lev: number): number {
  if (!balance || !riskPct || !realSlPct || !lev) return 0
  return Math.floor((balance * riskPct / 100) / (realSlPct / 100 * lev))
}

export default function SignalCardTakeForm({
  data, active, amount, onAmountChange, customLeverage, onCustomLeverageChange,
  orderType, onOrderTypeChange, onConfirm, onCancel, loading, balance, riskPct, calcRiskAmount,
}: SignalCardTakeFormProps) {
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceLoading, setPriceLoading] = useState(false)

  // Fetch live price on mount and every 5s while form is open
  useEffect(() => {
    let cancelled = false
    async function fetchPrice() {
      setPriceLoading(true)
      try {
        const prices = await getSignalPrices([data.coin])
        if (!cancelled) {
          const p = prices[data.coin] ?? prices[data.coin.replace('USDT', '')] ?? null
          setLivePrice(p)
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setPriceLoading(false)
      }
    }
    fetchPrice()
    const id = setInterval(fetchPrice, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [data.coin])

  return (
    <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
      <div className="flex gap-3">
        <div className="flex-1">
          <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
          <input
            type="number"
            value={amount}
            onChange={e => onAmountChange(e.target.value)}
            placeholder="100"
            className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
          />
        </div>
        <div className="w-24">
          <div className="text-xs text-text-secondary mb-1">Leverage</div>
          <input
            type="number"
            value={customLeverage || (active?.leverage ?? data.leverage)}
            onChange={e => {
              onCustomLeverageChange(e.target.value)
              const calc = calcRiskAmount(Number(e.target.value) || undefined)
              if (calc) onAmountChange(calc)
            }}
            min={1} max={125}
            className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
          />
        </div>
      </div>
      {/* Order type toggle */}
      <div>
        <div className="text-xs text-text-secondary mb-1">Тип входа</div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onOrderTypeChange('market')}
            className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'market' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
            Market <span className="opacity-70">(taker)</span>
          </button>
          <button type="button" onClick={() => onOrderTypeChange('limit')}
            className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'limit' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
            Limit <span className="opacity-70">(maker)</span>
          </button>
        </div>
      </div>
      {amount && (() => {
        const lev = Number(customLeverage) || active?.leverage || data.leverage
        const signalSl = active?.slPercent || data.slPercent
        const signalEntry = active?.entry ?? data.entry
        const stopLoss = active?.stopLoss ?? data.stopLoss
        const isLong = (active?.type ?? data.type) === 'LONG'

        // Real (effective) entry — live price for market, signal entry for limit
        const realEntry = (orderType === 'market' && livePrice) ? livePrice : signalEntry
        const realSlPct = (realEntry && stopLoss)
          ? Math.abs((realEntry - stopLoss) / realEntry) * 100
          : signalSl

        // Drift: how far live price moved away from signal entry in unfavorable direction
        const drift = (livePrice && signalEntry)
          ? ((livePrice - signalEntry) / signalEntry) * 100 * (isLong ? 1 : -1)
          : 0

        const position = Number(amount) * lev
        const riskUsd = Number(amount) * (realSlPct / 100) * lev
        const riskPctOfBalance = balance > 0 ? (riskUsd / balance) * 100 : 0
        const targetRiskPct = riskPct ?? 2
        // Hard threshold: real risk overshoots target by more than 25%
        const overshoot = riskPctOfBalance > targetRiskPct * 1.25
        const slDriftPct = signalSl > 0 ? ((realSlPct - signalSl) / signalSl) * 100 : 0
        const feeRate = orderType === 'limit' ? 0.0002 : 0.00055
        const entryFee = position * feeRate

        // Sizing helper: recalc amount to keep risk at exactly targetRiskPct using realSlPct
        const recalcAmount = calcAmountForRealRisk(balance, targetRiskPct, realSlPct, lev)

        return (
          <div className="text-xs text-text-secondary space-y-1">
            <div>Позиция: <span className="text-text-primary font-mono">${position}</span></div>
            {livePrice && orderType === 'market' && (
              <div>
                Цена сейчас: <span className="text-text-primary font-mono">${livePrice}</span>
                {signalEntry && Math.abs(drift) >= 0.1 && (
                  <span className={`ml-1 ${drift > 0 ? 'text-short' : 'text-long'}`}>
                    ({drift > 0 ? '+' : ''}{drift.toFixed(2)}% от сигнала {isLong ? '▲' : '▼'})
                  </span>
                )}
              </div>
            )}
            <div>
              Реальный SL: <span className={overshoot ? 'text-short font-mono font-semibold' : 'text-text-primary font-mono'}>{realSlPct.toFixed(2)}%</span>
              {Math.abs(slDriftPct) >= 10 && (
                <span className="text-short ml-1">({slDriftPct > 0 ? '+' : ''}{slDriftPct.toFixed(0)}% vs сигнал {signalSl.toFixed(2)}%)</span>
              )}
            </div>
            <div>
              Риск: <span className={overshoot ? 'text-short font-mono font-semibold' : 'text-short font-mono'}>${fmt2(riskUsd)}</span>
              {balance > 0 && (
                <span className={`ml-1 ${overshoot ? 'text-short font-semibold' : ''}`}>
                  ({riskPctOfBalance.toFixed(2)}% от ${balance})
                </span>
              )}
            </div>
            <div>Entry fee: <span className="text-text-primary font-mono">${fmt2(entryFee)}</span> ({orderType})</div>
            {overshoot && recalcAmount > 0 && Number(amount) !== recalcAmount && (
              <div className="bg-short/10 border border-short/30 rounded p-2 mt-2 space-y-1">
                <div className="text-short font-semibold">
                  ⚠ Цена ушла, реальный риск {riskPctOfBalance.toFixed(2)}% &gt; целевые {targetRiskPct}%
                </div>
                <div className="text-text-secondary">
                  Чтобы остаться на {targetRiskPct}% от ${balance}, маржа должна быть{' '}
                  <button
                    type="button"
                    onClick={() => onAmountChange(String(recalcAmount))}
                    className="underline text-accent hover:text-accent/80 font-mono"
                  >
                    ${recalcAmount}
                  </button>
                </div>
              </div>
            )}
            {priceLoading && !livePrice && <div className="text-text-secondary">Загрузка актуальной цены...</div>}
          </div>
        )
      })()}
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={loading || !amount || (orderType === 'market' && !livePrice)}
          className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50"
          title={orderType === 'market' && !livePrice ? 'Ждём актуальную цену...' : ''}
        >
          {loading ? '...' : 'Подтвердить'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
      </div>
    </div>
  )
}
