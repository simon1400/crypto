import { useState } from 'react'
import type { BreakoutLiveAlgoOrder, BreakoutLiveStatus } from '../../api/breakoutLiveC'
import { formatDate, formatPrice } from '../../lib/formatters'

interface Props {
  liveStatus: BreakoutLiveStatus | null
  /** Список symbol'ов открытых сделок бота — для подсветки orphan-ордеров. */
  openSymbols: string[]
  loading: boolean
  /** Принудительный рефреш списка ордеров с биржи (минует 5-мин кэш). */
  onForceRefresh?: () => Promise<void>
}

interface Leg {
  triggerPrice: number
  quantity: number
  algoId: number
  createdAt: number | null
  tpIdx: number | null
}

interface SymbolGroup {
  symbol: string
  side: 'BUY' | 'SELL' | 'MIXED'
  sl: Leg[]                  // STOP_MARKET
  // Слоты по индексу tpIdx ∈ {1,2,3}. Если на бирже остался не вся лесенка
  // (часть тейков уже исполнилась) — пропущенные слоты будут null.
  tps: (Leg | null)[]        // length 3
}

/**
 * LIVE only: conditional ордера (TP/SL), реально размещённые на Binance,
 * сгруппированные по монете. Один row на символ — SL + TP1/TP2/TP3 рядом.
 */
export default function ExchangeOrdersTable({ liveStatus, openSymbols, loading, onForceRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const orders = liveStatus?.algoOrders ?? []
  const ageSec = liveStatus?.algoOrdersAge != null ? Math.round(liveStatus.algoOrdersAge / 1000) : null
  const openSet = new Set(openSymbols)

  const handleRefresh = async () => {
    if (!onForceRefresh || refreshing) return
    setRefreshing(true)
    try { await onForceRefresh() }
    finally { setRefreshing(false) }
  }

  const groups = groupBySymbol(orders)
  // Orphan (нет в открытых сделках бота) — наверх и красным. Дальше — алфавит.
  groups.sort((a, b) => {
    const ao = openSet.has(a.symbol) ? 1 : 0
    const bo = openSet.has(b.symbol) ? 1 : 0
    if (ao !== bo) return ao - bo
    return a.symbol.localeCompare(b.symbol)
  })
  const orphanCount = groups.reduce((n, g) => n + (openSet.has(g.symbol) ? 0 : 1), 0)

  return (
    <div className="bg-card border border-input rounded overflow-hidden mb-6">
      <div className="px-3 py-2 border-b border-input flex items-baseline justify-between flex-wrap gap-2">
        <div className="text-xs text-text-secondary">
          Conditional ордера на Binance (TP / SL для открытых позиций).
          Это «источник правды» — биржа триггерит exit, даже если бот оффлайн.
        </div>
        <div className="flex items-baseline gap-3 text-[10px] text-text-secondary font-mono">
          <span>
            {groups.length} {pluralize(groups.length, 'монета', 'монеты', 'монет')}
            {' · '}{orders.length} {pluralize(orders.length, 'ордер', 'ордера', 'ордеров')}
            {ageSec != null && <span> · обновлено {ageSec}s назад</span>}
          </span>
          {onForceRefresh && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="px-2 py-1 rounded border border-input text-text-primary hover:bg-input/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Принудительно запросить свежий список с биржи (минует 5-минутный кэш)"
            >
              {refreshing ? '↻ обновляю…' : '↻ Обновить'}
            </button>
          )}
        </div>
      </div>
      {orphanCount > 0 && (
        <div className="px-3 py-2 bg-short/10 border-b border-short/30 text-xs text-short">
          ⚠️ {orphanCount} {pluralize(orphanCount, 'монета', 'монеты', 'монет')} с ордерами на бирже, но без открытой сделки в боте.
          Возможно, позиция закрылась, а algo-ордера остались — проверь и при необходимости отмени вручную.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[700px]">
          <thead className="bg-input text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2">Монета</th>
              <th className="text-center px-3 py-2">Сторона</th>
              <th className="text-right px-3 py-2">Stop Loss</th>
              <th className="text-right px-3 py-2">TP1</th>
              <th className="text-right px-3 py-2">TP2</th>
              <th className="text-right px-3 py-2">TP3</th>
              <th className="text-left px-3 py-2">Размещён</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>
            )}
            {!loading && groups.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-text-secondary">
                Нет conditional ордеров на бирже. Появятся когда откроется позиция (TP1/TP2/TP3 + SL).
              </td></tr>
            )}
            {!loading && groups.map((g) => {
              const tp1 = g.tps[0]
              const tp2 = g.tps[1]
              const tp3 = g.tps[2]
              const sideTone = g.side === 'BUY' ? 'text-long' : g.side === 'SELL' ? 'text-short' : 'text-text-secondary'
              const placedAt = earliestCreatedAt(g)
              const isOrphan = !openSet.has(g.symbol)
              const rowCls = isOrphan
                ? 'border-t border-short/40 bg-short/5 hover:bg-short/10 transition-colors'
                : 'border-t border-input hover:bg-input/50 transition-colors'
              return (
                <tr key={g.symbol} className={rowCls}>
                  <td className="px-3 py-2 font-mono font-medium text-text-primary">
                    {isOrphan && (
                      <span className="mr-1 text-short" title="Нет открытой сделки в боте для этого символа">⚠</span>
                    )}
                    <span className={isOrphan ? 'text-short' : ''}>
                      {g.symbol.replace('USDT', '')}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-center font-mono ${sideTone}`}>
                    {g.side === 'MIXED' ? 'BUY+SELL' : g.side}
                  </td>
                  <LegCell legs={g.sl} tone="text-short" />
                  <LegCell legs={tp1 ? [tp1] : []} tone="text-long" />
                  <LegCell legs={tp2 ? [tp2] : []} tone="text-long" />
                  <LegCell legs={tp3 ? [tp3] : []} tone="text-long" />
                  <td className="px-3 py-2 font-mono text-text-secondary">
                    {placedAt ? formatDate(new Date(placedAt).toISOString()) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LegCell({ legs, tone }: { legs: Leg[]; tone: string }) {
  if (legs.length === 0) {
    return <td className="px-3 py-2 text-right font-mono text-text-secondary">—</td>
  }
  // Если несколько ног одного типа на одной цене — кликабельный тултип со
  // всеми algoId через запятую. На разных ценах рендерим столбиком.
  return (
    <td className="px-3 py-2 text-right font-mono leading-tight">
      {legs.map((leg) => (
        <div
          key={leg.algoId}
          className={tone}
          title={`algoId: ${leg.algoId}\nКол-во: ${leg.quantity.toLocaleString('ru-RU')}`}
        >
          ${formatPrice(leg.triggerPrice)}
          <div className="text-[10px] text-text-secondary">
            {leg.quantity.toLocaleString('ru-RU')}
          </div>
        </div>
      ))}
    </td>
  )
}

function groupBySymbol(orders: BreakoutLiveAlgoOrder[]): SymbolGroup[] {
  const bySym = new Map<string, SymbolGroup>()
  for (const o of orders) {
    let g = bySym.get(o.symbol)
    if (!g) {
      g = { symbol: o.symbol, side: o.side, sl: [], tps: [null, null, null] }
      bySym.set(o.symbol, g)
    } else if (g.side !== o.side) {
      g.side = 'MIXED'
    }
    const leg: Leg = {
      triggerPrice: o.triggerPrice,
      quantity: o.quantity,
      algoId: o.algoId,
      createdAt: o.createdAt,
      tpIdx: o.tpIdx,
    }
    if (o.type === 'STOP_MARKET') {
      g.sl.push(leg)
    } else if (o.type === 'TAKE_PROFIT_MARKET') {
      // tpIdx 1/2/3 → слот 0/1/2. Если индекс известен — кладём в его слот;
      // в случае конфликта (две ноги с одинаковым tpIdx — нехарактерно, но
      // возможно после ручного reset на бирже) затираем более свежей.
      if (leg.tpIdx && leg.tpIdx >= 1 && leg.tpIdx <= 3) {
        g.tps[leg.tpIdx - 1] = leg
      } else {
        // Неизвестный tpIdx (orphan TP без нашего clientAlgoId) — в первый
        // свободный слот.
        const free = g.tps.findIndex(s => s === null)
        if (free >= 0) g.tps[free] = leg
      }
    }
    // Ордера без распознанного type игнорируем — на UI всё равно нечего
    // показывать без классификации.
  }
  for (const g of bySym.values()) {
    g.sl.sort((a, b) => a.triggerPrice - b.triggerPrice)
  }
  return Array.from(bySym.values())
}

function earliestCreatedAt(g: SymbolGroup): number | null {
  let earliest: number | null = null
  const all: Leg[] = [...g.sl]
  for (const tp of g.tps) if (tp) all.push(tp)
  for (const leg of all) {
    if (leg.createdAt != null) {
      if (earliest == null || leg.createdAt < earliest) earliest = leg.createdAt
    }
  }
  return earliest
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
