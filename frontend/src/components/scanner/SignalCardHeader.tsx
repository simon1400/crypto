import { ScoreBadge, StrategyBadge, ScannerStatusBadge as StatusBadge } from '../StatusBadge'
import { QUALITY_COLORS } from '../../lib/constants'
import { fmt2Signed } from '../../lib/formatters'
import { SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES, CATEGORY_STYLES } from './constants'
import { CardData, CardMode, SavedProps } from './types'

interface SignalCardHeaderProps {
  data: CardData
  mode: CardMode
  onShowChart?: () => void
}

export default function SignalCardHeader({ data, mode, onShowChart }: SignalCardHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold text-lg text-text-primary">{data.coin}</span>
        <span className={`px-2 py-0.5 rounded text-sm font-bold ${data.isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
          {data.type}
        </span>
        <StrategyBadge strategy={data.strategy} />
        {mode === 'saved' && data.status && <StatusBadge status={data.status} />}
        {/* Setup category badge */}
        {(() => {
          if (data.setupCategory) {
            const sc = SETUP_CATEGORY_STYLES[data.setupCategory] || SETUP_CATEGORY_STYLES.IGNORE
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${sc.bg} ${sc.text}`}>{sc.label}</span>
          }
          if (data.legacyCategory) {
            const cs = CATEGORY_STYLES[data.legacyCategory] || CATEGORY_STYLES.REJECTED
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${cs.bg} ${cs.text}`}>{cs.label}</span>
          }
          return null
        })()}
        {/* Execution type badge */}
        {data.executionType && (() => {
          const et = EXECUTION_TYPE_STYLES[data.executionType] || EXECUTION_TYPE_STYLES.IGNORE
          return <span className={`px-2 py-0.5 rounded text-xs font-bold ${et.bg} ${et.text}`}>{et.label}</span>
        })()}
        {/* Setup quality grade */}
        {data.setupQuality && (
          <span className={`font-mono font-bold text-sm ${QUALITY_COLORS[data.setupQuality] || 'text-neutral'}`}>
            {data.setupQuality}
          </span>
        )}
        {/* Chart icon (saved only) */}
        {mode === 'saved' && onShowChart && (
          <button
            onClick={onShowChart}
            className="text-text-secondary hover:text-accent transition-colors ml-1"
            title="График позиции"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {data.realizedPnl !== 0 && (
          <span className={`font-mono font-bold text-sm ${data.realizedPnl > 0 ? 'text-long' : 'text-short'}`}>
            {fmt2Signed(data.realizedPnl)}$
          </span>
        )}
        <ScoreBadge score={data.setupScore ?? data.score} />
      </div>
    </div>
  )
}
