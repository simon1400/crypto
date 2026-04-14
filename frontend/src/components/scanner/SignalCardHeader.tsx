import { ScoreBadge, StrategyBadge, ScannerStatusBadge as StatusBadge, TradeStatusBadge } from '../StatusBadge'
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
    <div className="mb-4 space-y-2.5">
      {/* Row 1: coin + type | result + score */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{data.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${data.isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {data.type}
          </span>
          {data.exchange && data.exchange !== 'bybit' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/15 text-amber-400 border border-amber-500/30">
              {data.exchange}
            </span>
          )}
          {mode === 'saved' && onShowChart && (
            <button
              onClick={onShowChart}
              className="text-text-secondary hover:text-accent transition-colors p-1"
              title="График позиции"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.linkedTrade && ['CLOSED', 'SL_HIT'].includes(data.linkedTrade.status) ? (() => {
            const t = data.linkedTrade!
            const netPnl = t.realizedPnl - t.fees - t.fundingPaid
            return (
              <div className="flex items-center gap-1.5">
                <span className={`font-mono font-bold text-sm ${netPnl > 0 ? 'text-long' : 'text-short'}`}>
                  {fmt2Signed(netPnl)}$
                </span>
                <span className="text-text-secondary text-xs">
                  ({t.status === 'SL_HIT' ? 'SL' : 'TP'})
                </span>
              </div>
            )
          })() : data.realizedPnl !== 0 ? (
            <span className={`font-mono font-bold text-sm ${data.realizedPnl > 0 ? 'text-long' : 'text-short'}`}>
              {fmt2Signed(data.realizedPnl)}$
            </span>
          ) : null}
          <ScoreBadge score={data.setupScore ?? data.score} />
        </div>
      </div>
      {/* Row 2: all badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <StrategyBadge strategy={data.strategy} />
        {mode === 'saved' && data.status && (
          data.linkedTrade
            ? <TradeStatusBadge status={data.linkedTrade.status} pnl={data.linkedTrade.realizedPnl - data.linkedTrade.fees - data.linkedTrade.fundingPaid} />
            : <StatusBadge status={data.status} />
        )}
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
        {data.executionType && (() => {
          const et = EXECUTION_TYPE_STYLES[data.executionType] || EXECUTION_TYPE_STYLES.IGNORE
          return <span className={`px-2 py-0.5 rounded text-xs font-bold ${et.bg} ${et.text}`}>{et.label}</span>
        })()}
        {data.setupQuality && (
          <span className={`font-mono font-bold text-sm ${QUALITY_COLORS[data.setupQuality] || 'text-neutral'}`}>
            {data.setupQuality}
          </span>
        )}
      </div>
    </div>
  )
}
