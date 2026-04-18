import { formatDate } from '../../lib/formatters'
import { CardData, CardMode } from './types'

interface SignalCardActionsProps {
  data: CardData
  mode: CardMode
  showTakeForm: boolean
  onOpenTakeForm: () => void
  onOpenTakeFormReal: () => void
  onTakeSaved: () => void
  onSkipSaved: () => void
  onTakeScan: () => void
  onSkipScan: () => void
  onMarkSaved: () => void
  onDelete: () => void
}

export default function SignalCardActions({
  data, mode, showTakeForm, onOpenTakeForm, onOpenTakeFormReal,
  onSkipSaved, onSkipScan, onMarkSaved, onDelete,
}: SignalCardActionsProps) {
  return (
    <div className="flex items-center justify-between border-t border-card pt-2">
      <span className="text-xs text-text-secondary">
        {data.createdAt && formatDate(data.createdAt)}
        {data.takenAt && <span> · взят {formatDate(data.takenAt)}</span>}
      </span>

      <div className="flex gap-1">
        {/* Saved signal actions */}
        {mode === 'saved' && data.status === 'NEW' && !showTakeForm && (
          <>
            <button onClick={onOpenTakeForm} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20" title="Создать сделку в системе (демо)">Взять</button>
            <button onClick={onOpenTakeFormReal} className="px-2 py-1 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30" title="Создать реальную сделку на Bybit + демо">Взять (Bybit)</button>
            <button
              onClick={onMarkSaved}
              className="px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20"
              title="Пометить как взятый (торгую на бирже вручную)"
            >Отметить</button>
            <button onClick={onSkipSaved} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20" title="Пропустить (EXPIRED)">Пропустить</button>
          </>
        )}

        {/* Scan result actions */}
        {mode === 'scan' && data.id && (
          <>
            {data._taken ? (
              <span className="text-xs text-long font-medium">Взят — сделка создана</span>
            ) : data._skipped ? (
              <span className="text-xs text-neutral font-medium">Пропущен</span>
            ) : !showTakeForm ? (
              <>
                <button onClick={onOpenTakeForm} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20" title="Демо сделка">Взять</button>
                <button onClick={onOpenTakeFormReal} className="px-2 py-1 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30" title="Реальная сделка на Bybit + демо">Взять (Bybit)</button>
                <button onClick={onSkipScan} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20">Пропустить</button>
              </>
            ) : null}
          </>
        )}

        {/* Delete button (both modes) */}
        <button
          onClick={onDelete}
          className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
          title="Удалить"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
