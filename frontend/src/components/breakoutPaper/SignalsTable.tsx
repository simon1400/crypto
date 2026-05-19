import type { BreakoutSignal, BreakoutStats as PaperStats } from '../../api/breakoutPaper'
import { formatDate, formatPrice } from '../../lib/formatters'
import PaperStatusBadge from './PaperStatusBadge'
import TablePagination from './TablePagination'
import { SIGNALS_PAGE_SIZE } from './constants'

interface Props {
  signals: BreakoutSignal[]
  signalsTotal: number
  signalsPage: number
  setSignalsPage: (n: number | ((p: number) => number)) => void
  stats: PaperStats | null
  loading: boolean
  onSelectSignal: (s: BreakoutSignal) => void
}

// Outcome statuses owned by variant A — shouldn't bleed into other variants'
// signal rows when they didn't open a trade.
const A_SPECIFIC = new Set(['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT', 'CLOSED'])

export default function SignalsTable({
  signals, signalsTotal, signalsPage, setSignalsPage,
  stats, loading, onSelectSignal,
}: Props) {
  return (
    <div className="bg-card border border-input rounded overflow-hidden mb-6">
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[800px]">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Дата</th>
              <th className="text-left px-3 py-2">UTC date</th>
              <th className="text-left px-3 py-2">Монета</th>
              <th className="text-left px-3 py-2" title="Историческая статистика по монете в paper trading: количество сделок · сумма P&L · winrate">История</th>
              <th className="text-center px-3 py-2">Сторона</th>
              <th className="text-right px-3 py-2">Вход</th>
              <th className="text-right px-3 py-2">SL</th>
              <th className="text-right px-3 py-2">Vol×avg</th>
              <th className="text-center px-3 py-2">Status</th>
              <th className="text-center px-3 py-2">Paper</th>
              <th className="text-left px-3 py-2">Причина</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={11} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
            {!loading && signals.length === 0 && (
              <tr><td colSpan={11} className="text-center py-12 text-text-secondary">
                Сигналов пока нет.
              </td></tr>
            )}
            {!loading && signals.map(s => {
              const sideColorCls = s.side === 'BUY' ? 'text-long' : 'text-short'
              const volRatio = s.avgVolume > 0 ? s.volumeAtBreakout / s.avgVolume : 0
              const paperColor = s.paperStatus === 'OPENED' ? 'text-long'
                : s.paperStatus === 'SKIPPED' ? 'text-short' : 'text-text-secondary'
              const paperLabel = s.paperStatus === 'OPENED' ? '✓ Открыт'
                : s.paperStatus === 'SKIPPED' ? '✕ Пропущен' : '—'
              const hist = stats?.bySymbol?.[s.symbol]
              const histWr = hist && hist.trades > 0 ? Math.round((hist.wins / hist.trades) * 100) : null
              const histPnlCls = !hist ? 'text-text-secondary'
                : hist.pnl > 0 ? 'text-long'
                : hist.pnl < 0 ? 'text-short' : 'text-text-secondary'
              // Status column — унифицировано для всех вариантов:
              //   - если у текущего варианта есть свой трейд по этому сигналу, показываем
              //     статус ЕГО трейда (NEW/ACTIVE/TP1_HIT/SL_HIT/CLOSED/EXPIRED + P&L);
              //   - если трейда нет (SKIPPED), используем shared lifecycle-статус сигнала
              //     (NEW/ACTIVE/EXPIRED — нейтральные жизненные стадии), но маскируем
              //     outcome-статусы (TP*/SL/CLOSED) — это исход чужого варианта, не нашего.
              const showSelfTradeStatus = !!s._tradeStatus
              const sharedFallback = A_SPECIFIC.has(s.status) ? 'NEW' : s.status
              const statusForBadge = showSelfTradeStatus ? s._tradeStatus! : sharedFallback
              const statusPnl = showSelfTradeStatus ? (s._tradeRealizedR ?? 0) : s.realizedR
              return (
                <tr
                  key={s.id}
                  className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
                  onClick={() => onSelectSignal(s)}
                >
                  <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{formatDate(s.createdAt)}</td>
                  <td className="px-3 py-2 text-text-secondary font-mono whitespace-nowrap">{s.rangeDate}</td>
                  <td className={`px-3 py-2 font-mono font-medium ${sideColorCls}`}>{s.symbol.replace('USDT', '')}</td>
                  <td className={`px-3 py-2 font-mono text-[11px] whitespace-nowrap ${histPnlCls}`}>
                    {hist
                      ? <>{hist.trades}tr · {hist.pnl >= 0 ? '+' : ''}{hist.pnl.toFixed(2)}$ · WR {histWr}%</>
                      : <span className="text-text-secondary">—</span>}
                  </td>
                  <td className={`px-3 py-2 text-center font-mono ${sideColorCls}`}>{s.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                  <td className="px-3 py-2 text-right font-mono">${formatPrice(s.entryPrice)}</td>
                  <td className="px-3 py-2 text-right font-mono text-short">${formatPrice(s.initialStop)}</td>
                  <td className="px-3 py-2 text-right font-mono">{volRatio.toFixed(2)}×</td>
                  <td className="px-3 py-2 text-center">
                    <PaperStatusBadge status={statusForBadge} pnl={statusPnl} closes={s.closes} />
                  </td>
                  <td className={`px-3 py-2 text-center font-mono whitespace-nowrap ${paperColor}`}>{paperLabel}</td>
                  <td className="px-3 py-2 text-text-secondary text-[11px] max-w-[280px] truncate" title={s.paperReason ?? ''}>
                    {s.paperReason ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <TablePagination
        page={signalsPage}
        pageSize={SIGNALS_PAGE_SIZE}
        total={signalsTotal}
        loading={loading}
        onChange={(p) => setSignalsPage(p)}
      />
    </div>
  )
}
