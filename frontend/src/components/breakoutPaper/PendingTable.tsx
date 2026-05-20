import { useState } from 'react'
import type { BreakoutTrade as PaperTrade, BreakoutVariant } from '../../api/breakoutPaper'
import { cancelBreakoutPaperPending } from '../../api/breakoutPaper'
import { formatDate, formatPrice } from '../../lib/formatters'

interface Props {
  trades: PaperTrade[]
  loading: boolean
  variant: BreakoutVariant
  onSelectChartFor: (t: PaperTrade) => void
  onCancelled?: () => void
}

type PendingPair = { symbol: string; placedAt: string; buy?: PaperTrade; sell?: PaperTrade }

/**
 * Variant C / LIVE only: висящие limit-ордера на rangeEdge до пробоя. Пары
 * BUY+SELL по одной монете схлопнуты в одну строку, чтобы не дублировать монету.
 */
export default function PendingTable({ trades, loading, variant, onSelectChartFor, onCancelled }: Props) {
  const [cancellingSymbol, setCancellingSymbol] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Группируем PENDING-сделки по символу: если есть пара (BUY @ rangeHigh +
  // SELL @ rangeLow), показываем одну строку с обеими сторонами. Одинокий
  // limit (только одна сторона была размещена из-за price-guard) идёт
  // отдельной строкой.
  const bySymbol = new Map<string, PendingPair>()
  for (const t of trades) {
    const key = t.symbol
    const prev = bySymbol.get(key)
    if (!prev) {
      bySymbol.set(key, {
        symbol: t.symbol,
        placedAt: t.limitPlacedAt ?? t.openedAt,
        [t.side === 'BUY' ? 'buy' : 'sell']: t,
      } as PendingPair)
    } else {
      if (t.side === 'BUY') prev.buy = t
      else prev.sell = t
    }
  }
  const pairs = Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol))

  async function handleCancel(p: PendingPair, e: React.MouseEvent) {
    e.stopPropagation()
    const both = !!(p.buy && p.sell)
    const msg = both
      ? `Отменить лимитки на ${p.symbol.replace('USDT', '')}? Будут сняты обе стороны (BUY + SELL).`
      : `Отменить лимитку на ${p.symbol.replace('USDT', '')}?`
    if (!confirm(msg)) return
    setCancellingSymbol(p.symbol)
    setErr(null)
    try {
      const ref = p.buy ?? p.sell!
      await cancelBreakoutPaperPending(ref.id, variant)
      onCancelled?.()
    } catch (e: any) {
      setErr(e.message || 'Не удалось отменить')
    } finally {
      setCancellingSymbol(null)
    }
  }

  return (
    <div className="bg-card border border-input rounded overflow-hidden mb-6">
      {err && (
        <div className="px-3 py-2 bg-short/10 border-b border-short/30 text-xs text-short">{err}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[800px]">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Поставлен</th>
              <th className="text-left px-3 py-2">Монета</th>
              <th className="text-right px-3 py-2 text-long" title="Limit BUY на верхней границе диапазона">LONG @ rangeHigh</th>
              <th className="text-right px-3 py-2 text-short" title="Limit SELL на нижней границе диапазона">SHORT @ rangeLow</th>
              <th className="text-right px-3 py-2" title="Размер диапазона = расстояние до SL после fill">Range</th>
              <th className="text-center px-3 py-2">Статус</th>
              <th className="text-center px-3 py-2 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
            {!loading && pairs.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-text-secondary">
                Висящих limit-ордеров нет. Лимитки на rangeEdge ставятся автоматически после 03:00 UTC, когда сформирован 3h-диапазон.
              </td></tr>
            )}
            {!loading && pairs.map(p => {
              // rangeHigh = BUY.entryPrice (если есть) или BUY.stopLoss (если только SELL).
              // rangeLow = SELL.entryPrice или SELL.stopLoss (зеркально).
              const rangeHigh = p.buy?.entryPrice ?? p.sell?.initialStop ?? null
              const rangeLow = p.sell?.entryPrice ?? p.buy?.initialStop ?? null
              const rangePct = rangeHigh != null && rangeLow != null && rangeLow > 0
                ? ((rangeHigh - rangeLow) / rangeLow) * 100
                : null
              const both = p.buy && p.sell
              const cancelling = cancellingSymbol === p.symbol
              return (
                <tr
                  key={p.symbol}
                  className="border-t border-input hover:bg-input/50 transition-colors cursor-pointer"
                  onClick={() => {
                    // Откроем график по любой из сторон (одинаковый range).
                    const ref = p.buy ?? p.sell!
                    onSelectChartFor(ref)
                  }}
                >
                  <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{formatDate(p.placedAt)}</td>
                  <td className="px-3 py-2 font-mono font-medium text-text-primary">
                    <span className="flex items-center gap-2">
                      <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent">D</span>
                      <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/10 text-accent/80" title="Limit ордер ждёт fill">⏳</span>
                      <span>{p.symbol.replace('USDT', '')}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {p.buy ? (
                      <div className="flex flex-col items-end leading-tight">
                        <span className="text-long">${formatPrice(p.buy.entryPrice)}</span>
                        <span className="text-[10px] text-text-secondary">#{p.buy.id}</span>
                      </div>
                    ) : <span className="text-text-secondary">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {p.sell ? (
                      <div className="flex flex-col items-end leading-tight">
                        <span className="text-short">${formatPrice(p.sell.entryPrice)}</span>
                        <span className="text-[10px] text-text-secondary">#{p.sell.id}</span>
                      </div>
                    ) : <span className="text-text-secondary">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">
                    {rangePct != null ? `${rangePct.toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent/80 whitespace-nowrap">
                      {both ? '⏳ BUY + SELL' : p.buy ? '⏳ BUY only' : '⏳ SELL only'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button
                      onClick={(e) => handleCancel(p, e)}
                      disabled={cancelling}
                      title={both ? 'Отменить обе лимитки' : 'Отменить лимитку'}
                      className="w-6 h-6 rounded text-text-secondary hover:text-short hover:bg-short/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                    >
                      {cancelling ? (
                        <span className="animate-spin text-xs">⏳</span>
                      ) : (
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      )}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {pairs.length > 0 && (
        <div className="px-3 py-2 border-t border-input text-[11px] text-text-secondary">
          Всего пар: {pairs.length} · лимитки отменятся через 24ч после постановки, если не сработали
        </div>
      )}
    </div>
  )
}
