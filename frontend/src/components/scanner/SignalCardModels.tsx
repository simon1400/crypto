import { fmtPrice } from '../../lib/formatters'
import { MODEL_LABELS } from './constants'
import { CardData, EntryModelData } from './types'

interface SignalCardModelsProps {
  models: EntryModelData[]
  selectedModel: number
  onSelectModel: (idx: number) => void
  data: CardData
  active: EntryModelData | undefined
  tps: { price: number; rr: number }[]
}

export default function SignalCardModels({ models, selectedModel, onSelectModel, data, active, tps }: SignalCardModelsProps) {
  return (
    <>
      {/* === Entry model selector === */}
      {models.length > 1 && (
        <div className="flex gap-1 mb-3">
          {models.map((model, idx) => (
            <button
              key={model.type}
              onClick={() => onSelectModel(idx)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                selectedModel === idx
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-input text-text-secondary border border-transparent hover:text-text-primary'
              }`}
            >
              {MODEL_LABELS[model.type] || model.type}
              {idx === 0 && ' ★'}
            </button>
          ))}
        </div>
      )}

      {/* === Key levels grid === */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход{active ? ` (${MODEL_LABELS[active.type] || active.type})` : ''}</div>
          <div className="font-mono font-bold text-accent">${fmtPrice(active?.entry ?? data.entry)}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Stop Loss{active ? ` (${active.slPercent}%)` : ''}</div>
          <div className="font-mono font-bold text-short">${fmtPrice(active?.stopLoss ?? data.stopLoss)}</div>
        </div>
        {tps.map((tp, i) => (
          <div key={i} className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
            <div className="font-mono font-bold text-long">${fmtPrice(tp.price)}</div>
          </div>
        ))}
      </div>
    </>
  )
}
