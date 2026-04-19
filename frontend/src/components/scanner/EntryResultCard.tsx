import { useState } from 'react'
import { takeEntry, EntryAnalysisSignal } from '../../api/client'
import { ScoreBadge } from '../StatusBadge'

export default function EntryResultCard({ result, balance, riskPct, savedId, savedStatus, savedDate, onDelete, onTaken }: {
  result: EntryAnalysisSignal
  balance: number
  riskPct: number
  savedId?: number
  savedStatus?: string
  savedDate?: string
  onDelete?: (id: number) => void
  onTaken?: () => void
}) {
  const isLong = result.type === 'LONG'
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [takeAmount, setTakeAmount] = useState('')
  const [takeLev, setTakeLev] = useState(result.leverage)
  const [taken, setTaken] = useState(savedStatus === 'TAKEN')

  const suggestedAmount = balance > 0 && result.slPercent > 0
    ? Math.round(balance * (riskPct / 100) / (result.slPercent / 100) / takeLev * 100) / 100
    : 0

  async function handleTake() {
    const amount = Number(takeAmount)
    if (amount <= 0) return
    try {
      const tpPercents = result.takeProfits.length <= 1 ? [100]
        : result.takeProfits.length === 2 ? [50, 50]
        : [40, 30, 30]
      await takeEntry({
        coin: result.coin,
        type: result.type,
        amount,
        leverage: takeLev,
        entry1: result.entry1.price,
        entry2: result.entry2.price,
        stopLoss: result.stopLoss,
        score: result.score,
        signalId: savedId,
        takeProfits: result.takeProfits.map((tp, i) => ({
          price: tp.price,
          percent: tpPercents[i] || 30,
        })),
      })
      setTaken(true)
      setShowTakeForm(false)
      onTaken?.()
    } catch (err: any) {
      alert(err.message || 'Не удалось взять сделку')
    }
  }

  return (
    <div className={`bg-card rounded-xl p-4 border ${taken ? 'border-long/30 opacity-70' : 'border-accent/20'} transition-colors`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{result.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {result.type}
          </span>
          <span className="px-2 py-0.5 rounded text-xs bg-accent/10 text-accent">Лимитный вход</span>
        </div>
        <div className="flex items-center gap-2">
          <ScoreBadge score={result.score} />
        </div>
      </div>

      {/* Current price */}
      <div className="text-xs text-text-secondary mb-3">
        Текущая цена: <span className="font-mono text-text-primary">${result.currentPrice}</span>
        <span className="ml-2">Режим: <span className="text-text-primary">{result.regime.regime}</span></span>
      </div>

      {/* Entry levels */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-input rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-secondary">{result.entry1.label} ({result.entry1.positionPercent}%)</span>
          </div>
          <div className={`font-mono font-bold text-lg ${isLong ? 'text-long' : 'text-short'}`}>${result.entry1.price}</div>
          <div className="text-[10px] text-text-secondary mt-1">
            −{result.entry1.distancePercent}% от цены · заполнение {result.entry1.fillProbability}%
          </div>
          <div className="text-[10px] text-text-secondary mt-0.5 truncate" title={result.entry1.sources.join(', ')}>
            {result.entry1.sources.slice(0, 3).join(', ')}{result.entry1.sources.length > 3 ? ` +${result.entry1.sources.length - 3}` : ''}
          </div>
        </div>
        <div className="bg-input rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-secondary">{result.entry2.label} ({result.entry2.positionPercent}%)</span>
          </div>
          <div className={`font-mono font-bold text-lg ${isLong ? 'text-long' : 'text-short'}`}>${result.entry2.price}</div>
          <div className="text-[10px] text-text-secondary mt-1">
            −{result.entry2.distancePercent}% от цены · заполнение {result.entry2.fillProbability}%
          </div>
          <div className="text-[10px] text-text-secondary mt-0.5 truncate" title={result.entry2.sources.join(', ')}>
            {result.entry2.sources.slice(0, 3).join(', ')}{result.entry2.sources.length > 3 ? ` +${result.entry2.sources.length - 3}` : ''}
          </div>
        </div>
      </div>

      {/* SL + TP grid */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">SL ({result.slPercent}%)</div>
          <div className="font-mono font-bold text-sm text-short">${result.stopLoss}</div>
        </div>
        {result.takeProfits.map((tp, i) => (
          <div key={i} className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
            <div className="font-mono font-bold text-sm text-long">${tp.price}</div>
          </div>
        ))}
      </div>

      {/* Info row */}
      <div className="flex gap-3 text-xs text-text-secondary mb-3">
        <span>Lev: <b className="text-text-primary">{result.leverage}x</b></span>
        <span>Pos: <b className="text-text-primary">{result.positionPct}%</b></span>
        <span>R:R: <b className="text-text-primary">1:{result.riskReward}</b></span>
        <span>Avg: <b className="font-mono text-text-primary">${result.avgEntry}</b></span>
      </div>

      {/* Reasons */}
      {result.reasons.length > 0 && (
        <div className="text-xs text-text-secondary space-y-0.5 mb-3">
          {result.reasons.slice(0, 4).map((r, i) => <div key={i}>• {r}</div>)}
        </div>
      )}

      {/* Take form */}
      {showTakeForm && !taken && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-[10px] text-text-secondary">Размер (USDT)</label>
              <input
                type="number"
                value={takeAmount}
                onChange={e => setTakeAmount(e.target.value)}
                placeholder={suggestedAmount > 0 ? String(suggestedAmount) : '0'}
                className="w-full bg-card text-text-primary rounded px-2 py-1 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-20">
              <label className="text-[10px] text-text-secondary">Leverage</label>
              <input
                type="number"
                value={takeLev}
                onChange={e => setTakeLev(Number(e.target.value) || 1)}
                className="w-full bg-card text-text-primary rounded px-2 py-1 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          <div className="text-[10px] text-text-secondary">
            Будет создано 2 сделки: {result.entry1.positionPercent}% на ${result.entry1.price} + {result.entry2.positionPercent}% на ${result.entry2.price}
          </div>
          <div className="flex gap-2">
            <button onClick={handleTake} className="px-3 py-1.5 rounded bg-accent/20 text-accent text-sm font-medium hover:bg-accent/30">Взять</button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 rounded bg-input text-text-secondary text-sm hover:text-text-primary">Отмена</button>
          </div>
        </div>
      )}

      {/* Date + status */}
      {savedDate && (
        <div className="text-[10px] text-text-secondary mb-2">
          {new Date(savedDate).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
          {savedStatus && savedStatus !== 'NEW' && <span className="ml-2 text-accent">{savedStatus}</span>}
        </div>
      )}

      {/* Action buttons */}
      {!taken && !showTakeForm && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-card">
          <button
            onClick={() => { setShowTakeForm(true); if (suggestedAmount > 0) setTakeAmount(String(suggestedAmount)) }}
            className="px-4 py-1.5 rounded-lg bg-accent/10 text-accent text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Взять
          </button>
          {savedId && onDelete && (
            <button
              onClick={() => onDelete(savedId)}
              className="px-2 py-1.5 rounded-lg text-text-secondary text-sm hover:text-short transition-colors"
              title="Удалить"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {taken && (
        <div className="flex items-center justify-between pt-2 border-t border-card">
          <span className="text-xs text-accent font-medium">Взят — создано 2 лимитных ордера в сделках</span>
          <button
            onClick={() => setTaken(false)}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Взять ещё раз
          </button>
        </div>
      )}
    </div>
  )
}
