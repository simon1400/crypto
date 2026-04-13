import { useState } from 'react'
import { Signal } from '../../api/client'

interface SimTrade {
  date: string
  coin: string
  type: string
  leverage: number
  pnlPercent: number
  positionSize: number
  profit: number
  balanceBefore: number
  balanceAfter: number
}

function simulateDeposit(signals: Signal[], deposit: number, positionPct: number): {
  trades: SimTrade[]
  finalBalance: number
  totalProfit: number
  maxDrawdown: number
  peak: number
} {
  // Sort chronologically (oldest first)
  const sorted = [...signals]
    .filter(s => s.status === 'SL_HIT' || s.status.startsWith('TP'))
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime())

  let balance = deposit
  let peak = deposit
  let maxDrawdown = 0
  const trades: SimTrade[] = []

  for (const s of sorted) {
    const entry = (s.entryMin + s.entryMax) / 2
    let pnlPercent = 0

    if (s.status === 'SL_HIT') {
      pnlPercent = s.type === 'LONG'
        ? ((s.stopLoss - entry) / entry) * 100 * s.leverage
        : ((entry - s.stopLoss) / entry) * 100 * s.leverage
    } else {
      const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
      const tp = s.takeProfits[tpIdx]
      if (tp == null) continue
      pnlPercent = s.type === 'LONG'
        ? ((tp - entry) / entry) * 100 * s.leverage
        : ((entry - tp) / entry) * 100 * s.leverage
    }

    const positionSize = balance * (positionPct / 100)
    const profit = positionSize * (pnlPercent / 100)
    const balanceBefore = balance
    balance += profit

    if (balance > peak) peak = balance
    const drawdown = ((peak - balance) / peak) * 100
    if (drawdown > maxDrawdown) maxDrawdown = drawdown

    trades.push({
      date: new Date(s.publishedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      coin: s.coin,
      type: s.type,
      leverage: s.leverage,
      pnlPercent,
      positionSize,
      profit,
      balanceBefore,
      balanceAfter: balance,
    })
  }

  return { trades, finalBalance: balance, totalProfit: balance - deposit, maxDrawdown, peak }
}

export default function DepositSimulator({ signals }: { signals: Signal[] }) {
  const [deposit, setDeposit] = useState(100)
  const [positionPct, setPositionPct] = useState(10)
  const [showTrades, setShowTrades] = useState(false)

  const sim = simulateDeposit(signals, deposit, positionPct)
  const roi = ((sim.finalBalance - deposit) / deposit) * 100

  return (
    <div className="bg-card rounded-xl p-5 border border-card">
      <h3 className="text-lg font-semibold mb-4">Симулятор депозита</h3>

      {/* Inputs */}
      <div className="flex gap-4 mb-5">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Начальный депозит ($)</label>
          <input
            type="number"
            value={deposit}
            onChange={e => setDeposit(Math.max(1, Number(e.target.value)))}
            className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-32 font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Размер позиции (%)</label>
          <input
            type="number"
            value={positionPct}
            onChange={e => setPositionPct(Math.max(1, Math.min(100, Number(e.target.value))))}
            className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-32 font-mono"
          />
        </div>
      </div>

      {/* Results */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Финальный баланс</div>
          <div className={`font-mono text-xl font-bold ${roi >= 0 ? 'text-long' : 'text-short'}`}>
            ${sim.finalBalance.toFixed(2)}
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Прибыль</div>
          <div className={`font-mono text-xl font-bold ${sim.totalProfit >= 0 ? 'text-long' : 'text-short'}`}>
            {sim.totalProfit >= 0 ? '+' : ''}${sim.totalProfit.toFixed(2)}
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">ROI</div>
          <div className={`font-mono text-xl font-bold ${roi >= 0 ? 'text-long' : 'text-short'}`}>
            {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Макс. просадка</div>
          <div className="font-mono text-xl font-bold text-short">
            -{sim.maxDrawdown.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Trade log toggle */}
      <button
        onClick={() => setShowTrades(!showTrades)}
        className="text-sm text-accent hover:text-accent/80 transition-colors"
      >
        {showTrades ? '▾ Скрыть' : '▸ Показать'} историю сделок ({sim.trades.length})
      </button>

      {showTrades && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-secondary border-b border-card">
                <th className="text-left py-2 px-2">#</th>
                <th className="text-left py-2 px-2">Дата</th>
                <th className="text-left py-2 px-2">Монета</th>
                <th className="text-right py-2 px-2">Баланс до</th>
                <th className="text-right py-2 px-2">Позиция</th>
                <th className="text-right py-2 px-2">P&L</th>
                <th className="text-right py-2 px-2">Результат</th>
                <th className="text-right py-2 px-2">Баланс после</th>
              </tr>
            </thead>
            <tbody>
              {sim.trades.map((t, i) => (
                <tr key={i} className="border-b border-card/30">
                  <td className="py-2 px-2 text-text-secondary">{i + 1}</td>
                  <td className="py-2 px-2 text-text-secondary">{t.date}</td>
                  <td className="py-2 px-2">
                    <span className="font-mono font-bold text-text-primary">{t.coin}</span>
                    <span className={`ml-1 text-[10px] ${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                      {t.type} {t.leverage}x
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">
                    ${t.balanceBefore.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">
                    ${t.positionSize.toFixed(2)}
                  </td>
                  <td className={`py-2 px-2 text-right font-mono font-bold ${t.pnlPercent >= 0 ? 'text-long' : 'text-short'}`}>
                    {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%
                  </td>
                  <td className={`py-2 px-2 text-right font-mono font-bold ${t.profit >= 0 ? 'text-long' : 'text-short'}`}>
                    {t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono font-bold text-text-primary">
                    ${t.balanceAfter.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
