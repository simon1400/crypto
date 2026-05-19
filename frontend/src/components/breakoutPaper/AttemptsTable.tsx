import type { BreakoutLiveAttempt } from '../../api/breakoutLiveC'
import { formatPrice } from '../../lib/formatters'

interface AttemptsTotals {
  total: number
  placed: number
  rejected: number
  gated: number
  filtered: number
}

interface Props {
  attempts: BreakoutLiveAttempt[]
  attemptsTotals: AttemptsTotals | null
  loading: boolean
  onClear: () => void
}

/**
 * LIVE 'Отклонённые' tab — placement attempts audit for today's UTC range cycle.
 * Every limit the strategy considered: placed, rejected by Binance (-5022 post-
 * only, -2027 max position, -4024 minPrice), skipped by our markPrice gate (would
 * be marketable), or skipped by pre-placement filters (slDist<0.4%, no range,
 * margin guard).
 */
export default function AttemptsTable({ attempts, attemptsTotals, loading, onClear }: Props) {
  return (
    <div className="bg-card border border-input rounded overflow-hidden mb-6">
      <div className="flex items-center justify-between px-3 py-2 border-b border-input">
        <div className="text-xs text-text-secondary">
          {loading ? 'Загрузка...' : (
            <>
              Сегодня (UTC): <span className="text-text-primary font-medium">{attemptsTotals?.total ?? attempts.length}</span> попыток
              {attemptsTotals && attemptsTotals.total > 0 && (
                <span className="text-text-secondary">
                  {' · '}{attemptsTotals.placed} placed
                  {' · '}{attemptsTotals.rejected} rejected
                  {' · '}{attemptsTotals.gated} gated
                  {' · '}{attemptsTotals.filtered} filtered
                </span>
              )}
              {attemptsTotals && attemptsTotals.total > attempts.length && (
                <span className="text-text-secondary"> · показаны последние {attempts.length}</span>
              )}
            </>
          )}
        </div>
        <button
          className="text-[11px] text-text-secondary hover:text-text-primary px-2 py-1 rounded border border-input hover:bg-input transition-colors"
          onClick={onClear}
        >
          Очистить
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[900px]">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Время UTC</th>
              <th className="text-left px-3 py-2">Монета</th>
              <th className="text-center px-3 py-2">Сторона</th>
              <th className="text-center px-3 py-2">Статус</th>
              <th className="text-left px-3 py-2">Код</th>
              <th className="text-right px-3 py-2" title="Цена лимитки при попытке">Limit</th>
              <th className="text-right px-3 py-2" title="markPrice в момент попытки">Mark</th>
              <th className="text-right px-3 py-2">Range</th>
              <th className="text-left px-3 py-2">Причина</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
            {!loading && attempts.length === 0 && (
              <tr><td colSpan={9} className="text-center py-12 text-text-secondary">
                За сегодня попыток постановки лимиток ещё не было. Они появятся когда сканер начнёт цикл (раз в несколько минут после 03:00 UTC).
              </td></tr>
            )}
            {!loading && attempts.map(a => {
              const statusBadge = (() => {
                switch (a.status) {
                  case 'PLACED':            return { label: '✓ Placed',  cls: 'bg-long/15 text-long' }
                  case 'REJECTED_EXCHANGE': return { label: '✕ Rejected', cls: 'bg-short/15 text-short' }
                  case 'SKIPPED_GATE':      return { label: '⊘ Gate',    cls: 'bg-accent/15 text-accent' }
                  case 'SKIPPED_FILTER':    return { label: '⊘ Filter',  cls: 'bg-neutral/15 text-text-secondary' }
                  default:                  return { label: a.status,    cls: 'bg-input text-text-secondary' }
                }
              })()
              const ts = new Date(a.attemptedAt)
              const hhmm = `${String(ts.getUTCHours()).padStart(2,'0')}:${String(ts.getUTCMinutes()).padStart(2,'0')}:${String(ts.getUTCSeconds()).padStart(2,'0')}`
              const rangeStr = a.rangeHigh != null && a.rangeLow != null
                ? `${formatPrice(a.rangeLow)}/${formatPrice(a.rangeHigh)}`
                : '—'
              return (
                <tr key={a.id} className="border-t border-input hover:bg-input/50 transition-colors">
                  <td className="px-3 py-2 font-mono text-[11px] text-text-secondary whitespace-nowrap">{hhmm}</td>
                  <td className="px-3 py-2 font-mono text-text-primary">{a.symbol.replace('USDT','')}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${a.side === 'BUY' ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}>{a.side}</span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusBadge.cls} whitespace-nowrap`}>{statusBadge.label}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-text-secondary">{a.reasonCode ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-right text-text-secondary">{a.limitPrice != null ? `$${formatPrice(a.limitPrice)}` : '—'}</td>
                  <td className="px-3 py-2 font-mono text-right text-text-secondary">{a.markPrice != null ? `$${formatPrice(a.markPrice)}` : '—'}</td>
                  <td className="px-3 py-2 font-mono text-right text-text-secondary text-[11px]">{rangeStr}</td>
                  <td className="px-3 py-2 text-text-secondary text-[11px] max-w-[400px] truncate" title={a.reasonText ?? ''}>{a.reasonText ?? ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
