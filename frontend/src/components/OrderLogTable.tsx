import { OrderLogEntry } from '../api/client'
import { formatDate } from '../lib/formatters'

export interface LogFilters {
  action?: string
  signalId?: number
  dateFrom?: string
  dateTo?: string
}

interface Props {
  logs: OrderLogEntry[]
  total: number
  page: number
  totalPages: number
  onPageChange: (p: number) => void
  filters: LogFilters
  onFiltersChange: (f: LogFilters) => void
}

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'ORDER_PLACED', label: 'ORDER_PLACED' },
  { value: 'ORDER_FILLED', label: 'ORDER_FILLED' },
  { value: 'ORDER_CANCELLED', label: 'ORDER_CANCELLED' },
  { value: 'SL_TRIGGERED', label: 'SL_TRIGGERED' },
  { value: 'TP1_HIT', label: 'TP1_HIT' },
  { value: 'TP2_HIT', label: 'TP2_HIT' },
  { value: 'TP3_HIT', label: 'TP3_HIT' },
  { value: 'TP4_HIT', label: 'TP4_HIT' },
  { value: 'TP5_HIT', label: 'TP5_HIT' },
  { value: 'POSITION_CLOSED', label: 'POSITION_CLOSED' },
  { value: 'KILL_SWITCH', label: 'KILL_SWITCH' },
  { value: 'ERROR', label: 'ERROR' },
]

function actionBadgeColor(action: string): string {
  if (action.startsWith('TP') || action === 'ORDER_FILLED') return 'text-long bg-long/10'
  if (action === 'SL_TRIGGERED' || action === 'KILL_SWITCH' || action === 'ERROR') return 'text-short bg-short/10'
  if (action === 'ORDER_CANCELLED') return 'text-accent bg-accent/10'
  return 'text-text-secondary bg-input'
}

function extractCoin(log: OrderLogEntry): string {
  const d = log.details
  if (!d) return '-'
  if (d.symbol) return d.symbol.replace('USDT', '')
  return '-'
}

function extractSide(log: OrderLogEntry): string | null {
  const d = log.details
  if (!d?.side) return null
  return d.side === 'Buy' ? 'LONG' : 'SHORT'
}

function extractPrice(log: OrderLogEntry): string {
  const d = log.details
  if (!d?.price) return '-'
  const p = parseFloat(String(d.price))
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function extractQty(log: OrderLogEntry): string {
  const d = log.details
  if (!d?.qty) return '-'
  return String(d.qty)
}

function extractPnl(log: OrderLogEntry): { value: number; display: string } | null {
  const d = log.details
  const pnl = d?.pnl
  if (pnl === undefined || pnl === null) return null
  if (typeof pnl !== 'number') return null
  const prefix = pnl >= 0 ? '+' : ''
  return { value: pnl, display: `${prefix}$${Math.abs(pnl).toFixed(2)}` }
}

export default function OrderLogTable({
  logs,
  total,
  page,
  totalPages,
  onPageChange,
  filters,
  onFiltersChange,
}: Props) {
  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filters.action || ''}
          onChange={(e) => onFiltersChange({ ...filters, action: e.target.value || undefined })}
          className="bg-input text-text-primary text-sm rounded-lg px-3 py-2 border-0 outline-none"
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <input
          type="number"
          placeholder="Signal ID"
          value={filters.signalId ?? ''}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              signalId: e.target.value ? parseInt(e.target.value, 10) : undefined,
            })
          }
          className="bg-input text-text-primary text-sm rounded-lg px-3 py-2 w-28 border-0 outline-none placeholder:text-neutral"
        />

        <input
          type="date"
          value={filters.dateFrom || ''}
          onChange={(e) => onFiltersChange({ ...filters, dateFrom: e.target.value || undefined })}
          className="bg-input text-text-primary text-sm rounded-lg px-3 py-2 border-0 outline-none"
        />

        <input
          type="date"
          value={filters.dateTo || ''}
          onChange={(e) => onFiltersChange({ ...filters, dateTo: e.target.value || undefined })}
          className="bg-input text-text-primary text-sm rounded-lg px-3 py-2 border-0 outline-none"
        />

        {(filters.action || filters.signalId || filters.dateFrom || filters.dateTo) && (
          <button
            onClick={() => onFiltersChange({})}
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {logs.length === 0 ? (
        <div className="text-center text-text-secondary text-sm py-8">
          No log entries
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs border-b border-input">
                <th className="text-left py-2 px-3 font-medium">Date/Time</th>
                <th className="text-left py-2 px-3 font-medium">Action</th>
                <th className="text-left py-2 px-3 font-medium">Coin</th>
                <th className="text-left py-2 px-3 font-medium">Side</th>
                <th className="text-right py-2 px-3 font-medium">Price</th>
                <th className="text-right py-2 px-3 font-medium">Qty</th>
                <th className="text-right py-2 px-3 font-medium">P&L</th>
                <th className="text-right py-2 px-3 font-medium">Signal</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-input/50 hover:bg-input/30">
                  <td className="py-2 px-3 font-mono text-text-secondary text-xs whitespace-nowrap">
                    {formatDate(log.createdAt)}
                  </td>
                  <td className="py-2 px-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${actionBadgeColor(log.action)}`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-mono text-text-primary text-sm">
                    {extractCoin(log)}
                  </td>
                  <td className="py-2 px-3">
                    {(() => {
                      const side = extractSide(log)
                      if (!side) return <span className="text-text-secondary">-</span>
                      return <span className={side === 'LONG' ? 'text-long' : 'text-short'}>{side}</span>
                    })()}
                  </td>
                  <td className="py-2 px-3 font-mono text-text-primary text-sm text-right">
                    {extractPrice(log)}
                  </td>
                  <td className="py-2 px-3 font-mono text-text-secondary text-sm text-right">
                    {extractQty(log)}
                  </td>
                  <td className="py-2 px-3 font-mono text-sm text-right">
                    {(() => {
                      const pnl = extractPnl(log)
                      if (!pnl) return <span className="text-text-secondary">-</span>
                      return <span className={pnl.value >= 0 ? 'text-long' : 'text-short'}>{pnl.display}</span>
                    })()}
                  </td>
                  <td className="py-2 px-3 font-mono text-text-secondary text-sm text-right">
                    {log.signalId ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-text-secondary text-xs">
            {total} total entries
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors"
            >
              Previous
            </button>
            <span className="px-3 py-1.5 text-sm text-text-secondary">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
