import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getBreakoutPaperConfig, updateBreakoutPaperConfig, resetBreakoutPaper,
  getBreakoutPaperTrades, getBreakoutPaperStats, runBreakoutPaperCycleNow,
  getBreakoutPaperLivePrices, wipeAllBreakoutPaper,
  getBreakoutConfig, updateBreakoutConfig, scanBreakoutNow, getBreakoutSetups,
  getBreakoutSignals,
  type BreakoutPaperConfig as PaperConfig,
  type BreakoutTrade as PaperTrade,
  type BreakoutStats as PaperStats,
  type BreakoutTradeLive as PaperTradeLive,
  type BreakoutConfig as ScannerCfg,
  type BreakoutSignal,
} from '../api/breakoutPaper'
import BreakoutPaperTradeModal from '../components/BreakoutPaperTradeModal'
import BreakoutSignalModal from '../components/BreakoutSignalModal'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
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

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL' | 'SIGNALS'

const PAPER_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  OPEN:    { bg: 'bg-accent/15',     text: 'text-accent',     label: 'Открыта' },
  TP1_HIT: { bg: 'bg-long/10',       text: 'text-long',       label: 'TP1 ✓' },
  TP2_HIT: { bg: 'bg-long/15',       text: 'text-long',       label: 'TP2 ✓' },
  TP3_HIT: { bg: 'bg-long/20',       text: 'text-long',       label: 'TP3 ✓' },
  CLOSED:  { bg: 'bg-long/10',       text: 'text-long',       label: 'Закрыта' },
  SL_HIT:  { bg: 'bg-short/15',      text: 'text-short',      label: 'SL' },
  EXPIRED: { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Истёк' },
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

export default function BreakoutPaper() {
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [resetAmount, setResetAmount] = useState(500)
  const [cycleRunning, setCycleRunning] = useState(false)
  const [scanRunning, setScanRunning] = useState(false)
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})
  const [selectedTrade, setSelectedTrade] = useState<PaperTrade | null>(null)
  const [chartTrade, setChartTrade] = useState<PaperTrade | null>(null)
  const [signals, setSignals] = useState<BreakoutSignal[]>([])
  const [selectedSignal, setSelectedSignal] = useState<BreakoutSignal | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const isSignalsTab = statusFilter === 'SIGNALS'
      const status = statusFilter === 'OPEN' ? ['OPEN', 'TP1_HIT', 'TP2_HIT']
                   : statusFilter === 'CLOSED' ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT']
                   : undefined
      // CLOSED tab: серверная пагинация по 20. Сортировка по closedAt чтобы
      // страницы шли последовательно по дате выхода (иначе при разнице
      // openedAt vs closedAt порядок между страницами рассыпается).
      // Остальные вкладки — старый лимит 200, сортировка по openedAt по умолчанию.
      const tradesQuery = statusFilter === 'CLOSED'
        ? { status, limit: CLOSED_PAGE_SIZE, offset: (closedPage - 1) * CLOSED_PAGE_SIZE, orderBy: 'closedAt' as const }
        : { status, limit: 200 }
      const [c, sc, su, t, s, sigs] = await Promise.all([
        getBreakoutPaperConfig(),
        getBreakoutConfig(),
        getBreakoutSetups(),
        isSignalsTab ? Promise.resolve({ data: [], total: 0 }) : getBreakoutPaperTrades(tradesQuery),
        getBreakoutPaperStats(),
        isSignalsTab ? getBreakoutSignals({ limit: 200 }) : Promise.resolve({ data: [], total: 0 }),
      ])
      setConfig(c)
      setScannerCfg(sc)
      setSetups(su.setups)
      setTrades(t.data)
      setTradesTotal(t.total)
      setStats(s)
      setSignals(sigs.data)
      // Если активная вкладка — это OPEN, то t.data уже содержит открытые сделки
      // и отдельный запрос не нужен. Иначе делаем дополнительный fetch.
      if (statusFilter === 'OPEN') {
        setOpenTradesAll(t.data)
      } else {
        try {
          const openOnly = await getBreakoutPaperTrades({ status: ['OPEN', 'TP1_HIT', 'TP2_HIT'], limit: 100 })
          setOpenTradesAll(openOnly.data)
        } catch { /* keep stale */ }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, closedPage])

  useEffect(() => { loadAll() }, [loadAll])

  // Poll live prices every 3s. Раньше работал только на вкладке OPEN, но теперь
  // верхняя статистика "Депо с открытыми" нуждается в unrealized P&L на любой вкладке.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const controller = new AbortController()
      try {
        const data = await getBreakoutPaperLivePrices(controller.signal)
        if (cancelled) return
        const map: Record<number, PaperTradeLive> = {}
        for (const p of data) map[p.id] = p
        setLivePrices(map)
      } catch {}
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const handleTogglePaperEnabled = async () => {
    if (!config) return
    const updated = await updateBreakoutPaperConfig({ enabled: !config.enabled })
    setConfig(updated)
  }

  const handleToggleScannerEnabled = async () => {
    if (!scannerCfg) return
    const updated = await updateBreakoutConfig({ enabled: !scannerCfg.enabled })
    setScannerCfg(updated)
  }

  const handleRunCycle = async () => {
    setCycleRunning(true)
    try {
      await runBreakoutPaperCycleNow()
      await loadAll()
    } finally { setCycleRunning(false) }
  }

  const handleScanNow = async () => {
    setScanRunning(true)
    try {
      await scanBreakoutNow()
      await loadAll()
    } finally { setScanRunning(false) }
  }

  const handleReset = async () => {
    if (!confirm(`Сбросить депо до $${resetAmount}? Все открытые позиции пометятся EXPIRED.`)) return
    const updated = await resetBreakoutPaper(resetAmount)
    setConfig(updated)
    await loadAll()
  }

  const handleWipeAll = async () => {
    if (!confirm('УДАЛИТЬ ВСЕ сигналы и paper-сделки? Это нельзя отменить.')) return
    const r = await wipeAllBreakoutPaper(resetAmount)
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Daily Breakout</h1>
          <p className="text-sm text-text-secondary">
            Стратегия пробоя 3h-диапазона (00:00–03:00 UTC). 11 монет · виртуальная торговля + Telegram
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={handleScanNow} disabled={scanRunning}
            className="px-4 py-2 bg-accent text-bg-primary rounded font-medium hover:opacity-90 disabled:opacity-50">
            {scanRunning ? 'Сканирую...' : 'Скан сейчас'}
          </button>
          <button onClick={handleRunCycle} disabled={cycleRunning}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input disabled:opacity-50">
            {cycleRunning ? 'Обновляю...' : 'Обновить демо'}
          </button>
          <button onClick={handleTogglePaperEnabled}
            className={`px-4 py-2 rounded font-medium ${config.enabled ? 'bg-long/15 text-long border border-long/30' : 'bg-card border border-input text-text-secondary'}`}>
            {config.enabled ? '● Демо вкл.' : '○ Демо выкл.'}
          </button>
          <button onClick={handleToggleScannerEnabled}
            className={`px-4 py-2 rounded font-medium ${scannerCfg?.enabled ? 'bg-long/15 text-long border border-long/30' : 'bg-card border border-input text-text-secondary'}`}>
            {scannerCfg?.enabled ? '● Сканер вкл.' : '○ Сканер выкл.'}
          </button>
          <button onClick={() => setShowSettings(s => !s)}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">
            ⚙ Настройки
          </button>
          <button onClick={handleWipeAll}
            className="px-4 py-2 bg-card border border-short/40 text-short rounded font-medium hover:bg-short/10">
            🗑 Очистить всё
          </button>
        </div>
      </div>

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
                  if (v > 0 && v <= 10) setConfig(await updateBreakoutPaperConfig({ riskPctPerTrade: v }))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Комиссии round-trip (%)</label>
              <input type="number" step="0.01" min="0" defaultValue={config.feesRoundTripPct}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ feesRoundTripPct: v }))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Max одновременных позиций</label>
              <input type="number" step="1" min="1" max="50" defaultValue={config.maxConcurrentPositions}
                onBlur={async e => {
                  const v = parseInt(e.target.value, 10)
                  if (v > 0 && v <= 50) setConfig(await updateBreakoutPaperConfig({ maxConcurrentPositions: v }))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="autoTrailing" checked={config.autoTrailingSL}
                onChange={async e => setConfig(await updateBreakoutPaperConfig({ autoTrailingSL: e.target.checked }))} />
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

      {/* Status filter */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => { setClosedPage(1); setStatusFilter('OPEN') }}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => { setClosedPage(1); setStatusFilter('CLOSED') }}>Закрытые</FilterButton>
        <FilterButton active={statusFilter === 'ALL'} onClick={() => { setClosedPage(1); setStatusFilter('ALL') }}>Все</FilterButton>
        <FilterButton active={statusFilter === 'SIGNALS'} onClick={() => { setClosedPage(1); setStatusFilter('SIGNALS') }}>Сигналы</FilterButton>
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
                      <td className="px-3 py-2 text-center"><PaperStatusBadge status={s.status} pnl={s.realizedR} closes={s.closes} /></td>
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
        </div>
      )}

      {/* Trades table */}
      {statusFilter !== 'SIGNALS' && (
      <div className="bg-card border border-input rounded overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-input text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Дата</th>
                <th className="text-left px-3 py-2">⏱</th>
                <th className="text-left px-3 py-2">Монета</th>
                <th className="text-right px-3 py-2">Вход</th>
                {statusFilter !== 'CLOSED' && <th className="text-right px-3 py-2">Цена</th>}
                <th className="text-right px-3 py-2">Размер</th>
                <th className="text-right px-3 py-2">Маржа</th>
                <th className="text-right px-3 py-2">SL</th>
                <th className="text-right px-3 py-2">TP</th>
                {statusFilter !== 'CLOSED' && <th className="text-right px-3 py-2">Рлз.</th>}
                <th className="text-right px-3 py-2">P&L</th>
                <th className="text-center px-3 py-2">Статус</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={12} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
              {!loading && trades.length === 0 && (
                <tr><td colSpan={12} className="text-center py-12 text-text-secondary">
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
                const slDir = t.side === 'BUY' ? 1 : -1
                const slPct = ((t.currentStop - t.entryPrice) / t.entryPrice) * 100 * slDir
                const tps = (t.tpLadder ?? []).slice(0, 3)
                const lastTp = tps.length > 0 ? tps[tps.length - 1] : null
                const tpDir = t.side === 'BUY' ? 1 : -1
                const tpPct = lastTp != null ? ((lastTp - t.entryPrice) / t.entryPrice) * 100 * tpDir : null
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
                        <span className="text-text-secondary">${fmt2(t.positionSizeUsd)}</span>
                      ) : (
                        <>
                          <span className="text-text-primary">${fmt2(remainingPositionUsd)}</span>
                          {closedPctNum > 0 && closedPctNum < 100 && (
                            <div className="text-[10px] text-text-secondary">было ${fmt2(t.positionSizeUsd)}</div>
                          )}
                        </>
                      )}
                      {t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0 && (
                        <div className="text-[10px] text-accent/80" title="Рекомендуемое плечо">×{lev.toFixed(1)}</div>
                      )}
                    </td>
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
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      <span className="text-short">${fmtPrice(t.currentStop)}</span>
                      <div className="text-[10px] text-short/70">{fmt2(slPct)}%</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      {lastTp != null && tpPct != null ? (
                        <>
                          <span className="text-long">${fmtPrice(lastTp)}</span>
                          <div className="text-[10px] text-long/70">+{fmt2(tpPct)}%</div>
                        </>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
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
          <h3 className="font-semibold mb-2">По инструментам</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {Object.entries(stats.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, s]) => (
              <div key={sym} className="bg-card border border-input rounded p-2 text-xs">
                <div className="font-medium text-text-primary">{sym}</div>
                <div className="text-text-secondary">{s.trades} {s.trades === 1 ? 'trade' : 'trades'}</div>
                <div className={pnlColor(s.pnl)}>{fmt2Signed(s.pnl)}$</div>
                <div className="text-text-secondary">
                  {s.trades > 0 ? `WR ${((s.wins / s.trades) * 100).toFixed(0)}%` : 'WR —'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Equity curve */}
      {stats && stats.equityCurve.length > 0 && (
        <div className="mb-6">
          <h3 className="font-semibold mb-2">Кривая капитала</h3>
          <div className="bg-card border border-input rounded p-3 overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead className="text-text-secondary text-xs">
                <tr>
                  <th className="text-left">Дата</th>
                  <th className="text-right">P&L дня</th>
                  <th className="text-right">Депозит</th>
                </tr>
              </thead>
              <tbody>
                {stats.equityCurve.slice(-30).reverse().map(p => (
                  <tr key={p.date}>
                    <td className="text-text-secondary py-1">{p.date}</td>
                    <td className={`text-right py-1 ${p.pnl > 0 ? 'text-long' : p.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                      {fmt2Signed(p.pnl)}$
                    </td>
                    <td className="text-right py-1">${p.equity.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedTrade && (
        <BreakoutPaperTradeModal
          trade={selectedTrade}
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
          onClose={() => setSelectedSignal(null)}
          onForceOpened={() => { loadAll() }}
        />
      )}
    </div>
  )
}
