import type { BreakoutStats as PaperStats } from '../../api/breakoutPaper'
import { fmt2Signed } from '../../lib/formatters'
import EquityChart from '../EquityChart'

interface Props {
  stats: PaperStats
  startEquity: number
}

/** Equity curve: header stats + last-30-days daily P&L table + chart. */
export default function EquityCurveSection({ stats, startEquity }: Props) {
  const curve = stats.equityCurve
  if (curve.length === 0) return null

  const lastEquity = curve[curve.length - 1].equity
  const totalPnl = lastEquity - startEquity
  const totalPct = startEquity > 0 ? (totalPnl / startEquity) * 100 : 0
  const peak = curve.reduce((m, p) => Math.max(m, p.equity), startEquity)
  const trough = curve.reduce((m, p) => Math.min(m, p.equity), startEquity)

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <h3 className="font-semibold">Кривая капитала</h3>
        <div className="text-xs text-text-secondary font-mono flex flex-wrap gap-x-4 gap-y-1">
          <span>Старт: <span className="text-text-primary">${startEquity.toFixed(2)}</span></span>
          <span>Сейчас: <span className="text-text-primary">${lastEquity.toFixed(2)}</span></span>
          <span>
            Итого:{' '}
            <span className={totalPnl > 0 ? 'text-long' : totalPnl < 0 ? 'text-short' : ''}>
              {fmt2Signed(totalPnl)}$ ({fmt2Signed(totalPct)}%)
            </span>
          </span>
          <span>Пик: <span className="text-text-primary">${peak.toFixed(2)}</span></span>
          <span>Мин: <span className="text-text-primary">${trough.toFixed(2)}</span></span>
        </div>
      </div>
      <div className="bg-card border border-input rounded overflow-hidden mb-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead className="bg-input/50 text-text-secondary text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Дата</th>
                <th className="text-right px-3 py-2 font-medium">P&L дня</th>
                <th className="text-right px-3 py-2 font-medium">Депозит</th>
                <th className="text-right px-3 py-2 font-medium">Δ от старта</th>
              </tr>
            </thead>
            <tbody>
              {curve.slice(-30).reverse().map((p, idx) => {
                const delta = p.equity - startEquity
                return (
                  <tr
                    key={p.date}
                    className={`border-t border-input/60 hover:bg-input/40 transition-colors ${idx % 2 === 1 ? 'bg-input/10' : ''}`}
                  >
                    <td className="text-text-secondary px-3 py-1.5">{p.date}</td>
                    <td className={`text-right px-3 py-1.5 ${p.pnl > 0 ? 'text-long' : p.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                      {fmt2Signed(p.pnl)}$
                    </td>
                    <td className="text-right px-3 py-1.5 text-text-primary">${p.equity.toFixed(2)}</td>
                    <td className={`text-right px-3 py-1.5 ${delta > 0 ? 'text-long' : delta < 0 ? 'text-short' : 'text-text-secondary'}`}>
                      {fmt2Signed(delta)}$
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="bg-card border border-input rounded p-3">
        <EquityChart
          data={curve.map(p => ({ date: p.date, equity: p.equity }))}
          startEquity={startEquity}
          height={260}
        />
        <div className="text-[10px] text-text-secondary mt-2 flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-px bg-text-secondary" style={{ borderTop: '1px dashed #848e9c' }} />
            стартовый депозит
          </span>
        </div>
      </div>
    </div>
  )
}
