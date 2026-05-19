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

/** Desktop trades table (>= 640px). */
export default function TradesTable({
  trades, sortedTrades, tradesTotal, closedPage, setClosedPage,
  livePrices, config, loading, statusFilter,
  onSelectTrade, onSelectChart,
}: Props) {
  const hideClosedCols = statusFilter === 'CLOSED' || statusFilter === 'CANCELLED'

  return (
    <div className="hidden sm:block bg-card border border-input rounded overflow-hidden mb-6">
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[900px]">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Дата</th>
              <th className="text-left px-3 py-2">⏱</th>
              <th className="text-left px-3 py-2">Монета</th>
              <th className="text-right px-3 py-2">Вход</th>
              {!hideClosedCols && <th className="text-right px-3 py-2">Цена</th>}
              <th className="text-right px-3 py-2">Маржа</th>
              <th className="text-center px-3 py-2" title="Рекомендуемое плечо">Плечо</th>
              <th className="text-right px-3 py-2">Размер</th>
              {!hideClosedCols && <th className="text-center px-3 py-2" title="Где цена между SL и ближайшим живым TP">Прогресс</th>}
              {!hideClosedCols && <th className="text-right px-3 py-2">Рлз.</th>}
              <th className="text-right px-3 py-2">P&L</th>
              <th className="text-center px-3 py-2">Статус</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={14} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
            {!loading && trades.length === 0 && (
              <tr><td colSpan={14} className="text-center py-12 text-text-secondary">
                {config.enabled
                  ? 'Сделок ещё нет. Демо-счёт работает — виртуальные сделки появятся при пробое 3h-диапазона.'
                  : 'Демо-счёт выключен. Включи кнопкой ● Выкл сверху.'}
              </td></tr>
            )}
            {!loading && sortedTrades.map(t => {
              const live = livePrices[t.id]
              const { isOpen, isFinished, closedPctNum, remainingPositionUsd, lev, marginFull, marginRemaining } = computeTradeMath(t)
              const displayPnl = isOpen && live ? live.unrealizedPnl : t.netPnlUsd
              const displayPnlPct = isOpen && live
                ? live.unrealizedPnlPct
                : (t.depositAtEntryUsd > 0 ? (t.netPnlUsd / t.depositAtEntryUsd) * 100 : 0)
              const tps = (t.tpLadder ?? []).slice(0, 3)
              const sideColorCls = t.side === 'BUY' ? 'text-long' : 'text-short'

              return (
                <tr
                  key={t.id}
                  className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
                  onClick={() => onSelectTrade(t)}
                >
                  <td className="px-3 py-2 text-text-secondary whitespace-nowrap leading-tight">
                    {isFinished && t.closedAt ? (
                      <>
                        <div className="text-text-primary text-[11px]" title="Время закрытия">{formatDate(t.closedAt)}</div>
                        <div className="text-[10px] text-text-secondary" title="Время открытия">откр: {formatDate(t.openedAt)}</div>
                      </>
                    ) : (
                      formatDate(t.openedAt)
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-accent">
                    {isOpen
                      ? <LiveTimer openedAt={t.openedAt} />
                      : <span className="text-text-secondary" title="Длительность сделки">{formatElapsed(t.openedAt, t.closedAt)}</span>}
                  </td>
                  <td className="px-3 py-2 font-mono font-medium text-text-primary">
                    <span className="flex items-center gap-2">
                      <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent" title="Demo paper trade">D</span>
                      {(t.status === 'PENDING' || t.status === 'PENDING_LIMIT') && (
                        <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/10 text-accent/80" title="Limit ордер ждёт fill на rangeEdge">⏳</span>
                      )}
                      <span className={sideColorCls}>{t.symbol.replace('USDT', '')}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onSelectChart(t) }}
                        className="text-text-secondary hover:text-accent transition-colors"
                        title="График позиции"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-primary">${formatPrice(t.entryPrice)}</td>
                  {!hideClosedCols && (
                    <td className="px-3 py-2 text-right font-mono">
                      {isOpen && live?.currentPrice != null ? (
                        <span className={pnlColor(live.unrealizedPnl)}>${formatPrice(live.currentPrice)}</span>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right font-mono leading-tight">
                    {isFinished ? (
                      <span className="text-text-secondary" title="Маржа">${fmt2(marginFull)}</span>
                    ) : (
                      <>
                        <span className="text-text-primary" title="Маржа">${fmt2(marginRemaining)}</span>
                        {closedPctNum > 0 && closedPctNum < 100 && (
                          <div className="text-[10px] text-text-secondary">было ${fmt2(marginFull)}</div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center font-mono leading-tight">
                    {t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0 ? (
                      <span
                        className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent"
                        title="Рекомендуемое плечо"
                      >×{lev.toFixed(1)}</span>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono leading-tight">
                    {isFinished ? (
                      <span className="text-text-secondary">${fmt2(t.positionSizeUsd)}</span>
                    ) : (
                      <>
                        <span className="text-text-primary">${fmt2(remainingPositionUsd)}</span>
                        {closedPctNum > 0 && closedPctNum < 100 && (
                          <div className="text-[10px] text-text-secondary">было ${fmt2(t.positionSizeUsd)}</div>
                        )}
                      </>
                    )}
                  </td>
                  {!hideClosedCols && (
                    <td className="px-3 py-2 align-middle">
                      <TradeProgressBar trade={t} live={live} tps={tps} />
                    </td>
                  )}
                  {!hideClosedCols && (
                    <td className="px-3 py-2 text-right font-mono">
                      {closedPctNum > 0 ? (
                        <span className={pnlColor(t.realizedPnlUsd - t.feesPaidUsd)}>
                          {fmt2Signed(t.realizedPnlUsd - t.feesPaidUsd)}$
                        </span>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right font-mono leading-tight">
                    {isOpen && live ? (() => {
                      // Для частично закрытых (TP1_HIT/TP2_HIT) показываем P&L только
                      // по остатку — реализованная часть видна в колонке "Рлз." и не
                      // должна дублироваться здесь. Для полностью открытых (OPEN) — оба
                      // значения равны (closedFrac=0), поэтому fallback не меняет UI.
                      const pnl = live.remainingUnrealizedPnl ?? live.unrealizedPnl
                      const pnlPct = live.remainingUnrealizedPnlPct ?? live.unrealizedPnlPct
                      return (
                        <span className={pnlColor(pnl)}>
                          {fmt2Signed(pnl)}$
                          <div className="text-[10px] opacity-70">({fmt2Signed(pnlPct)}%)</div>
                        </span>
                      )
                    })() : isFinished ? (
                      <span className={pnlColor(t.netPnlUsd)} title={t.feesPaidUsd > 0 ? `Gross: ${fmt2Signed(t.realizedPnlUsd)}$ · Комиссии: -${fmt2(t.feesPaidUsd)}$` : undefined}>
                        {fmt2Signed(t.netPnlUsd)}$
                        {t.netPnlUsd !== 0 && <div className="text-[10px] opacity-70">({fmt2Signed(displayPnlPct)}%)</div>}
                      </span>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center"><PaperStatusBadge status={t.status} pnl={t.netPnlUsd} closes={t.closes} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* Pagination — только для вкладки Закрытые/Отменено (там часто > 20 записей) */}
      {(statusFilter === 'CLOSED' || statusFilter === 'CANCELLED') && (
        <TablePagination
          page={closedPage}
          pageSize={CLOSED_PAGE_SIZE}
          total={tradesTotal}
          loading={loading}
          onChange={(p) => setClosedPage(p)}
        />
      )}
    </div>
  )
}
