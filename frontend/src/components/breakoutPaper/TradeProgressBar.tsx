import type { BreakoutTrade as PaperTrade, BreakoutTradeLive as PaperTradeLive } from '../../api/breakoutPaper'
import { isOpenStatus } from './constants'

/**
 * Progress indicator between SL and the next TP for an open trade. Marker moves
 * proportionally from anchor (entry or prior TP) toward TP or SL. Color flips
 * red when price is moving toward SL (and SL isn't locked in profit), grey when
 * heading toward a profit-locking SL (BE/lock), green when heading toward TP.
 */
export default function TradeProgressBar({ trade, live, tps }: {
  trade: PaperTrade
  live: PaperTradeLive | undefined
  tps: number[]
}) {
  const t = trade
  const isOpen = isOpenStatus(t.status)
  if (!isOpen || !live?.currentPrice || tps.length === 0) {
    return <div className="text-center text-text-secondary text-[10px]">—</div>
  }
  const tpIdx = t.status === 'TP2_HIT' ? 2 : t.status === 'TP1_HIT' ? 1 : 0
  const nextTp = tps[tpIdx] ?? tps[tps.length - 1]
  const tpLabel = `TP${tpIdx + 1}`
  const sl = t.currentStop
  const entry = t.entryPrice
  const price = live.currentPrice
  const isLong = t.side === 'BUY'
  const prevTp = tpIdx > 0 ? tps[tpIdx - 1] : null
  const anchor = prevTp ?? entry
  const slLocksProfit = isLong ? sl >= entry : sl <= entry
  const slLabel = slLocksProfit ? (sl === entry ? 'BE' : 'lock') : 'SL'
  const distToTp = Math.abs(nextTp - anchor)
  const distToSl = Math.abs(sl - anchor)
  if (distToTp <= 0 && distToSl <= 0) {
    return <div className="text-center text-text-secondary text-[10px]">—</div>
  }
  const favorableMove = isLong ? (price - anchor) : (anchor - price)
  const towardSL = favorableMove < 0 && distToSl > 0
  const halfRatio = favorableMove >= 0
    ? (distToTp > 0 ? Math.min(1, favorableMove / distToTp) : 0)
    : (distToSl > 0 ? Math.min(1, -favorableMove / distToSl) : 0)
  const markerPct = towardSL ? 50 - halfRatio * 50 : 50 + halfRatio * 50
  const labelPct = Math.round(halfRatio * 100)
  const dangerZone = towardSL && !slLocksProfit && labelPct >= 75
  const fillColor = towardSL
    ? (slLocksProfit ? '#848e9c' : '#f6465d')
    : '#0ecb81'
  const labelColorCls = towardSL
    ? (slLocksProfit ? 'text-text-secondary' : 'text-short')
    : 'text-long'
  const anchorLabel = prevTp ? `TP${tpIdx}` : 'entry'
  return (
    <div className="min-w-[120px]">
      <div className="relative h-1.5 bg-input rounded overflow-hidden">
        <div className="absolute top-0 bottom-0 w-px bg-text-secondary/60" style={{ left: '50%' }} />
        <div
          className="absolute top-0 h-full"
          style={{
            left: towardSL ? `${markerPct}%` : '50%',
            width: `${Math.abs(markerPct - 50)}%`,
            background: fillColor,
            opacity: 0.85,
          }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-text-secondary mt-0.5 leading-none">
        <span className={slLocksProfit ? 'text-text-secondary' : 'text-short/80'}>{slLabel}</span>
        <span className="text-text-secondary/80">{anchorLabel}</span>
        <span className="text-long/80">{tpLabel}</span>
      </div>
      <div className={`text-center text-[10px] mt-0.5 font-mono ${labelColorCls}`}>
        {labelPct === 0
          ? (slLocksProfit ? 'в безриске' : `на ${anchorLabel}`)
          : `${labelPct}% ${towardSL ? `к ${slLabel}${dangerZone ? ' ⚠' : ''}` : `к ${tpLabel}`}`}
      </div>
    </div>
  )
}
