import { fmt2 } from '../../lib/formatters'
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
  calcRiskAmount: (lev?: number) => string
}

export default function SignalCardTakeForm({
  data, active, amount, onAmountChange, customLeverage, onCustomLeverageChange,
  orderType, onOrderTypeChange, onConfirm, onCancel, loading, balance, calcRiskAmount,
}: SignalCardTakeFormProps) {
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
        const sl = active?.slPercent || data.slPercent
        const position = Number(amount) * lev
        const riskUsd = Number(amount) * (sl / 100) * lev
        const feeRate = orderType === 'limit' ? 0.0002 : 0.00055
        const entryFee = position * feeRate
        return (
          <div className="text-xs text-text-secondary space-y-0.5">
            <div>Позиция: <span className="text-text-primary font-mono">${position}</span></div>
            <div>Риск: <span className="text-short font-mono">${fmt2(riskUsd)}</span>
              {balance > 0 && <span className="ml-1">({(riskUsd / balance * 100).toFixed(2)}% депо)</span>}
            </div>
            <div>Entry fee: <span className="text-text-primary font-mono">${fmt2(entryFee)}</span> ({orderType})</div>
          </div>
        )
      })()}
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={loading || !amount}
          className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50"
        >
          {loading ? '...' : 'Подтвердить'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
      </div>
    </div>
  )
}
