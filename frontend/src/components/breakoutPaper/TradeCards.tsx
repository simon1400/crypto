import type {
  BreakoutPaperConfig as PaperConfig,
  BreakoutTrade as PaperTrade,
  BreakoutTradeLive as PaperTradeLive,
} from '../../api/breakoutPaper'
import { formatDate, formatPrice, fmt2, fmt2Signed, pnlColor } from '../../lib/formatters'
import PaperStatusBadge from './PaperStatusBadge'
import LiveTimer from './LiveTimer'
import TradeProgressBar from './TradeProgressBar'
import TablePagination from './TablePagination'
import { formatElapsed, computeTradeMath } from './helpers'
import { CLOSED_PAGE_SIZE, StatusFilter } from './constants'

interface Props {
  trades: PaperTrade[]
  sortedTrades: PaperTrade[]
  tradesTotal: number
  closedPage: number
  setClosedPage: (n: number | ((p: number) => number)) => void
  livePrices: Record<number, PaperTradeLive>
  config: PaperConfig
  loading: boolean
  statusFilter: StatusFilter
  onSelectTrade: (t: PaperTrade) => void
  onSelectChart: (t: PaperTrade) => void
}

/** Mobile trade cards (< 640px). */
export default function TradeCards({
  trades, sortedTrades, tradesTotal, closedPage, setClosedPage,
  livePrices, config, loading, statusFilter,
  onSelectTrade, onSelectChart,
}: Props) {
  return (
    <div className="sm:hidden space-y-2 mb-6">
      {loading && (
        <div className="bg-card border border-input rounded p-6 text-center text-text-secondary text-sm">Загрузка...</div>
      )}
      {!loading && trades.length === 0 && (
        <div className="bg-card border border-input rounded p-6 text-center text-text-secondary text-sm">
          {config.enabled
            ? 'Сделок ещё нет. Демо-счёт работает — виртуальные сделки появятся при пробое 3h-диапазона.'
            : 'Демо-счёт выключен. Включи кнопкой ● Выкл сверху.'}
        </div>
      )}
      {!loading && sortedTrades.map(t => {
        const live = livePrices[t.id]
        const { isOpen, isFinished, closedFrac, lev, marginFull, marginRemaining } = computeTradeMath(t)
        const displayMargin = isFinished ? marginFull : marginRemaining
        const tps = (t.tpLadder ?? []).slice(0, 3)
        const sideColorCls = t.side === 'BUY' ? 'text-long' : 'text-short'
        const pnl = isOpen && live
          ? (live.remainingUnrealizedPnl ?? live.unrealizedPnl)
          : t.netPnlUsd
        const pnlPct = isOpen && live
          ? (live.remainingUnrealizedPnlPct ?? live.unrealizedPnlPct)
          : (t.depositAtEntryUsd > 0 ? (t.netPnlUsd / t.depositAtEntryUsd) * 100 : 0)
        return (
          <div
            key={t.id}
            className="bg-card border border-input rounded p-3 active:bg-input/40 transition-colors cursor-pointer"
            onClick={() => onSelectTrade(t)}
          >
            {/* Row 1: ticker + chart icon · status */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 font-mono">
                <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent">D</span>
                {(t.status === 'PENDING' || t.status === 'PENDING_LIMIT') && (
                  <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/10 text-accent/80">⏳</span>
                )}
                <span className={`${sideColorCls} font-semibold text-base`}>{t.symbol.replace('USDT', '')}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onSelectChart(t) }}
                  className="text-text-secondary hover:text-accent transition-colors"
                  title="График позиции"
                >
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                </button>
              </div>
              <PaperStatusBadge status={t.status} pnl={t.netPnlUsd} closes={t.closes} />
            </div>

            {/* Row 2: time */}
            <div className="flex items-center justify-between text-[11px] text-text-secondary font-mono mb-2">
              <span>
                {isFinished && t.closedAt
                  ? <>закр: {formatDate(t.closedAt)}</>
                  : formatDate(t.openedAt)}
              </span>
              <span className="text-accent">
                {isOpen ? <LiveTimer openedAt={t.openedAt} /> : formatElapsed(t.openedAt, t.closedAt)}
              </span>
            </div>

            {/* Row 3: entry → current price */}
            <div className="flex items-baseline justify-between gap-2 mb-2 font-mono text-sm">
              <div className="flex items-baseline gap-1.5">
                <span className="text-text-primary">${formatPrice(t.entryPrice)}</span>
              </div>
              {isOpen && live?.currentPrice != null && (
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2" title="Live цена">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-long opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-long" />
                  </span>
                  <span className={pnlColor(live.unrealizedPnl)}>${formatPrice(live.currentPrice)}</span>
                </div>
              )}
            </div>

            {/* Row 4: progress bar (only if open) */}
            {isOpen && statusFilter !== 'CLOSED' && statusFilter !== 'CANCELLED' && (
              <div className="mb-2">
                <TradeProgressBar trade={t} live={live} tps={tps} />
              </div>
            )}

            {/* Row 5: margin/leverage on left, P&L on right */}
            <div className="flex items-baseline justify-between border-t border-input pt-2 font-mono">
              <div className="flex items-baseline gap-1.5 text-[11px]">
                <span className="text-text-primary">${fmt2(displayMargin)}</span>
                {lev > 1 && (
                  <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent">
                    ×{lev.toFixed(1)}
                  </span>
                )}
                {closedFrac > 0 && closedFrac < 1 && (
                  <span className="text-text-secondary text-[10px]">· закр {Math.round(closedFrac * 100)}%</span>
                )}
              </div>
              {(isOpen || isFinished) ? (
                <div className={`text-sm font-semibold ${pnlColor(pnl)}`}>
                  {fmt2Signed(pnl)}$
                  {pnl !== 0 && (
                    <span className="text-[10px] opacity-70 ml-1">({fmt2Signed(pnlPct)}%)</span>
                  )}
                </div>
              ) : (
                <span className="text-text-secondary text-sm">—</span>
              )}
            </div>
          </div>
        )
      })}
      {/* Pagination — same logic as desktop table */}
      {(statusFilter === 'CLOSED' || statusFilter === 'CANCELLED') && (
        <TablePagination
          page={closedPage}
          pageSize={CLOSED_PAGE_SIZE}
          total={tradesTotal}
          loading={loading}
          onChange={(p) => setClosedPage(p)}
          layout="standalone"
        />
      )}
    </div>
  )
}
