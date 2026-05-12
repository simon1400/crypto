import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getBreakoutPaperConfig, updateBreakoutPaperConfig, resetBreakoutPaper,
  getBreakoutPaperTrades, getBreakoutPaperStats,
  getBreakoutPaperLivePrices, wipeAllBreakoutPaper, closeAllBreakoutPaperTradesMarket,
  getBreakoutConfig, updateBreakoutConfig, getBreakoutSetups,
  getBreakoutSignals,
  type BreakoutPaperConfig as PaperConfig,
  type BreakoutTrade as PaperTrade,
  type BreakoutStats as PaperStats,
  type BreakoutTradeLive as PaperTradeLive,
  type BreakoutConfig as ScannerCfg,
  type BreakoutSignal,
  type BreakoutVariant,
} from '../api/breakoutPaper'
import BreakoutPaperTradeModal from '../components/BreakoutPaperTradeModal'
import BreakoutSignalModal from '../components/BreakoutSignalModal'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import SymbolHistoryModal from '../components/SymbolHistoryModal'
import EquityChart from '../components/EquityChart'
import { formatDate, pnlColor, fmt2, fmt2Signed, formatPrice } from '../lib/formatters'

function paperTradeToPosition(t: PaperTrade, currentPrice: number | null): PositionChartPosition {
  const closes = t.closes || []
  const effectivePrice = currentPrice != null
    ? currentPrice
    : (closes.length > 0 ? closes[closes.length - 1].price : null)
  return {
    coin: t.symbol,
    type: t.side === 'BUY' ? 'LONG' : 'SHORT',
    entry: t.entryPrice,
    stopLoss: t.currentStop,
    takeProfits: (t.tpLadder || []).slice(0, 3),
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    currentPrice: effectivePrice,
    partialCloses: closes.map(c => ({
      price: c.price,
      percent: c.percent,
      closedAt: c.closedAt,
      isSL: c.reason === 'SL',
    })),
    title: `${t.symbol} ${t.side === 'BUY' ? 'LONG' : 'SHORT'} (DEMO #${t.id})`,
  }
}

// 'SIGNALS' — таб для A/B со списком сигналов сканера.
// 'PENDING' — таб для C: висящие limit-ордера на rangeEdge до пробоя.
type StatusFilter = 'OPEN' | 'CLOSED' | 'SIGNALS' | 'PENDING'

const PAPER_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  OPEN:      { bg: 'bg-accent/15',     text: 'text-accent',     label: 'Открыта' },
  TP1_HIT:   { bg: 'bg-long/10',       text: 'text-long',       label: 'TP1 ✓' },
  TP2_HIT:   { bg: 'bg-long/15',       text: 'text-long',       label: 'TP2 ✓' },
  TP3_HIT:   { bg: 'bg-long/20',       text: 'text-long',       label: 'TP3 ✓' },
  CLOSED:    { bg: 'bg-long/10',       text: 'text-long',       label: 'Закрыта' },
  SL_HIT:    { bg: 'bg-short/15',      text: 'text-short',      label: 'SL' },
  EXPIRED:   { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Истёк' },
  PENDING:   { bg: 'bg-accent/10',     text: 'text-accent/80',  label: '⏳ Limit pending' },
  CANCELLED: { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Limit отменён' },
}

// Сжатый текст исхода: смотрит на массив closes и собирает «TP1 → TP2 → SL@TP1»,
// «TP1 → EXP», «SL» и т.д. Это полезнее чем generic «Закрыта», потому что одной
// меткой видно куда дошла сделка перед финальным выходом.
function buildOutcomeLabel(status: string, closes?: Array<{ reason?: string }>): string {
  const reasons = (closes ?? []).map(c => c.reason).filter(Boolean) as string[]
  const tps = reasons.filter(r => r === 'TP1' || r === 'TP2' || r === 'TP3')
  const finalReason = reasons[reasons.length - 1]

  // Открытые статусы — рендерим как было (метки из BADGE)
  if (status === 'OPEN' || status === 'TP1_HIT' || status === 'TP2_HIT') {
    return PAPER_STATUS_BADGE[status]?.label ?? status
  }

  // Финальный TP3
  if (status === 'TP3_HIT' || (status === 'CLOSED' && finalReason === 'TP3')) {
    return tps.length > 1 ? `${tps.slice(0, -1).join(' → ')} → TP3 ✓` : 'TP3 ✓'
  }

  // SL после частичных TP — это и есть «SL@BE» или «SL@TP1» case
  if (status === 'SL_HIT' || (status === 'CLOSED' && finalReason === 'SL')) {
    if (tps.length === 0) return 'SL'
    if (tps.length === 1) return `${tps[0]} → SL@BE`            // SL переехал в BE
    return `${tps.join(' → ')} → SL@${tps[tps.length - 2]}`     // полный трейлинг
  }

  // Истёк (EOD UTC)
  if (status === 'EXPIRED') {
    return tps.length > 0 ? `${tps.join(' → ')} → EXP` : 'Истёк'
  }

  // Ручное закрытие / margin / fallback
  if (status === 'CLOSED') {
    if (finalReason === 'MANUAL') return tps.length > 0 ? `${tps.join(' → ')} → Manual` : 'Manual'
    if (finalReason === 'MARGIN') return tps.length > 0 ? `${tps.join(' → ')} → Margin` : 'Margin'
    return tps.length > 0 ? tps.join(' → ') : 'Закрыта'
  }

  return PAPER_STATUS_BADGE[status]?.label ?? status
}

function outcomeBadgeClasses(status: string, pnl: number): { bg: string; text: string } {
  if (status === 'OPEN' || status === 'TP1_HIT' || status === 'TP2_HIT') {
    return { bg: PAPER_STATUS_BADGE[status].bg, text: PAPER_STATUS_BADGE[status].text }
  }
  if (status === 'SL_HIT') return { bg: 'bg-short/15', text: 'text-short' }
  // CLOSED / TP3_HIT / EXPIRED → цвет по знаку P&L
  if (pnl > 0) return { bg: 'bg-long/15', text: 'text-long' }
  if (pnl < 0) return { bg: 'bg-short/10', text: 'text-short' }
  return { bg: 'bg-neutral/15', text: 'text-neutral' }
}

function PaperStatusBadge({ status, pnl, closes }: { status: string; pnl: number; closes?: Array<{ reason?: string }> }) {
  const label = buildOutcomeLabel(status, closes)
  const { bg, text } = outcomeBadgeClasses(status, pnl)
  return <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${bg} ${text}`}>{label}</span>
}

function formatElapsed(openedAt: string, closedAt?: string | null): string {
  const endMs = closedAt ? new Date(closedAt).getTime() : Date.now()
  const ms = endMs - new Date(openedAt).getTime()
  if (ms < 0) return '0м'
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}д ${hours % 24}ч`
  if (hours > 0) return `${hours}ч ${mins % 60}м`
  return `${mins}м`
}

function LiveTimer({ openedAt }: { openedAt: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])
  return <>{formatElapsed(openedAt)}</>
}

function TradeProgressBar({ trade, live, tps }: { trade: PaperTrade; live: PaperTradeLive | undefined; tps: number[] }) {
  const t = trade
  const isOpen = ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)
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

function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : ''}$${Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)}`
}
function fmtPrice(n: number, _symbol?: string, _market?: string): string {
  return formatPrice(n)
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        active ? 'bg-accent text-bg-primary' : 'bg-card border border-input text-text-secondary hover:text-text-primary'
      }`}>
      {children}
    </button>
  )
}

function Stat({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string;
  tone?: 'long' | 'short' | 'neutral'
}) {
  const toneCls = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-input rounded p-3">
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      <div className={`text-xl font-semibold ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs text-text-secondary mt-1">{sub}</div>}
    </div>
  )
}

export interface BreakoutPaperProps {
  /** Which paper-trader copy this view binds to. Default 'A' (legacy prod). */
  variant?: BreakoutVariant
}

export default function BreakoutPaper({ variant = 'A' }: BreakoutPaperProps = {}) {
  const [config, setConfig] = useState<PaperConfig | null>(null)
  const [scannerCfg, setScannerCfg] = useState<ScannerCfg | null>(null)
  const [setups, setSetups] = useState<string[]>([])
  const [trades, setTrades] = useState<PaperTrade[]>([])
  const [tradesTotal, setTradesTotal] = useState(0)
  // Открытые сделки держим отдельно от `trades` — нужны для расчёта equity-with-unrealized
  // в верхней статистике независимо от выбранной вкладки.
  const [openTradesAll, setOpenTradesAll] = useState<PaperTrade[]>([])
  const [stats, setStats] = useState<PaperStats | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  // Пагинация только для вкладки "Закрытые" (открытых обычно <= 10 штук, лимит маленький)
  const CLOSED_PAGE_SIZE = 20
  const [closedPage, setClosedPage] = useState(1)
  // Пагинация для вкладки "Сигналы" — 20 на страницу, серверная.
  const SIGNALS_PAGE_SIZE = 20
  const [signalsPage, setSignalsPage] = useState(1)
  const [signalsTotal, setSignalsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Default reset amount tracks the variant's starting deposit (A=$500, B=$320)
  // and reflects whatever the operator has saved in BreakoutPaperConfig.
  const [resetAmount, setResetAmount] = useState(variant === 'A' ? 500 : 320)
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})
  const [selectedTrade, setSelectedTrade] = useState<PaperTrade | null>(null)
  const [chartTrade, setChartTrade] = useState<PaperTrade | null>(null)
  const [signals, setSignals] = useState<BreakoutSignal[]>([])
  const [selectedSignal, setSelectedSignal] = useState<BreakoutSignal | null>(null)
  const [symbolHistory, setSymbolHistory] = useState<string | null>(null)
  const [showAbout, setShowAbout] = useState(false)
  const [showBySymbol, setShowBySymbol] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const isSignalsTab = statusFilter === 'SIGNALS'
      const isPendingTab = statusFilter === 'PENDING'
      // Variant C: "Открытые" — только FILLED-сделки (PENDING вынесли в свой таб).
      // "Закрытые" дополнительно содержит CANCELLED (limit отменён EOD).
      // "PENDING" — висящие limit-ордера до пробоя (только для C).
      const status = statusFilter === 'OPEN'
        ? ['OPEN', 'TP1_HIT', 'TP2_HIT']
        : statusFilter === 'CLOSED'
        ? (variant === 'C' ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT', 'CANCELLED'] : ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'])
        : isPendingTab
        ? ['PENDING']
        : undefined
      // CLOSED tab: серверная пагинация по 20. Сортировка по closedAt чтобы
      // страницы шли последовательно по дате выхода (иначе при разнице
      // openedAt vs closedAt порядок между страницами рассыпается).
      // Остальные вкладки — старый лимит 200, сортировка по openedAt по умолчанию.
      const tradesQuery = statusFilter === 'CLOSED'
        ? { status, limit: CLOSED_PAGE_SIZE, offset: (closedPage - 1) * CLOSED_PAGE_SIZE, orderBy: 'closedAt' as const }
        : { status, limit: 200 }
      const [c, sc, su, t, s, sigs] = await Promise.all([
        getBreakoutPaperConfig(variant),
        getBreakoutConfig(),
        getBreakoutSetups(),
        isSignalsTab ? Promise.resolve({ data: [], total: 0 }) : getBreakoutPaperTrades(tradesQuery, variant),
        getBreakoutPaperStats(variant),
        isSignalsTab
          ? getBreakoutSignals({ limit: SIGNALS_PAGE_SIZE, offset: (signalsPage - 1) * SIGNALS_PAGE_SIZE }, variant)
          : Promise.resolve({ data: [], total: 0 }),
      ])
      setConfig(c)
      // Initialize reset amount from server config on first load so the operator
      // sees the canonical starting deposit (variant-specific) in the input.
      setResetAmount(prev => (prev === (variant === 'A' ? 500 : 320) ? c.startingDepositUsd : prev))
      // Scanner has no UI toggle anymore — auto-enable if it's somehow off so
      // signals keep flowing. Only variant A may flip the shared flag.
      if (variant === 'A' && sc && !sc.enabled) {
        try {
          const fixed = await updateBreakoutConfig({ enabled: true })
          setScannerCfg(fixed)
        } catch {
          setScannerCfg(sc)
        }
      } else {
        setScannerCfg(sc)
      }
      setSetups(su.setups)
      setTrades(t.data)
      setTradesTotal(t.total)
      setStats(s)
      setSignals(sigs.data)
      setSignalsTotal(sigs.total)
      // Если активная вкладка — это OPEN, то t.data уже содержит открытые сделки
      // и отдельный запрос не нужен. Иначе делаем дополнительный fetch.
      // PENDING-сделки C не входят в "Открытые" — у них margin=0 и unrealized=0,
      // верхняя статистика их игнорирует.
      if (statusFilter === 'OPEN') {
        setOpenTradesAll(t.data)
      } else {
        try {
          const openOnly = await getBreakoutPaperTrades({ status: ['OPEN', 'TP1_HIT', 'TP2_HIT'], limit: 100 }, variant)
          setOpenTradesAll(openOnly.data)
        } catch { /* keep stale */ }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, closedPage, signalsPage, variant])

  useEffect(() => { loadAll() }, [loadAll])

  // Poll live prices every 3s. Раньше работал только на вкладке OPEN, но теперь
  // верхняя статистика "Депо с открытыми" нуждается в unrealized P&L на любой вкладке.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const controller = new AbortController()
      try {
        const data = await getBreakoutPaperLivePrices(controller.signal, variant)
        if (cancelled) return
        const map: Record<number, PaperTradeLive> = {}
        for (const p of data) map[p.id] = p
        setLivePrices(map)
      } catch {}
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [variant])

  const handleTogglePaperEnabled = async () => {
    if (!config) return
    const updated = await updateBreakoutPaperConfig({ enabled: !config.enabled }, variant)
    setConfig(updated)
  }

  const handleReset = async () => {
    if (!confirm(`Сбросить депо до $${resetAmount}? Все открытые позиции пометятся EXPIRED.`)) return
    const updated = await resetBreakoutPaper(resetAmount, variant)
    setConfig(updated)
    await loadAll()
  }

  const handleCloseAllMarket = async () => {
    const activeCount = openTradesAll.length
    if (activeCount === 0) {
      alert('Нет открытых сделок для закрытия.')
      return
    }
    if (!confirm(`Закрыть по рынку ВСЕ ${activeCount} активные сделки варианта ${variant}? Применится taker fee + slip.`)) return
    try {
      const r = await closeAllBreakoutPaperTradesMarket(variant)
      alert(`Закрыто: ${r.closed}${r.failed > 0 ? ` · не удалось: ${r.failed}` : ''}`)
      await loadAll()
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`)
    }
  }

  const handleWipeAll = async () => {
    const note = variant === 'B'
      ? 'УДАЛИТЬ все B-сделки и сбросить B-депо? Сигналы и A-сделки не трогаются.'
      : 'УДАЛИТЬ ВСЕ сигналы и paper-сделки? Это нельзя отменить.'
    if (!confirm(note)) return
    const r = await wipeAllBreakoutPaper(resetAmount, variant)
    setConfig(r.config)
    alert(`Удалено: ${r.deletedSignals} сигналов, ${r.deletedTrades} сделок. Депо: $${r.config.currentDepositUsd}`)
    await loadAll()
  }

  // Sort
  const sortedTrades = useMemo(() => {
    if (statusFilter === 'OPEN') return trades
    return [...trades].sort((a, b) => {
      const aKey = a.closedAt ? new Date(a.closedAt).getTime() : new Date(a.openedAt).getTime()
      const bKey = b.closedAt ? new Date(b.closedAt).getTime() : new Date(b.openedAt).getTime()
      return bKey - aKey
    })
  }, [trades, statusFilter])

  if (!config && loading) return <div className="text-text-secondary">Загрузка...</div>
  if (!config) {
    return (
      <div>
        <h1 className="text-2xl font-semibold mb-3">Daily Breakout</h1>
        <div className="bg-short/15 border border-short/30 text-short rounded p-3 mb-4">
          {error || 'Не удалось загрузить настройки. Возможно, миграция БД ещё не применена.'}
        </div>
        <button onClick={loadAll} className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">
          Повторить
        </button>
      </div>
    )
  }

  const returnPct = stats?.returnPct ?? 0
  const winRate = stats?.winRate ?? 0
  // openTradesAll грузится отдельно и не зависит от выбранной вкладки. На вкладке
  // "Открытые" он совпадает с trades. Используем его и для верхней статистики
  // (число открытых, маржа, unrealized P&L) — иначе на других вкладках цифры теряются.
  const openCount = openTradesAll.length
  const activeMarginUsd = openTradesAll.reduce((sum, t) => {
    const closedFrac = (t.closes ?? []).reduce((a, c) => a + c.percent, 0) / 100
    const remainingPos = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
    const lev = t.leverage && t.leverage > 0
      ? t.leverage
      : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
        ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
        : 1)
    return sum + remainingPos / lev
  }, 0)
  // Unrealized P&L по всем открытым сделкам — берём из livePrices (poll каждые 3с).
  // Если для какой-то сделки live цены ещё нет, её unrealized = 0 (не врём в плюс/минус).
  const unrealizedPnlUsd = openTradesAll.reduce((sum, t) => sum + (livePrices[t.id]?.unrealizedPnl ?? 0), 0)
  const equityWithOpen = config.currentDepositUsd + unrealizedPnlUsd

  // Диапазон 00:00–03:00 UTC в пражском времени (DST-aware через Intl).
  // Берём сегодняшнюю дату как референс — так смещение учитывает летнее/зимнее время.
  const pragueRange = (() => {
    const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false })
    const today = new Date()
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0))
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 3, 0, 0))
    return `${fmt.format(start)}–${fmt.format(end)} Прага`
  })()
  // symbolsEnabled может быть пустым массивом — тогда бэк использует DEFAULT_BREAKOUT_SETUPS,
  // которые приходят отдельным запросом через getBreakoutSetups() в `setups`.
  const enabledCoins = (scannerCfg?.symbolsEnabled?.length ?? 0) > 0
    ? scannerCfg!.symbolsEnabled.length
    : setups.length

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Daily Breakout
            {variant === 'B' && <span className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-accent/15 text-accent align-middle">B · 20 conc · 5% margin</span>}
            {variant === 'C' && <span className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-accent/15 text-accent align-middle">C · limit on rangeEdge</span>}
          </h1>
          <p className="text-sm text-text-secondary">
            Стратегия пробоя 3h-диапазона (00:00–03:00 UTC · {pragueRange}). {enabledCoins} {enabledCoins === 1 ? 'монета' : enabledCoins >= 2 && enabledCoins <= 4 ? 'монеты' : 'монет'} · виртуальная торговля + Telegram
            {variant === 'B' && <span className="ml-1">· копия B (тот же поток сигналов, увеличенная concurrency, уменьшенная маржа)</span>}
            {variant === 'C' && <span className="ml-1">· копия C (тот же поток сигналов, вход limit-ордером на rangeEdge — maker fee, без slip)</span>}
          </p>
          <button
            type="button"
            onClick={() => setShowAbout(v => !v)}
            className="mt-1 text-xs text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
          >
            <span>{showAbout ? '▼' : '▶'}</span>
            <span>{showAbout ? 'Скрыть описание стратегии' : 'Как работает стратегия и результаты бэктеста'}</span>
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={handleTogglePaperEnabled}
            className={`px-4 py-2 rounded font-medium ${config.enabled ? 'bg-long/15 text-long border border-long/30' : 'bg-card border border-input text-text-secondary'}`}>
            {config.enabled ? '● Демо вкл.' : '○ Демо выкл.'}
          </button>
          <button onClick={() => setShowSettings(s => !s)}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">
            ⚙ Настройки
          </button>
          <button onClick={handleCloseAllMarket}
            disabled={openTradesAll.length === 0}
            className="px-4 py-2 bg-card border border-accent/40 text-accent rounded font-medium hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed">
            ⊗ Закрыть все по рынку
          </button>
          <button onClick={handleWipeAll}
            className="px-4 py-2 bg-card border border-short/40 text-short rounded font-medium hover:bg-short/10">
            🗑 Очистить всё
          </button>
        </div>
      </div>

      {/* About strategy — раскрывающееся описание + бэктест.
          Variant-specific copy: A is the legacy prod config (10 conc, 10% margin,
          $500 depo); B is the alt experiment (20 conc, 5% margin, $320 depo).
          Strategy logic itself is identical — only sizing/concurrency differ. */}
      {showAbout && (
        <div className="bg-card border border-input rounded-lg p-5 mb-4 text-sm text-text-secondary leading-relaxed space-y-4">
          {variant === 'B' && (
            <div className="bg-accent/10 border border-accent/30 rounded p-3 text-text-primary text-xs">
              <span className="font-semibold">Копия B — экспериментальный sizing.</span> Та же стратегия и тот же поток сигналов
              что у копии A, но отдельный депозит, увеличенная concurrency и уменьшенная маржа на сделку. Параллельный
              live forward-test чтобы проверить backtest-результаты на реальном рынке.
            </div>
          )}
          {variant === 'C' && (
            <div className="bg-accent/10 border border-accent/30 rounded p-3 text-text-primary text-xs space-y-1">
              <div><span className="font-semibold">Копия C — limit-on-rangeEdge experimental.</span> Тот же поток сигналов
              что у A/B, но вход через <span className="text-accent">limit-ордер</span> ровно на rangeEdge (rangeHigh для LONG,
              rangeLow для SHORT) вместо market entry на c.close триггерной свечи.</div>
              <div>
                <span className="font-semibold">Зачем:</span> backtest 365d показал ×9-22 улучшение доходности vs market entry
                (A: $1142→$10221, B: $571→$12461). Maker fee 0.02% вместо taker 0.05%, без slip, entry точно на структурном
                уровне → больше плечо при том же риске → больше R/tr (+0.16 → +0.53).
              </div>
              <div className="text-text-secondary">
                <span className="font-semibold">Риск:</span> в реальной бирже maker fill rate может быть ниже backtest-предположения
                (на быстрых пробоях limit может остаться пустым). PENDING_LIMIT занимает concurrent slot — иначе при сигналах на
                всех 23 монетах сразу не хватит депо на fill. EOD незаполненные limit отменяются.
              </div>
            </div>
          )}
          <section>
            <h3 className="text-text-primary font-semibold mb-1">Идея</h3>
            <p>
              Первые 3 часа после полуночи UTC (00:00–03:00) формируют базовый <span className="text-text-primary">диапазон дня</span>:
              high и low этого окна — границы, от которых рынок будет отталкиваться или которые пробьёт. Стратегия
              ловит <span className="text-text-primary">пробой границ</span> на повышенном объёме как сигнал смены настроения. Логика консервативная:
              один сигнал на монету в сутки, expiry в 23:55 UTC, всё лишнее отсекается.
            </p>
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">Как работает (по шагам)</h3>
            <ol className="list-decimal list-inside space-y-1 marker:text-accent">
              <li>В 03:00 UTC фиксируется диапазон: <span className="text-text-primary">range_high</span> = max и <span className="text-text-primary">range_low</span> = min из 36 первых 5-минутных свечей дня.</li>
              <li>Дальше каждые 5 минут проверяется: <span className="text-long">LONG</span> если свеча пробила и закрылась выше rangeHigh, <span className="text-short">SHORT</span> — если пробила и закрылась ниже rangeLow.</li>
              <li>Объём текущей свечи должен быть <span className="text-text-primary">≥ 2× от среднего</span> предыдущих 24 баров (volume confirmation).</li>
              <li>Дополнительный фильтр режима: если на BTC 1h <span className="text-text-primary">ADX(14) ≤ 20</span> — рынок в боковике, тик пропускается целиком.</li>
              <li>Один пробой на монету в сутки. Expiry — 23:55 UTC, потом сделка закрывается по рынку.</li>
            </ol>
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">Параметры сделки</h3>
            <ul className="list-disc list-inside space-y-1 marker:text-accent">
              <li><span className="text-text-primary">Entry:</span> на границу range (rangeHigh для LONG, rangeLow для SHORT).
                {variant === 'C' && <span className="text-accent"> Limit-ордер, maker fee 0.02%, без slip — fill точно на уровне.</span>}
                {variant !== 'C' && <span> Market при пробое (taker 0.05% + slip 0.03%).</span>}
              </li>
              <li><span className="text-text-primary">Stop Loss:</span> противоположная граница диапазона.</li>
              <li><span className="text-text-primary">Take Profits:</span> entry ± 1×rangeSize, ±2×rangeSize, ±3×rangeSize.</li>
              <li><span className="text-text-primary">Splits:</span> 50% / 30% / 20% — закрытие по TP1 / TP2 / TP3.</li>
              <li><span className="text-text-primary">Trailing SL:</span> после TP1 → BE, после TP2 → TP1, после TP3 → TP2.</li>
              <li>
                <span className="text-text-primary">Risk:</span> 2% депо на сделку,
                {variant === 'A'
                  ? ' max 10 одновременных позиций (целевая маржа 10%).'
                  : ' max 20 одновременных позиций (целевая маржа 5%).'}
              </li>
            </ul>
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">Универс монет</h3>
            <p>
              {enabledCoins} монет, прошедших walk-forward отбор (TEST R/tr ≥ +0.20, TRAIN {'>'} 0,
              достаточно сделок в обоих периодах). Список обновлён 09.05.2026 после повторного прогона по 158 закешированным
              монетам Bybit — выбыли HYPE, XRP, SOL, AVAX, ARB, 1000PEPE, BLUR, SAND, ETC, IO, TSTBSC, STRK (провалили TEST на свежих данных),
              добавлены USELESS, SIREN, 1000BONK.
            </p>
            <p className="mt-1 text-xs">
              <span className="text-text-primary">BTC исключён</span> — слишком тихие диапазоны, edge -0.04 R/tr.
            </p>
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">
              Результаты бэктеста (365 дней, {enabledCoins} монет
              {variant === 'B' ? ', 20 conc, 5% margin' : ', 10 conc, 10% margin'})
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono border border-input">
                <thead className="bg-input text-text-secondary">
                  <tr>
                    <th className="text-left px-2 py-1">Период</th>
                    <th className="text-right px-2 py-1">Сделок</th>
                    <th className="text-right px-2 py-1">R/tr</th>
                    <th className="text-right px-2 py-1">FinalDepo ({variant === 'B' ? '$500' : '$500'})</th>
                    <th className="text-right px-2 py-1">Drawdown</th>
                    <th className="text-right px-2 py-1">WR</th>
                  </tr>
                </thead>
                <tbody>
                  {variant === 'B' ? (
                    <>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">FULL (365d)</td>
                        <td className="text-right px-2 py-1">1 634</td>
                        <td className="text-right px-2 py-1 text-long">+0.39</td>
                        <td className="text-right px-2 py-1 text-long">$35 198 (+6940%)</td>
                        <td className="text-right px-2 py-1 text-short">49.9%</td>
                        <td className="text-right px-2 py-1">52%</td>
                      </tr>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">TRAIN (60%)</td>
                        <td className="text-right px-2 py-1">1 308</td>
                        <td className="text-right px-2 py-1 text-long">+0.32</td>
                        <td className="text-right px-2 py-1 text-long">$16 095</td>
                        <td className="text-right px-2 py-1 text-short">49.9%</td>
                        <td className="text-right px-2 py-1">52%</td>
                      </tr>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">TEST (40% out-of-sample)</td>
                        <td className="text-right px-2 py-1">756</td>
                        <td className="text-right px-2 py-1 text-long">+0.49</td>
                        <td className="text-right px-2 py-1 text-long">$14 278</td>
                        <td className="text-right px-2 py-1">25.5%</td>
                        <td className="text-right px-2 py-1">55%</td>
                      </tr>
                    </>
                  ) : (
                    <>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">FULL (365d)</td>
                        <td className="text-right px-2 py-1">929</td>
                        <td className="text-right px-2 py-1 text-long">+0.30</td>
                        <td className="text-right px-2 py-1 text-long">$7,588 (+1418%)</td>
                        <td className="text-right px-2 py-1">29.9%</td>
                        <td className="text-right px-2 py-1">51%</td>
                      </tr>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">TRAIN (60%)</td>
                        <td className="text-right px-2 py-1">706</td>
                        <td className="text-right px-2 py-1 text-long">+0.23</td>
                        <td className="text-right px-2 py-1 text-long">$3,681</td>
                        <td className="text-right px-2 py-1">29.9%</td>
                        <td className="text-right px-2 py-1">51%</td>
                      </tr>
                      <tr className="border-t border-input">
                        <td className="px-2 py-1 text-text-primary">TEST (40% out-of-sample)</td>
                        <td className="text-right px-2 py-1">503</td>
                        <td className="text-right px-2 py-1 text-long">+0.32</td>
                        <td className="text-right px-2 py-1 text-long">$4,459</td>
                        <td className="text-right px-2 py-1">22.7%</td>
                        <td className="text-right px-2 py-1">55%</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs">
              Прогон 09.05.2026 на обновлённом универсе из {enabledCoins} монет
              {variant === 'B'
                ? ' (sizing: max 20 одновременных, target margin 5% депо). Числа в $500 эквиваленте — реальный B-депозит стартует с $320, абсолютные $ пропорционально меньше, R/tr и DD% не меняются.'
                : ' (sizing: max 10 одновременных, target margin 10% депо).'}
              {' '}Включён BTC ADX{'>'}20 фильтр и margin guard skip-only.
            </p>
            <p className="mt-1 text-xs">
              <span className="text-text-primary">TEST {'>'} TRAIN</span> по R/tr
              ({variant === 'B' ? '+0.49 vs +0.32' : '+0.32 vs +0.23'}) — стабильный out-of-sample edge,
              стратегия не переподогнана под историю.
            </p>
            {variant === 'B' && (
              <p className="mt-2 text-xs text-short">
                ⚠ Цена за рост upside: drawdown до 50% против 30% у A. Минимум депо в первый месяц −21% от старта
                (по бэктесту). Edge тонкий — slippage 0.15%+ убивает результат сильнее чем у A.
              </p>
            )}
          </section>

          {variant === 'A' ? (
            <section>
              <h3 className="text-text-primary font-semibold mb-1">Сравнение с другими стратегиями</h3>
              <p className="text-xs">
                На том же годе backtest (депо $500, риск 2%, max 10 concurrent) прогонялись 5 стратегий:
              </p>
              <ul className="list-disc list-inside space-y-0.5 marker:text-accent text-xs mt-1">
                <li><span className="text-long">Daily Breakout — единственная со стабильным walk-forward</span> (TRAIN +77%, TEST +57%, оба плюс).</li>
                <li>Levels v2 — TEST -63%, отвергнута.</li>
                <li>RSI 4h Mean Reversion — TEST -6%, отвергнута.</li>
                <li>EMA Pullback — TEST +50%, но TRAIN -39% (overfit).</li>
                <li>Funding Divergence — TEST -20%, отвергнута.</li>
              </ul>
            </section>
          ) : (
            <section>
              <h3 className="text-text-primary font-semibold mb-1">A vs B: что меняется</h3>
              <p className="text-xs">
                Та же стратегия, тот же поток сигналов, тот же универс монет. Разница только в sizing — это
                эксперимент: больше параллельных сделок размером поменьше.
              </p>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs font-mono border border-input">
                  <thead className="bg-input text-text-secondary">
                    <tr>
                      <th className="text-left px-2 py-1">Метрика (FULL 365d)</th>
                      <th className="text-right px-2 py-1">A: 10 conc, 10%</th>
                      <th className="text-right px-2 py-1">B: 20 conc, 5%</th>
                      <th className="text-right px-2 py-1">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-input">
                      <td className="px-2 py-1 text-text-primary">Сделок</td>
                      <td className="text-right px-2 py-1">929</td>
                      <td className="text-right px-2 py-1 text-long">1 634</td>
                      <td className="text-right px-2 py-1 text-long">+76%</td>
                    </tr>
                    <tr className="border-t border-input">
                      <td className="px-2 py-1 text-text-primary">R/tr</td>
                      <td className="text-right px-2 py-1">+0.30</td>
                      <td className="text-right px-2 py-1 text-long">+0.39</td>
                      <td className="text-right px-2 py-1 text-long">+0.09</td>
                    </tr>
                    <tr className="border-t border-input">
                      <td className="px-2 py-1 text-text-primary">FinalDepo ($500)</td>
                      <td className="text-right px-2 py-1">$7 588</td>
                      <td className="text-right px-2 py-1 text-long">$35 198</td>
                      <td className="text-right px-2 py-1 text-long">×4.6</td>
                    </tr>
                    <tr className="border-t border-input">
                      <td className="px-2 py-1 text-text-primary">Max Drawdown</td>
                      <td className="text-right px-2 py-1">29.9%</td>
                      <td className="text-right px-2 py-1 text-short">49.9%</td>
                      <td className="text-right px-2 py-1 text-short">+20 пп</td>
                    </tr>
                    <tr className="border-t border-input">
                      <td className="px-2 py-1 text-text-primary">Win Rate</td>
                      <td className="text-right px-2 py-1">51%</td>
                      <td className="text-right px-2 py-1">52%</td>
                      <td className="text-right px-2 py-1">+1 пп</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs">
                B обыгрывает A в 11 из 13 месяцев по абсолютному PnL. Но цена за upside — drawdown почти
                в 2× (до 50% от пика) и минимум депо ниже стартового в первый месяц на 21% (по бэктесту).
                Реалистичность чисел зависит от slippage — при 0.10–0.15% slip B страдает сильнее A.
              </p>
            </section>
          )}

          <section>
            <h3 className="text-text-primary font-semibold mb-1">По месяцам</h3>
            {variant === 'B' ? (
              <p className="text-xs">
                11 из 13 месяцев в плюс (как у A). Лучший: сентябрь 2025 (+1.18 R/tr, +$10 953 на 199 сделках —
                один большой импульсный месяц делает огромный вклад в финальный депозит). Убыточные те же что у A:
                февраль 2026 (-0.02) и неполный май 2026.
              </p>
            ) : (
              <p className="text-xs">
                11 из 13 месяцев в плюс. Лучший: сентябрь 2025 (+0.47 R/tr, 85 трейдов). Убыточные: февраль 2026 (-0.04)
                и апрель 2026 (-0.29) — рынок без чётких сессионных пробоев.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">Известные ограничения</h3>
            <ul className="list-disc list-inside space-y-0.5 marker:text-short text-xs">
              <li><span className="text-text-primary">Edge тонкий</span> — нужен большой N сделок, чтобы compound сработал. На коротком горизонте (1–2 мес) возможна просадка.</li>
              <li>
                <span className="text-text-primary">Slippage критичен:</span>
                {variant === 'B'
                  ? ' B чувствительнее A — больше сделок (1 634 vs 929) каждая платит slip. При 0.10% slip finalDepo падает до $9 676 ($26 236 при 0.05%).'
                  : ' 0.15%+ за сторону убивает edge в TEST. На реале использовать LIMIT ордера (maker fee).'}
              </li>
              <li>
                <span className="text-text-primary">Drawdown</span>
                {variant === 'B'
                  ? ' до 50% при cap=20 и риске 2% (до 40% депо в риске одновременно). Минимум депо в первый месяц −21% от старта.'
                  : ' до 33–40% при cap=10 и риске 2% (до 20% депо в риске одновременно).'}
              </li>
              <li><span className="text-text-primary">TP3 редко достигается</span> — большинство выходов через TP1/TP2, split structure это компенсирует.</li>
              <li>
                <span className="text-text-primary">
                  Concurrent cap = {variant === 'A' ? '10' : '20'}
                </span>
                {variant !== 'A'
                  ? ' — экспериментальная конфигурация. Backtest показал лучший R/tr и finalDepo чем у cap=10 на обновлённом 23-символьном универсе, но за счёт удвоенного DD. Forward-test проверяет реалистичность чисел в живом рынке.'
                  : ' — проверено backtest sweep [5/10/15/20/30/∞]: cap=10 даёт максимальный finalDepo на FULL/TRAIN/TEST.'}
              </li>
            </ul>
          </section>

          <section>
            <h3 className="text-text-primary font-semibold mb-1">Параметры платформы</h3>
            <ul className="list-disc list-inside space-y-0.5 text-xs marker:text-accent">
              <li>Стартовый депозит: ${variant === 'A' ? '500' : '320'}</li>
              <li>Риск на сделку: 2% от текущего депо</li>
              <li>Целевая маржа на сделку: {variant === 'A' ? '10%' : '5%'} (через margin guard skip-only)</li>
              <li>Round-trip комиссии: {variant === 'C' ? '0.04% (maker entry + maker TP fills)' : '0.08% (Bybit crypto)'}</li>
              <li>Дневной лимит убытка: 5%, недельный: 15%</li>
              <li>Max concurrent positions: {variant === 'A' ? '10' : '20'}, max per symbol: 1</li>
              {variant === 'C' && <li className="text-accent">Entry: limit-ордер на rangeEdge (PENDING_LIMIT занимает слот)</li>}
            </ul>
          </section>
        </div>
      )}

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <Stat label="Депозит" value={`$${config.currentDepositUsd.toFixed(2)}`}
          sub={`из $${config.startingDepositUsd}`} tone={config.currentDepositUsd >= config.startingDepositUsd ? 'long' : 'short'} />
        <Stat
          label="Депо с открытыми"
          value={`$${equityWithOpen.toFixed(2)}`}
          sub={openCount > 0
            ? `${unrealizedPnlUsd >= 0 ? '+' : ''}$${unrealizedPnlUsd.toFixed(2)} unrealized`
            : 'нет открытых'}
          tone={equityWithOpen >= config.startingDepositUsd ? 'long' : 'short'}
        />
        <Stat label="Доходность" value={`${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`}
          tone={returnPct > 0 ? 'long' : returnPct < 0 ? 'short' : 'neutral'} />
        <Stat label="Total P&L" value={fmtUsd(config.totalPnLUsd)}
          tone={config.totalPnLUsd > 0 ? 'long' : config.totalPnLUsd < 0 ? 'short' : 'neutral'} />
        <Stat label="Win Rate" value={`${(winRate * 100).toFixed(0)}%`}
          sub={`${config.totalWins}W / ${config.totalLosses}L`} />
        <Stat label="Открытых" value={openCount.toString()}
          sub={openCount > 0 ? `маржа $${activeMarginUsd.toFixed(2)} · Max DD ${config.maxDrawdownPct.toFixed(1)}%` : `Max DD ${config.maxDrawdownPct.toFixed(1)}%`} />
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-card border border-input rounded p-4 mb-4">
          <h3 className="font-semibold mb-3">Настройки демо-счёта</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-text-secondary block mb-1">Риск на сделку (%)</label>
              <input type="number" step="0.1" min="0.1" max="10" defaultValue={config.riskPctPerTrade}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v > 0 && v <= 10) setConfig(await updateBreakoutPaperConfig({ riskPctPerTrade: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Taker fee (%) <span className="text-text-secondary/60">— market open + SL</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.feeTakerPct ?? 0.05}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ feeTakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Maker fee (%) <span className="text-text-secondary/60">— TP limit</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.feeMakerPct ?? 0.02}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ feeMakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Slippage taker (%/side) <span className="text-text-secondary/60">— market fills</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.slipTakerPct ?? 0.03}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ slipTakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Max одновременных позиций</label>
              <input type="number" step="1" min="1" max="50" defaultValue={config.maxConcurrentPositions}
                onBlur={async e => {
                  const v = parseInt(e.target.value, 10)
                  if (v > 0 && v <= 50) setConfig(await updateBreakoutPaperConfig({ maxConcurrentPositions: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="autoTrailing" checked={config.autoTrailingSL}
                onChange={async e => setConfig(await updateBreakoutPaperConfig({ autoTrailingSL: e.target.checked }, variant))} />
              <label htmlFor="autoTrailing" className="text-sm">Авто-трейлинг SL (TP1→BE, TP2→TP1)</label>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-input flex items-center gap-3">
            <input type="number" value={resetAmount}
              onChange={e => setResetAmount(parseFloat(e.target.value) || 500)}
              className="w-32 bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            <button onClick={handleReset}
              className="px-4 py-2 bg-card border border-accent/40 text-accent rounded font-medium hover:bg-accent/10">
              Сбросить депо
            </button>
          </div>
          {setups.length > 0 && (
            <div className="mt-4 pt-4 border-t border-input">
              <div className="text-xs text-text-secondary mb-2">Активные инструменты ({setups.length}):</div>
              <div className="flex flex-wrap gap-2">
                {setups.map(s => (
                  <span key={s} className="px-2 py-1 rounded bg-input text-xs font-mono text-text-primary">{s.replace('USDT', '')}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Status filter — variant C показывает "Pending" (висящие limit'ы)
          вместо "Сигналы" (для C signal feed избыточен — лимитки ставятся
          пре-эмптивно на каждый range без привязки к сигналу). */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => { setClosedPage(1); setSignalsPage(1); setStatusFilter('OPEN') }}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => { setClosedPage(1); setSignalsPage(1); setStatusFilter('CLOSED') }}>Закрытые</FilterButton>
        {variant === 'C' ? (
          <FilterButton active={statusFilter === 'PENDING'} onClick={() => { setClosedPage(1); setSignalsPage(1); setStatusFilter('PENDING') }}>Pending</FilterButton>
        ) : (
          <FilterButton active={statusFilter === 'SIGNALS'} onClick={() => { setClosedPage(1); setSignalsPage(1); setStatusFilter('SIGNALS') }}>Сигналы</FilterButton>
        )}
      </div>

      {/* Signals table (only when SIGNALS filter is active) */}
      {statusFilter === 'SIGNALS' && (
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
                    : s.paperStatus === 'SKIPPED' ? '✕ Skip' : '—'
                  const hist = stats?.bySymbol?.[s.symbol]
                  const histWr = hist && hist.trades > 0 ? Math.round((hist.wins / hist.trades) * 100) : null
                  const histPnlCls = !hist ? 'text-text-secondary'
                    : hist.pnl > 0 ? 'text-long'
                    : hist.pnl < 0 ? 'text-short' : 'text-text-secondary'
                  // Status column: variant A uses the shared signal status (canonical).
                  // Variant B uses its own trade's status when present (the shared status
                  // reflects A's view, which is misleading on the B tab). If B has no
                  // trade for this signal, show a neutral "—" instead of A's status.
                  const showSelfTradeStatus = variant === 'B' && s._tradeStatus
                  const statusForBadge = showSelfTradeStatus ? s._tradeStatus! : s.status
                  const statusPnl = showSelfTradeStatus ? (s._tradeRealizedR ?? 0) : s.realizedR
                  const showNoTradePlaceholder = variant === 'B' && !s._tradeStatus
                  return (
                    <tr
                      key={s.id}
                      className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
                      onClick={() => setSelectedSignal(s)}
                    >
                      <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{formatDate(s.createdAt)}</td>
                      <td className="px-3 py-2 text-text-secondary font-mono">{s.rangeDate}</td>
                      <td className={`px-3 py-2 font-mono font-medium ${sideColorCls}`}>{s.symbol.replace('USDT', '')}</td>
                      <td className={`px-3 py-2 font-mono text-[11px] whitespace-nowrap ${histPnlCls}`}>
                        {hist
                          ? <>{hist.trades}tr · {hist.pnl >= 0 ? '+' : ''}{hist.pnl.toFixed(2)}$ · WR {histWr}%</>
                          : <span className="text-text-secondary">—</span>}
                      </td>
                      <td className={`px-3 py-2 text-center font-mono ${sideColorCls}`}>{s.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                      <td className="px-3 py-2 text-right font-mono">${fmtPrice(s.entryPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono text-short">${fmtPrice(s.initialStop)}</td>
                      <td className="px-3 py-2 text-right font-mono">{volRatio.toFixed(2)}×</td>
                      <td className="px-3 py-2 text-center">
                        {showNoTradePlaceholder
                          ? <span className="text-text-secondary text-[11px]">не открыто</span>
                          : <PaperStatusBadge status={statusForBadge} pnl={statusPnl} closes={s.closes} />}
                      </td>
                      <td className={`px-3 py-2 text-center font-mono ${paperColor}`}>{paperLabel}</td>
                      <td className="px-3 py-2 text-text-secondary text-[11px] max-w-[280px] truncate" title={s.paperReason ?? ''}>
                        {s.paperReason ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {signalsTotal > SIGNALS_PAGE_SIZE && (() => {
            const totalPages = Math.ceil(signalsTotal / SIGNALS_PAGE_SIZE)
            const from = (signalsPage - 1) * SIGNALS_PAGE_SIZE + 1
            const to = Math.min(signalsPage * SIGNALS_PAGE_SIZE, signalsTotal)
            return (
              <div className="flex items-center justify-between px-3 py-2 border-t border-input text-xs text-text-secondary">
                <div>{from}–{to} из {signalsTotal}</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSignalsPage(p => Math.max(1, p - 1))}
                    disabled={signalsPage === 1 || loading}
                    className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                  >‹ Назад</button>
                  <span className="font-mono">{signalsPage} / {totalPages}</span>
                  <button
                    onClick={() => setSignalsPage(p => Math.min(totalPages, p + 1))}
                    disabled={signalsPage >= totalPages || loading}
                    className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                  >Вперёд ›</button>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Pending table — только для variant C: висящие limit-ордера на rangeEdge
          до пробоя. Пары BUY+SELL по одной монете схлопнуты в одну строку через
          pairOrderId, чтобы не дублировать ту же монету дважды. */}
      {statusFilter === 'PENDING' && variant === 'C' && (() => {
        // Группируем PENDING-сделки по символу: если есть пара (BUY @ rangeHigh +
        // SELL @ rangeLow), показываем одну строку с обеими сторонами. Одинокий
        // limit (только одна сторона была размещена из-за price-guard) идёт
        // отдельной строкой.
        type PendingPair = { symbol: string; placedAt: string; buy?: PaperTrade; sell?: PaperTrade }
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
        return (
          <div className="bg-card border border-input rounded overflow-hidden mb-6">
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
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={6} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
                  {!loading && pairs.length === 0 && (
                    <tr><td colSpan={6} className="text-center py-12 text-text-secondary">
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
                    return (
                      <tr
                        key={p.symbol}
                        className="border-t border-input hover:bg-input/50 transition-colors cursor-pointer"
                        onClick={() => {
                          // Откроем график по любой из сторон (одинаковый range).
                          const ref = p.buy ?? p.sell!
                          setChartTrade(ref)
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
                          {p.buy ? <span className="text-long">${fmtPrice(p.buy.entryPrice)}</span> : <span className="text-text-secondary">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {p.sell ? <span className="text-short">${fmtPrice(p.sell.entryPrice)}</span> : <span className="text-text-secondary">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-text-secondary">
                          {rangePct != null ? `${rangePct.toFixed(2)}%` : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent/80 whitespace-nowrap">
                            {both ? '⏳ BUY + SELL' : p.buy ? '⏳ BUY only' : '⏳ SELL only'}
                          </span>
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
      })()}

      {/* Mobile trade cards (< 640px) */}
      {statusFilter !== 'SIGNALS' && statusFilter !== 'PENDING' && (
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
          const isOpen = ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)
          const closedFrac = (t.closes ?? []).reduce((a, c) => a + c.percent, 0) / 100
          const remainingPositionUsd = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
          const tps = (t.tpLadder ?? []).slice(0, 3)
          const sideColorCls = t.side === 'BUY' ? 'text-long' : 'text-short'
          const isFinished = ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'].includes(t.status)
          const pnl = isOpen && live
            ? (live.remainingUnrealizedPnl ?? live.unrealizedPnl)
            : t.netPnlUsd
          const pnlPct = isOpen && live
            ? (live.remainingUnrealizedPnlPct ?? live.unrealizedPnlPct)
            : (t.depositAtEntryUsd > 0 ? (t.netPnlUsd / t.depositAtEntryUsd) * 100 : 0)
          const lev = t.leverage && t.leverage > 0
            ? t.leverage
            : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
              ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
              : 1)
          const marginFull = t.marginUsd ?? (t.positionSizeUsd / lev)
          const marginRemaining = remainingPositionUsd / lev
          const displayMargin = isFinished ? marginFull : marginRemaining
          return (
            <div
              key={t.id}
              className="bg-card border border-input rounded p-3 active:bg-input/40 transition-colors cursor-pointer"
              onClick={() => setSelectedTrade(t)}
            >
              {/* Row 1: ticker + chart icon · status */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 font-mono">
                  <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent">D</span>
                  {t.status === 'PENDING' && (
                    <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/10 text-accent/80">⏳</span>
                  )}
                  <span className={`${sideColorCls} font-semibold text-base`}>{t.symbol.replace('USDT', '')}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setChartTrade(t) }}
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
                  <span className="text-text-primary">${fmtPrice(t.entryPrice)}</span>
                </div>
                {isOpen && live?.currentPrice != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2" title="Live цена">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-long opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-long" />
                    </span>
                    <span className={pnlColor(live.unrealizedPnl)}>${fmtPrice(live.currentPrice)}</span>
                  </div>
                )}
              </div>

              {/* Row 4: progress bar (only if open) */}
              {isOpen && statusFilter !== 'CLOSED' && (
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
        {/* Pagination on mobile — same logic as table */}
        {statusFilter === 'CLOSED' && tradesTotal > CLOSED_PAGE_SIZE && (() => {
          const totalPages = Math.ceil(tradesTotal / CLOSED_PAGE_SIZE)
          const from = (closedPage - 1) * CLOSED_PAGE_SIZE + 1
          const to = Math.min(closedPage * CLOSED_PAGE_SIZE, tradesTotal)
          return (
            <div className="flex items-center justify-between px-3 py-2 bg-card border border-input rounded text-xs text-text-secondary">
              <div>{from}–{to} из {tradesTotal}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setClosedPage(p => Math.max(1, p - 1))}
                  disabled={closedPage === 1 || loading}
                  className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                >‹</button>
                <span className="font-mono">{closedPage} / {totalPages}</span>
                <button
                  onClick={() => setClosedPage(p => Math.min(totalPages, p + 1))}
                  disabled={closedPage >= totalPages || loading}
                  className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                >›</button>
              </div>
            </div>
          )
        })()}
      </div>
      )}

      {/* Trades table (>= 640px) */}
      {statusFilter !== 'SIGNALS' && statusFilter !== 'PENDING' && (
      <div className="hidden sm:block bg-card border border-input rounded overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-input text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Дата</th>
                <th className="text-left px-3 py-2">⏱</th>
                <th className="text-left px-3 py-2">Монета</th>
                <th className="text-right px-3 py-2">Вход</th>
                {statusFilter !== 'CLOSED' && <th className="text-right px-3 py-2">Цена</th>}
                <th className="text-right px-3 py-2">Маржа</th>
                <th className="text-center px-3 py-2" title="Рекомендуемое плечо">Плечо</th>
                <th className="text-right px-3 py-2">Размер</th>
                {statusFilter !== 'CLOSED' && <th className="text-center px-3 py-2" title="Где цена между SL и ближайшим живым TP">Прогресс</th>}
                {statusFilter !== 'CLOSED' && <th className="text-right px-3 py-2">Рлз.</th>}
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
                const isOpen = ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)
                const closedFrac = (t.closes ?? []).reduce((a, c) => a + c.percent, 0) / 100
                const remainingPositionUsd = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
                const displayPnl = isOpen && live ? live.unrealizedPnl : t.netPnlUsd
                const displayPnlPct = isOpen && live
                  ? live.unrealizedPnlPct
                  : (t.depositAtEntryUsd > 0 ? (t.netPnlUsd / t.depositAtEntryUsd) * 100 : 0)
                const tps = (t.tpLadder ?? []).slice(0, 3)
                const sideColorCls = t.side === 'BUY' ? 'text-long' : 'text-short'
                const closedPctNum = Math.round(closedFrac * 100)
                const isFinished = ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'].includes(t.status)
                const lev = t.leverage && t.leverage > 0
                  ? t.leverage
                  : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
                    ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
                    : 1)
                const marginFull = t.marginUsd ?? (t.positionSizeUsd / lev)
                const marginRemaining = remainingPositionUsd / lev

                return (
                  <tr
                    key={t.id}
                    className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
                    onClick={() => setSelectedTrade(t)}
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
                        {t.status === 'PENDING' && (
                          <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-accent/10 text-accent/80" title="Limit ордер ждёт fill на rangeEdge">⏳</span>
                        )}
                        <span className={sideColorCls}>{t.symbol.replace('USDT', '')}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setChartTrade(t) }}
                          className="text-text-secondary hover:text-accent transition-colors"
                          title="График позиции"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                        </button>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-primary">${fmtPrice(t.entryPrice)}</td>
                    {statusFilter !== 'CLOSED' && (
                      <td className="px-3 py-2 text-right font-mono">
                        {isOpen && live?.currentPrice != null ? (
                          <span className={pnlColor(live.unrealizedPnl)}>${fmtPrice(live.currentPrice)}</span>
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
                    {statusFilter !== 'CLOSED' && (
                      <td className="px-3 py-2 align-middle">
                        <TradeProgressBar trade={t} live={live} tps={tps} />
                      </td>
                    )}
                    {statusFilter !== 'CLOSED' && (
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
        {/* Pagination — только для вкладки Закрытые (там часто > 20 записей) */}
        {statusFilter === 'CLOSED' && tradesTotal > CLOSED_PAGE_SIZE && (() => {
          const totalPages = Math.ceil(tradesTotal / CLOSED_PAGE_SIZE)
          const from = (closedPage - 1) * CLOSED_PAGE_SIZE + 1
          const to = Math.min(closedPage * CLOSED_PAGE_SIZE, tradesTotal)
          return (
            <div className="flex items-center justify-between px-3 py-2 border-t border-input text-xs text-text-secondary">
              <div>{from}–{to} из {tradesTotal}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setClosedPage(p => Math.max(1, p - 1))}
                  disabled={closedPage === 1 || loading}
                  className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                >‹ Назад</button>
                <span className="font-mono">{closedPage} / {totalPages}</span>
                <button
                  onClick={() => setClosedPage(p => Math.min(totalPages, p + 1))}
                  disabled={closedPage >= totalPages || loading}
                  className="px-2 py-1 rounded bg-input hover:bg-input/70 disabled:opacity-40 disabled:cursor-not-allowed"
                >Вперёд ›</button>
              </div>
            </div>
          )
        })()}
      </div>
      )}

      {/* Per-symbol breakdown */}
      {stats && Object.keys(stats.bySymbol).length > 0 && (
        <div className="mb-6">
          <button
            type="button"
            onClick={() => setShowBySymbol(v => !v)}
            className="flex items-center gap-2 font-semibold mb-2 hover:text-accent transition-colors"
          >
            <span className="text-text-secondary text-xs">{showBySymbol ? '▼' : '▶'}</span>
            По инструментам
            <span className="text-text-secondary font-normal">
              · {Object.keys(stats.bySymbol).length}
            </span>
          </button>
          {showBySymbol && (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {Object.entries(stats.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, s]) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => setSymbolHistory(sym)}
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
      )}

      {/* Equity curve */}
      {stats && stats.equityCurve.length > 0 && (() => {
        const curve = stats.equityCurve
        const startEquity = config.startingDepositUsd
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
      })()}

      {selectedTrade && (
        <BreakoutPaperTradeModal
          trade={selectedTrade}
          live={livePrices[selectedTrade.id] ?? null}
          variant={variant}
          onClose={() => setSelectedTrade(null)}
          onUpdate={(updated) => {
            setSelectedTrade(updated)
            setTrades(prev => prev.map(t => t.id === updated.id ? updated : t))
          }}
          onDelete={(id) => {
            setSelectedTrade(null)
            setTrades(prev => prev.filter(t => t.id !== id))
          }}
        />
      )}

      {chartTrade && (
        <PositionChartModal
          position={paperTradeToPosition(chartTrade, livePrices[chartTrade.id]?.currentPrice ?? null)}
          onClose={() => setChartTrade(null)}
        />
      )}

      {selectedSignal && (
        <BreakoutSignalModal
          signal={selectedSignal}
          variant={variant}
          onClose={() => setSelectedSignal(null)}
          onForceOpened={() => { loadAll() }}
        />
      )}

      {symbolHistory && (
        <SymbolHistoryModal
          symbol={symbolHistory}
          variant={variant}
          onClose={() => setSymbolHistory(null)}
          onSelectTrade={(t) => {
            setSymbolHistory(null)
            setSelectedTrade(t)
          }}
        />
      )}
    </div>
  )
}
