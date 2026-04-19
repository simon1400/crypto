const statuses = ['ALL', 'PENDING_ENTRY', 'ACTIVE', 'FINISHED', 'CANCELLED']
const statusLabels: Record<string, string> = {
  ALL: 'Все', PENDING_ENTRY: 'Ожидание', ACTIVE: 'Открытые', FINISHED: 'Завершённые', CANCELLED: 'Отменённые',
}

interface TradesFilterBarProps {
  statusFilter: string
  onStatusChange: (s: string) => void
  isFinished: boolean
  exporting: boolean
  onExport: () => void
}

export default function TradesFilterBar({
  statusFilter, onStatusChange,
  isFinished, exporting, onExport,
}: TradesFilterBarProps) {
  return (
    <div className="flex gap-2 items-center flex-wrap">
      {statuses.map(s => (
        <button key={s} onClick={() => onStatusChange(s)}
          className={`px-3 py-1.5 rounded-lg text-sm transition ${
            statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'
          }`}>
          {statusLabels[s]}
        </button>
      ))}
      {isFinished && (
        <button onClick={onExport} disabled={exporting}
          className="ml-auto px-3 py-1.5 bg-card text-text-secondary rounded-lg text-xs font-medium hover:text-text-primary hover:bg-input transition disabled:opacity-50 flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          {exporting ? 'Экспорт...' : 'CSV'}
        </button>
      )}
    </div>
  )
}
