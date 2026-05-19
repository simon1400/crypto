import type { BreakoutStats as PaperStats } from '../../api/breakoutPaper'
import { fmt2Signed, pnlColor } from '../../lib/formatters'

interface Props {
  stats: PaperStats
  show: boolean
  setShow: (v: boolean | ((v: boolean) => boolean)) => void
  onSelectSymbol: (sym: string) => void
}

/** Collapsible per-symbol P&L grid. */
export default function BySymbolBreakdown({ stats, show, setShow, onSelectSymbol }: Props) {
  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        className="flex items-center gap-2 font-semibold mb-2 hover:text-accent transition-colors"
      >
        <span className="text-text-secondary text-xs">{show ? '▼' : '▶'}</span>
        По инструментам
        <span className="text-text-secondary font-normal">
          · {Object.keys(stats.bySymbol).length}
        </span>
      </button>
      {show && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {Object.entries(stats.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, s]) => (
            <button
              key={sym}
              type="button"
              onClick={() => onSelectSymbol(sym)}
              className="bg-card border border-input hover:border-accent/60 hover:bg-input/50 rounded p-2 text-xs text-left transition-colors cursor-pointer"
              title={`Открыть историю ${sym}`}
            >
              <div className="font-medium text-text-primary">{sym}</div>
              <div className="text-text-secondary">{s.trades} {s.trades === 1 ? 'trade' : 'trades'}</div>
              <div className={pnlColor(s.pnl)}>{fmt2Signed(s.pnl)}$</div>
              <div className="text-text-secondary">
                {s.trades > 0 ? `WR ${((s.wins / s.trades) * 100).toFixed(0)}%` : 'WR —'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
