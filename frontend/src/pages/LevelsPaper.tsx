import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getPaperConfig, updatePaperConfig, resetPaper,
  getPaperTrades, getPaperStats, runPaperCycleNow,
  getPaperLivePrices, wipeAllPaper,
  type PaperConfig, type PaperTrade, type PaperStats, type PaperTradeLive,
} from '../api/levelsPaper'
import {
  getLevelsSignals, getLevelsConfig, updateLevelsConfig,
  scanLevelsNow, trackLevelsNow, getKeyLevels,
  type LevelsSignal, type LevelsStatus, type LevelsConfig as LevelsCfg, type LevelsSetup,
  type KeyLevelDto,
} from '../api/levels'
import PaperTradeModal from '../components/PaperTradeModal'
import LevelsSignalModal from '../components/LevelsSignalModal'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import { formatDate, pnlColor, fmt2, fmt2Signed, fmtPrice as fmtPriceShared } from '../lib/formatters'

function paperTradeToPosition(
  t: PaperTrade,
  currentPrice: number | null,
  keyLevels?: KeyLevelDto[],
): PositionChartPosition {
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
    keyLevels: keyLevels?.map(k => ({ price: k.price, label: k.label, kind: k.kind, isSignal: k.isSignal })),
    title: `${t.symbol} ${t.side === 'BUY' ? 'LONG' : 'SHORT'} (DEMO #${t.id})`,
  }
}

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL'

// Paper-trade specific status badge — mirrors TradeStatusBadge palette (accent/long/short/neutral)
const PAPER_STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  OPEN:    { bg: 'bg-accent/10',     text: 'text-accent',     label: 'Открыта' },
  TP1_HIT: { bg: 'bg-blue-500/10',   text: 'text-blue-400',   label: 'TP1' },
  TP2_HIT: { bg: 'bg-blue-500/10',   text: 'text-blue-400',   label: 'TP2' },
  TP3_HIT: { bg: 'bg-long/10',       text: 'text-long',       label: 'TP3' },
  CLOSED:  { bg: 'bg-long/10',       text: 'text-long',       label: 'Закрыта' },
  SL_HIT:  { bg: 'bg-short/10',      text: 'text-short',      label: 'Стоп' },
  EXPIRED: { bg: 'bg-neutral/10',    text: 'text-neutral',    label: 'Истёк' },
}

function PaperStatusBadge({ status, pnl }: { status: string; pnl?: number }) {
  if (status === 'SL_HIT' && pnl !== undefined && pnl > 0) {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-long/10 text-long">Закрыта (SL)</span>
  }
  const s = PAPER_STATUS_MAP[status] || PAPER_STATUS_MAP.EXPIRED
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>
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
// Wraps shared fmtPrice — handles low-value coins (PEPE etc) automatically.
function fmtPrice(n: number, _symbol?: string, _market?: string): string {
  if (n == null || isNaN(n)) return '—'
  return fmtPriceShared(n)
}

// Status badges for raw signals (matches Levels.tsx old palette)
const SIGNAL_STATUS_BADGE: Record<LevelsStatus, { bg: string; text: string; label: string }> = {
  NEW:               { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: 'NEW' },
  ACTIVE:            { bg: 'bg-blue-500/15',   text: 'text-blue-400',   label: 'ACTIVE' },
  TP1_HIT:           { bg: 'bg-green-500/15',  text: 'text-green-400',  label: 'TP1' },
  TP2_HIT:           { bg: 'bg-green-500/20',  text: 'text-green-400',  label: 'TP2' },
  TP3_HIT:           { bg: 'bg-green-500/25',  text: 'text-green-400',  label: 'TP3' },
  CLOSED:            { bg: 'bg-green-500/30',  text: 'text-green-300',  label: 'CLOSED' },
  SL_HIT:            { bg: 'bg-red-500/15',    text: 'text-red-400',    label: 'SL' },
  EXPIRED:           { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'EXP' },
  PENDING:           { bg: 'bg-purple-500/15', text: 'text-purple-300', label: '⏳ PENDING' },
  AWAITING_CONFIRM:  { bg: 'bg-purple-500/25', text: 'text-purple-200', label: '⏳ FILL' },
  CANCELLED:         { bg: 'bg-neutral/10',    text: 'text-neutral',    label: '❎ CANCEL' },
}

type Tab = 'TRADES' | 'SIGNALS'

export default function LevelsPaper() {
  const [config, setConfig] = useState<PaperConfig | null>(null)
  const [trades, setTrades] = useState<PaperTrade[]>([])
  const [stats, setStats] = useState<PaperStats | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [resetAmount, setResetAmount] = useState(500)
  const [cycleRunning, setCycleRunning] = useState(false)
  const [selectedTrade, setSelectedTrade] = useState<PaperTrade | null>(null)
  const [chartTrade, setChartTrade] = useState<PaperTrade | null>(null)
  const [chartKeyLevels, setChartKeyLevels] = useState<KeyLevelDto[]>([])
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})
  // Tab + signals state (merged from old /levels page)
  const [tab, setTab] = useState<Tab>('TRADES')
  const [signals, setSignals] = useState<LevelsSignal[]>([])
  const [signalsLoading, setSignalsLoading] = useState(false)
  const [signalsConfig, setSignalsConfig] = useState<LevelsCfg | null>(null)
  const [setups, setSetups] = useState<LevelsSetup[]>([])
  const [selectedSignal, setSelectedSignal] = useState<LevelsSignal | null>(null)
  const [scanRunning, setScanRunning] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = statusFilter === 'OPEN' ? ['OPEN', 'TP1_HIT', 'TP2_HIT']
                   : statusFilter === 'CLOSED' ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT']
                   : undefined
      const [c, t, s] = await Promise.all([
        getPaperConfig(),
        getPaperTrades({ status, limit: 200 }),
        getPaperStats(),
      ])
      setConfig(c)
      setTrades(t.data)
      setStats(s)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { loadAll() }, [loadAll])

  // Fetch key reference levels (PDH/PDL/PWH/PWL + the signal's own level)
  // when opening chart. Uses the signalId to look up the signal's source/level
  // so we can highlight which exact level fired the trade.
  useEffect(() => {
    if (!chartTrade) { setChartKeyLevels([]); return }
    let cancelled = false
    const sig = signals.find(s => s.id === chartTrade.signalId)
    const signalLevel = sig?.level
    const signalSource = sig?.source
    getKeyLevels(chartTrade.symbol, chartTrade.entryPrice, signalLevel, signalSource)
      .then(r => { if (!cancelled) setChartKeyLevels(r.levels) })
      .catch(() => { if (!cancelled) setChartKeyLevels([]) })
    return () => { cancelled = true }
  }, [chartTrade, signals])
  useEffect(() => {
    const t = setInterval(loadAll, 30_000)
    return () => clearInterval(t)
  }, [loadAll])

  // === Signals tab data loading ===
  const loadSignals = useCallback(async () => {
    setSignalsLoading(true)
    try {
      const status: LevelsStatus[] | undefined = statusFilter === 'OPEN'
        ? ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT', 'PENDING', 'AWAITING_CONFIRM']
        : statusFilter === 'CLOSED'
        ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT', 'CANCELLED']
        : undefined
      const res = await getLevelsSignals({ status, limit: 200 })
      setSignals(res.data)
    } catch {
      // silently
    } finally {
      setSignalsLoading(false)
    }
  }, [statusFilter])

  const loadSignalsConfig = useCallback(async () => {
    try {
      const r = await getLevelsConfig()
      setSignalsConfig(r.config)
      setSetups(r.defaultSetups)
    } catch {}
  }, [])

  useEffect(() => {
    if (tab === 'SIGNALS') loadSignals()
  }, [tab, loadSignals])
  useEffect(() => { loadSignalsConfig() }, [loadSignalsConfig])

  const handleScanNow = async () => {
    setScanRunning(true)
    try {
      // 1. Live scanner: detect new signals from latest 5m candles
      await scanLevelsNow()
      // 2. Live tracker: update existing signals (TP/SL, PENDING fill/confirm)
      await trackLevelsNow()
      // 3. Paper cycle: open virtual trades for any new signals + update P&L on existing
      await runPaperCycleNow()
      await loadSignals()
      await loadAll()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setScanRunning(false)
    }
  }
  const handleToggleSignalsEnabled = async () => {
    if (!signalsConfig) return
    const updated = await updateLevelsConfig({ enabled: !signalsConfig.enabled })
    setSignalsConfig(updated)
  }
  const handleWipeAll = async () => {
    const amount = window.prompt('Очистить ВСЕ сигналы и сделки и сбросить депо. Введи новый стартовый депозит:', String(config?.startingDepositUsd ?? 500))
    if (!amount) return
    const n = parseFloat(amount)
    if (!isFinite(n) || n <= 0) { alert('Некорректное число'); return }
    if (!confirm(`ОЧИСТИТЬ ВСЁ? Удалятся все сигналы и виртуальные сделки. Депо: $${n}`)) return
    try {
      const r = await wipeAllPaper(n)
      alert(`Удалено: ${r.deletedSignals} сигналов, ${r.deletedTrades} сделок. Депо: $${r.config.currentDepositUsd}`)
      await loadAll()
      await loadSignals()
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`)
    }
  }

  // Poll live prices every 3s for open trades
  useEffect(() => {
    const controller = new AbortController()
    async function fetchLive() {
      try {
        const data = await getPaperLivePrices(controller.signal)
        const map: Record<number, PaperTradeLive> = {}
        data.forEach(d => { map[d.id] = d })
        setLivePrices(map)

        // Detect status change → reload full trades
        const openStatuses = ['OPEN', 'TP1_HIT', 'TP2_HIT']
        const changed = trades.some(t => {
          const live = map[t.id]
          if (!live) return openStatuses.includes(t.status) // was open, now gone = closed
          return live.status !== t.status
        })
        if (changed) loadAll()
      } catch (err: any) {
        if (err?.name === 'AbortError') return
      }
    }
    fetchLive()
    const interval = setInterval(fetchLive, 3000)
    return () => { controller.abort(); clearInterval(interval) }
  }, [trades, loadAll])

  const handleToggle = async () => {
    if (!config) return
    const updated = await updatePaperConfig({ enabled: !config.enabled })
    setConfig(updated)
  }
  const handleReset = async () => {
    if (!confirm(`Сбросить виртуальный счёт на $${resetAmount}? Все открытые сделки будут закрыты.`)) return
    await resetPaper(resetAmount)
    await loadAll()
  }
  const handleCycleNow = async () => {
    setCycleRunning(true)
    try {
      await runPaperCycleNow()
      await loadAll()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setCycleRunning(false)
    }
  }
  const handleConfigSave = async (patch: Partial<PaperConfig>) => {
    const updated = await updatePaperConfig(patch)
    setConfig(updated)
  }

  // Sort: closed/all view → by closedAt DESC (закрытые сверху по времени закрытия);
  // open view → by openedAt DESC (как раньше). Открытые без closedAt остаются по openedAt.
  // ВАЖНО: useMemo должен быть ДО любых early returns ниже (Rules of Hooks).
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
        <h1 className="text-2xl font-semibold mb-3">Демо-счёт</h1>
        <div className="bg-short/15 border border-short/30 text-short rounded p-3 mb-4">
          {error || 'Не удалось загрузить настройки демо-счёта. Возможно, миграция БД ещё не применена.'}
        </div>
        <button
          onClick={loadAll}
          className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input"
        >
          Повторить
        </button>
      </div>
    )
  }

  const returnPct = stats?.returnPct ?? 0
  const totalTrades = config.totalTrades
  const winRate = stats?.winRate ?? 0
  const openTrades = trades.filter(t => ['OPEN','TP1_HIT','TP2_HIT'].includes(t.status))
  const openCount = openTrades.length
  // Активная маржа = сумма (remaining position size / leverage) по всем открытым сделкам.
  // Leverage = positionSize / depositAtEntry, capped 1..100x — та же формула что в строке таблицы.
  const activeMarginUsd = openTrades.reduce((sum, t) => {
    const closedFrac = (t.closes ?? []).reduce((a, c) => a + c.percent, 0) / 100
    const remainingPos = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
    const lev = t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
      ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
      : 1
    return sum + remainingPos / lev
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Уровни</h1>
          <p className="text-sm text-text-secondary">
            Стратегия V2 + Fibo · авто-сигналы каждые 5 мин · виртуальная торговля + Telegram
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleScanNow} disabled={scanRunning}
            className="px-4 py-2 bg-accent text-primary rounded font-medium hover:bg-accent/90 disabled:opacity-50">
            {scanRunning ? 'Сканирую…' : 'Скан сейчас'}
          </button>
          <button onClick={handleCycleNow} disabled={cycleRunning}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input disabled:opacity-50">
            {cycleRunning ? 'Обновляю...' : 'Обновить демо'}
          </button>
          <button onClick={handleToggle}
            className={`px-4 py-2 rounded font-medium ${config.enabled
              ? 'bg-long/15 text-long border border-long/40 hover:bg-long/25'
              : 'bg-card border border-input hover:bg-input'}`}>
            {config.enabled ? '● Демо вкл.' : '○ Демо выкл.'}
          </button>
          <button onClick={handleToggleSignalsEnabled}
            className={`px-4 py-2 rounded font-medium ${signalsConfig?.enabled
              ? 'bg-long/15 text-long border border-long/40 hover:bg-long/25'
              : 'bg-card border border-input hover:bg-input'}`}>
            {signalsConfig?.enabled ? '● Сканер вкл.' : '○ Сканер выкл.'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">⚙ Настройки</button>
          <button onClick={handleWipeAll}
            className="px-4 py-2 bg-short/15 border border-short/40 text-short rounded font-medium hover:bg-short/25">
            🗑 Очистить всё
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-input">
        <TabButton active={tab === 'TRADES'} onClick={() => setTab('TRADES')}>
          💼 Виртуальные сделки
        </TabButton>
        <TabButton active={tab === 'SIGNALS'} onClick={() => setTab('SIGNALS')}>
          📡 Сигналы (raw)
        </TabButton>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Депозит" value={`$${config.currentDepositUsd.toFixed(2)}`}
          sub={`из $${config.startingDepositUsd}`} tone={config.currentDepositUsd >= config.startingDepositUsd ? 'long' : 'short'} />
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
            <ConfigField label="Риск на сделку (%)" value={config.riskPctPerTrade}
              onChange={(v) => handleConfigSave({ riskPctPerTrade: v })} step={0.5} min={0.1} max={10} />
            <ConfigField label="Комиссия round-trip (%)" value={config.feesRoundTripPct}
              onChange={(v) => handleConfigSave({ feesRoundTripPct: v })} step={0.01} min={0} max={1} />
            <div>
              <label className="block text-xs text-text-secondary mb-1">Авто-перенос SL (TP1→BE)</label>
              <button
                onClick={() => handleConfigSave({ autoTrailingSL: !config.autoTrailingSL })}
                className={`w-full px-3 py-2 rounded font-medium text-sm ${config.autoTrailingSL
                  ? 'bg-long/15 text-long border border-long/40'
                  : 'bg-card border border-input'}`}
              >
                {config.autoTrailingSL ? '● Включён' : '○ Отключён'}
              </button>
              <div className="text-xs text-text-secondary mt-1">
                {config.autoTrailingSL
                  ? 'После TP1 → SL в BE. После TP2/TP3 SL не двигается.'
                  : 'SL стоит на initial до ручного переноса (как Bybit)'}
              </div>
            </div>
          </div>
          <div className="text-xs text-text-secondary mt-3 bg-input/40 rounded p-2">
            ⚠ Лимиты на дневной/недельный убыток и на количество позиций <b>отключены</b> — берём все сигналы без ограничений.
          </div>
          <div className="border-t border-input mt-4 pt-4 flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-text-secondary mb-1">Сбросить депозит на</label>
              <input type="number" value={resetAmount} onChange={(e) => setResetAmount(parseFloat(e.target.value) || 500)}
                className="w-full bg-input border border-input rounded px-3 py-2 font-mono" />
            </div>
            <button onClick={handleReset}
              className="px-4 py-2 bg-short/15 border border-short/40 text-short rounded font-medium hover:bg-short/25">
              Сбросить счёт
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-3">
            Стартовало {new Date(config.startedAt).toLocaleString('ru-RU')}
            {config.resetAt && ` · последний сброс ${new Date(config.resetAt).toLocaleString('ru-RU')}`}
          </p>
        </div>
      )}

      {error && <div className="bg-short/15 border border-short/30 text-short rounded p-3 mb-4">{error}</div>}

      {/* Filters (shared across tabs) */}
      <div className="flex gap-2 mb-4">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => setStatusFilter('OPEN')}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => setStatusFilter('CLOSED')}>Закрытые</FilterButton>
        <FilterButton active={statusFilter === 'ALL'} onClick={() => setStatusFilter('ALL')}>Все</FilterButton>
      </div>

      {tab === 'TRADES' && (<>{/* === TRADES TAB === */}

      {/* Trades table — same style as /сделки */}
      <div className="bg-card border border-input rounded overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-input text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Дата</th>
                <th className="text-left px-3 py-2">⏱</th>
                <th className="text-left px-3 py-2">Монета</th>
                <th className="text-right px-3 py-2">Вход</th>
                <th className="text-right px-3 py-2">Цена</th>
                <th className="text-right px-3 py-2">Размер</th>
                <th className="text-right px-3 py-2">Маржа</th>
                <th className="text-right px-3 py-2">SL</th>
                <th className="text-right px-3 py-2">TP</th>
                <th className="text-right px-3 py-2">Рлз.</th>
                <th className="text-right px-3 py-2">P&L</th>
                <th className="text-center px-3 py-2">Статус</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={12} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
              {!loading && trades.length === 0 && (
                <tr><td colSpan={12} className="text-center py-12 text-text-secondary">
                  {config.enabled
                    ? 'Сделок ещё нет. Демо-счёт работает — виртуальные сделки появятся когда сканер найдёт сигналы.'
                    : 'Демо-счёт выключен. Включи кнопкой ● Выключен сверху.'}
                </td></tr>
              )}
              {!loading && sortedTrades.map(t => {
                const live = livePrices[t.id]
                const isOpen = ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)
                const closedFrac = (t.closes ?? []).reduce((a, c) => a + c.percent, 0) / 100
                const remainingPositionUsd = t.positionSizeUsd * Math.max(0, 1 - closedFrac)

                // Live P&L for open, realized for closed
                const displayPnl = isOpen && live ? live.unrealizedPnl : t.netPnlUsd
                const displayPnlPct = isOpen && live
                  ? live.unrealizedPnlPct
                  : (t.depositAtEntryUsd > 0 ? (t.netPnlUsd / t.depositAtEntryUsd) * 100 : 0)

                // SL distance as %
                const slDir = t.side === 'BUY' ? 1 : -1
                const slPctRaw = ((t.currentStop - t.entryPrice) / t.entryPrice) * 100 * slDir
                const slPct = slPctRaw // already signed (negative for stop below long entry)

                // TP final
                const tps = (t.tpLadder ?? []).slice(0, 3)
                const lastTp = tps.length > 0 ? tps[tps.length - 1] : null
                const tpDir = t.side === 'BUY' ? 1 : -1
                const tpPct = lastTp != null ? ((lastTp - t.entryPrice) / t.entryPrice) * 100 * tpDir : null

                const sideColorCls = t.side === 'BUY' ? 'text-long' : 'text-short'
                const closedPctNum = Math.round(closedFrac * 100)
                const isFinished = ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'].includes(t.status)

                return (
                  <tr key={t.id}
                    className="border-t border-input hover:bg-input/50 cursor-pointer transition-colors"
                    onClick={() => setSelectedTrade(t)}>
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
                          onClick={e => { e.stopPropagation(); setChartTrade(t) }}
                          className="text-text-secondary hover:text-accent transition-colors"
                          title="График позиции"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                        </button>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-primary">${fmtPrice(t.entryPrice, t.symbol, t.market)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {isOpen && live?.currentPrice != null ? (
                        <span className={pnlColor(live.unrealizedPnl)}>${fmtPrice(live.currentPrice, t.symbol, t.market)}</span>
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
                      {t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0 && (
                        <div className="text-[10px] text-accent/80" title="Рекомендуемое плечо при текущем риске">
                          ×{Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd)).toFixed(1)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      {(() => {
                        const lev = t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
                          ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
                          : 1
                        const marginFull = t.positionSizeUsd / lev
                        const marginRemaining = remainingPositionUsd / lev
                        return isFinished ? (
                          <span className="text-text-secondary" title="Маржа сделки (размер / плечо)">${fmt2(marginFull)}</span>
                        ) : (
                          <>
                            <span className="text-text-primary" title="Маржа = размер / плечо">${fmt2(marginRemaining)}</span>
                            {closedPctNum > 0 && closedPctNum < 100 && (
                              <div className="text-[10px] text-text-secondary">было ${fmt2(marginFull)}</div>
                            )}
                          </>
                        )
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      <span className="text-short">${fmtPrice(t.currentStop, t.symbol, t.market)}</span>
                      <div className="text-[10px] text-short/70">{fmt2(slPct)}%</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      {lastTp != null && tpPct != null ? (
                        <>
                          <span className="text-long">${fmtPrice(lastTp, t.symbol, t.market)}</span>
                          <div className="text-[10px] text-long/70">+{fmt2(tpPct)}%</div>
                        </>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {closedPctNum > 0 ? (
                        <span className={pnlColor(t.realizedPnlUsd - t.feesPaidUsd)}>
                          {fmt2Signed(t.realizedPnlUsd - t.feesPaidUsd)}$
                        </span>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono leading-tight">
                      {isOpen && live ? (
                        <span className={pnlColor(live.unrealizedPnl)}>
                          {fmt2Signed(live.unrealizedPnl)}$
                          <div className="text-[10px] opacity-70">({fmt2Signed(live.unrealizedPnlPct)}%)</div>
                        </span>
                      ) : isFinished ? (
                        <span className={pnlColor(t.netPnlUsd)} title={t.feesPaidUsd > 0 ? `Gross: ${fmt2Signed(t.realizedPnlUsd)}$ · Комиссии: -${fmt2(t.feesPaidUsd)}$` : undefined}>
                          {fmt2Signed(t.netPnlUsd)}$
                          {t.netPnlUsd !== 0 && <div className="text-[10px] opacity-70">({fmt2Signed(displayPnlPct)}%)</div>}
                        </span>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center"><PaperStatusBadge status={t.status} pnl={t.netPnlUsd} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-symbol breakdown */}
      {stats && Object.keys(stats.bySymbol).length > 0 && (
        <div className="mb-6">
          <h3 className="font-semibold mb-2">По инструментам</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {Object.entries(stats.bySymbol).map(([sym, s]) => (
              <div key={sym} className="bg-card border border-input rounded p-3">
                <div className="font-mono font-semibold">{sym}</div>
                <div className="text-xs text-text-secondary">{s.trades} trades</div>
                <div className={`text-sm font-mono ${s.pnl > 0 ? 'text-long' : s.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                  {fmtUsd(s.pnl)}
                </div>
                <div className="text-xs text-text-secondary">WR {s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Equity curve (simple text) */}
      {stats && stats.equityCurve.length > 0 && (
        <div>
          <h3 className="font-semibold mb-2">Equity curve (по дням)</h3>
          <div className="bg-card border border-input rounded p-3 max-h-64 overflow-y-auto">
            <table className="w-full text-sm font-mono">
              <thead className="text-text-secondary text-xs">
                <tr>
                  <th className="text-left">Дата</th>
                  <th className="text-right">P&L дня</th>
                  <th className="text-right">Депозит</th>
                </tr>
              </thead>
              <tbody>
                {[...stats.equityCurve].reverse().map(p => (
                  <tr key={p.date} className="border-t border-input">
                    <td className="text-text-secondary py-1">{p.date}</td>
                    <td className={`text-right py-1 ${p.pnl > 0 ? 'text-long' : p.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                      {fmtUsd(p.pnl)}
                    </td>
                    <td className="text-right py-1">${p.equity.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </>)}

      {tab === 'SIGNALS' && (
        <SignalsTab
          signals={signals}
          loading={signalsLoading}
          setups={setups}
          onSelect={setSelectedSignal}
        />
      )}

      {selectedTrade && (
        <PaperTradeModal
          trade={selectedTrade}
          onClose={() => setSelectedTrade(null)}
          onUpdate={(updated) => {
            setSelectedTrade(updated)
            setTrades(prev => prev.map(t => t.id === updated.id ? updated : t))
            // refresh stats since deposit may have changed
            getPaperStats().then(setStats).catch(() => {})
            getPaperConfig().then(setConfig).catch(() => {})
          }}
          onDelete={(id) => {
            setTrades(prev => prev.filter(t => t.id !== id))
            getPaperStats().then(setStats).catch(() => {})
            getPaperConfig().then(setConfig).catch(() => {})
          }}
        />
      )}

      {chartTrade && (
        <PositionChartModal
          position={paperTradeToPosition(chartTrade, livePrices[chartTrade.id]?.currentPrice ?? null, chartKeyLevels)}
          onClose={() => setChartTrade(null)}
        />
      )}

      {selectedSignal && (
        <LevelsSignalModal
          signal={selectedSignal}
          onClose={() => setSelectedSignal(null)}
          onUpdate={(updated) => {
            setSelectedSignal(updated)
            setSignals(prev => prev.map(s => s.id === updated.id ? updated : s))
          }}
        />
      )}
    </div>
  )
}

function SignalsTab({ signals, loading, setups, onSelect }: {
  signals: LevelsSignal[]; loading: boolean; setups: LevelsSetup[];
  onSelect: (s: LevelsSignal) => void
}) {
  return (
    <>
      {/* Setups overview */}
      {setups.length > 0 && (
        <details className="mb-4 bg-card border border-input rounded">
          <summary className="px-4 py-2 cursor-pointer font-semibold text-sm">Активные инструменты ({setups.length})</summary>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 p-3 border-t border-input">
            {setups.map(s => {
              const sideText = s.side === 'BUY' ? 'LONG' : s.side === 'SELL' ? 'SHORT' : 'BOTH'
              const sideColor = s.side === 'BUY' ? 'text-long' : s.side === 'SELL' ? 'text-short' : 'text-text-primary'
              const isLimit = s.entryMode === 'LIMIT'
              return (
                <div key={`${s.symbol}-${s.side}`} className="bg-input/30 rounded p-2">
                  <div className="font-mono font-semibold text-sm">{s.symbol}</div>
                  <div className="text-xs text-text-secondary">
                    <span className={sideColor}>{sideText}</span> · {s.market}
                    {isLimit && <span className="ml-1 text-purple-300">⏳ LIMIT</span>}
                    {s.tpMinAtr ? <span className="ml-1 text-accent">tpMin {s.tpMinAtr}</span> : null}
                  </div>
                </div>
              )
            })}
          </div>
        </details>
      )}

      {/* Signals table */}
      <div className="bg-card border border-input rounded overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-input text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Время</th>
                <th className="text-left px-3 py-2">Символ</th>
                <th className="text-left px-3 py-2">Сторона</th>
                <th className="text-left px-3 py-2">Событие</th>
                <th className="text-right px-3 py-2 font-mono">Уровень</th>
                <th className="text-right px-3 py-2 font-mono">Вход</th>
                <th className="text-right px-3 py-2 font-mono">SL</th>
                <th className="text-right px-3 py-2 font-mono">TP1/TP2/TP3</th>
                <th className="text-center px-3 py-2">Status</th>
                <th className="text-right px-3 py-2 font-mono">R</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="text-center py-8 text-text-secondary">Загрузка...</td></tr>
              )}
              {!loading && signals.length === 0 && (
                <tr><td colSpan={10} className="text-center py-8 text-text-secondary">Сигналов нет</td></tr>
              )}
              {!loading && signals.map(s => {
                const tps = s.tpLadder.slice(0, 3)
                const sideColor = s.side === 'BUY' ? 'text-long' : 'text-short'
                const sideEmoji = s.side === 'BUY' ? '🟢' : '🔴'
                const badge = SIGNAL_STATUS_BADGE[s.status]
                const rTone = s.realizedR > 0 ? 'text-long' : s.realizedR < 0 ? 'text-short' : 'text-text-secondary'
                return (
                  <tr key={s.id} onClick={() => onSelect(s)}
                    className="border-t border-input hover:bg-input/40 cursor-pointer">
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {new Date(s.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 font-mono font-semibold">{s.symbol}</td>
                    <td className={`px-3 py-2 font-medium ${sideColor}`}>{sideEmoji} {s.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                    <td className="px-3 py-2 text-xs">
                      {s.event === 'BREAKOUT_RETEST' ? '🚀 BR' : '🎯 React'}
                      {s.isFiboConfluence && <span className="ml-1 text-accent">🌀</span>}
                      {s.entryMode === 'LIMIT' && <span className="ml-1 text-purple-300">⏳</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">${fmtPriceShared(s.level)}</td>
                    <td className="px-3 py-2 text-right font-mono">${fmtPriceShared(s.entryPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-short">${fmtPriceShared(s.currentStop)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {tps.map(tp => fmtPriceShared(tp)).join(' / ')}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge?.bg} ${badge?.text}`}>
                        {badge?.label ?? s.status}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${rTone}`}>
                      {s.realizedR !== 0 ? `${s.realizedR >= 0 ? '+' : ''}${s.realizedR.toFixed(2)}R` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'long' | 'short' | 'neutral' }) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-input rounded p-3">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-lg font-mono font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-text-secondary">{sub}</div>}
    </div>
  )
}
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-2 font-medium border-b-2 transition-colors ${
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}>
      {children}
    </button>
  )
}
function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded text-sm font-medium ${
      active ? 'bg-accent text-primary'
             : 'bg-card border border-input text-text-secondary hover:text-text-primary'}`}>
      {children}
    </button>
  )
}
function ConfigField({ label, value, onChange, step, min, max }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v)) onChange(v)
        }}
        className="w-full bg-input border border-input rounded px-3 py-2 font-mono"
      />
    </div>
  )
}
