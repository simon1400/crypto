import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getBreakoutPaperConfig, updateBreakoutPaperConfig, resetBreakoutPaper,
  getBreakoutPaperTrades, getBreakoutPaperStats,
  getBreakoutPaperLivePrices, wipeAllBreakoutPaper, closeAllBreakoutPaperTradesMarket,
  getBreakoutConfig, updateBreakoutConfig, getBreakoutSetups,
  getBreakoutSignals,
  isLiveVariant,
  type BreakoutPaperConfig as PaperConfig,
  type BreakoutTrade as PaperTrade,
  type BreakoutStats as PaperStats,
  type BreakoutTradeLive as PaperTradeLive,
  type BreakoutConfig as ScannerCfg,
  type BreakoutSignal,
  type BreakoutVariant,
} from '../api/breakoutPaper'
import {
  getLiveStatus, killSwitch, releaseKillSwitch, wipeAllLive,
  getLiveAttempts, clearLiveAttempts,
  type BreakoutLiveStatus, type BreakoutLiveAttempt,
} from '../api/breakoutLiveC'
import BreakoutPaperTradeModal from '../components/BreakoutPaperTradeModal'
import BreakoutSignalModal from '../components/BreakoutSignalModal'
import PositionChartModal from '../components/PositionChartModal'
import SymbolHistoryModal from '../components/SymbolHistoryModal'

import FilterButton from '../components/breakoutPaper/FilterButton'
import HeaderActions from '../components/breakoutPaper/HeaderActions'
import TopStats from '../components/breakoutPaper/TopStats'
import LiveStatusPanel from '../components/breakoutPaper/LiveStatusPanel'
import SettingsPanel from '../components/breakoutPaper/SettingsPanel'
import AboutStrategy from '../components/breakoutPaper/AboutStrategy'
import SignalsTable from '../components/breakoutPaper/SignalsTable'
import PendingTable from '../components/breakoutPaper/PendingTable'
import AttemptsTable from '../components/breakoutPaper/AttemptsTable'
import ExchangeOrdersTable from '../components/breakoutPaper/ExchangeOrdersTable'
import TradesTable from '../components/breakoutPaper/TradesTable'
import TradeCards from '../components/breakoutPaper/TradeCards'
import BySymbolBreakdown from '../components/breakoutPaper/BySymbolBreakdown'
import EquityCurveSection from '../components/breakoutPaper/EquityCurveSection'
import { paperTradeToPosition } from '../components/breakoutPaper/helpers'
import {
  CLOSED_PAGE_SIZE, SIGNALS_PAGE_SIZE, ACTIVE_STATUSES, CLOSED_STATUSES,
  type StatusFilter,
} from '../components/breakoutPaper/constants'

export interface BreakoutPaperProps {
  /** Which paper-trader copy this view binds to. Default 'A' (legacy prod). */
  variant?: BreakoutVariant
}

export default function BreakoutPaper({ variant = 'A' }: BreakoutPaperProps = {}) {
  // LIVE-mode flag: variant 'LIVE' hits /api/breakout-live-c (real Binance Futures).
  // We share the entire UI shell with paper variants A/B/C, but gate destructive
  // controls (wipe-all, force-open, simulate-fill, edit/delete trade, signals tab)
  // because in LIVE those would either orphan exchange state vs DB or be meaningless.
  const isLive = isLiveVariant(variant)
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
  const [closedPage, setClosedPage] = useState(1)
  const [signalsPage, setSignalsPage] = useState(1)
  const [signalsTotal, setSignalsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Default reset amount tracks the variant's starting deposit (A=$500, B/C=$320).
  // In LIVE the input is hidden and the value is unused — reset() ignores it on
  // the backend (baseline comes from Binance availableBalance).
  const [resetAmount, setResetAmount] = useState(variant === 'A' ? 500 : 320)
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})
  const [selectedTrade, setSelectedTrade] = useState<PaperTrade | null>(null)
  const [chartTrade, setChartTrade] = useState<PaperTrade | null>(null)
  const [signals, setSignals] = useState<BreakoutSignal[]>([])
  const [selectedSignal, setSelectedSignal] = useState<BreakoutSignal | null>(null)
  const [symbolHistory, setSymbolHistory] = useState<string | null>(null)
  const [showAbout, setShowAbout] = useState(false)
  const [showBySymbol, setShowBySymbol] = useState(false)
  // LIVE-only: Binance connectivity snapshot + kill-switch state. Polled every 10s.
  const [liveStatus, setLiveStatus] = useState<BreakoutLiveStatus | null>(null)
  // LIVE-only: placement-attempt audit log (today's UTC bucket). Fetched when
  // the 'Отклонённые' tab is active. Refreshed on every loadAll().
  const [attempts, setAttempts] = useState<BreakoutLiveAttempt[]>([])
  const [attemptsTotals, setAttemptsTotals] = useState<{
    total: number; placed: number; rejected: number; gated: number; filtered: number
  } | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const isSignalsTab = statusFilter === 'SIGNALS'
      const isPendingTab = statusFilter === 'PENDING'
      const isCancelledTab = statusFilter === 'CANCELLED'
      // Variant C / LIVE: "Открытые" — только FILLED-сделки. "Закрытые" — только
      // реальные закрытия позиций. "Отменено" — отдельный таб для CANCELLED
      // (limit отменён other-side при fill пары) + для LIVE сюда же идут EXPIRED
      // pendings (orphan cleanup отменил limit после полуночи UTC — fill никогда
      // не происходил, у row маржа/размер выставлены умозрительно при placement,
      // но реально позиции не было). Для paper-вариантов EXPIRED остаётся в
      // "Закрытые" — там это маркер истечения сделки уже после открытия.
      const liveExpiredAsCancelled = isLiveVariant(variant)
      const closedStatuses = liveExpiredAsCancelled
        ? CLOSED_STATUSES.filter((s) => s !== 'EXPIRED')
        : [...CLOSED_STATUSES]
      const cancelledStatuses = liveExpiredAsCancelled
        ? ['CANCELLED', 'EXPIRED']
        : ['CANCELLED']
      const status = statusFilter === 'OPEN'
        ? [...ACTIVE_STATUSES]
        : statusFilter === 'CLOSED'
        ? closedStatuses
        : isCancelledTab
        ? cancelledStatuses
        : isPendingTab
        ? (isLiveVariant(variant) ? ['PENDING_LIMIT'] : ['PENDING'])
        : undefined
      // CLOSED tab: серверная пагинация по 20. Сортировка по closedAt чтобы
      // страницы шли последовательно по дате выхода.
      const tradesQuery = (statusFilter === 'CLOSED' || isCancelledTab)
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
      // Initialize reset amount from server config on first load.
      setResetAmount(prev => (prev === (variant === 'A' ? 500 : 320) ? c.startingDepositUsd : prev))
      // Scanner has no UI toggle anymore — auto-enable if it's somehow off.
      // Only variant A may flip the shared flag.
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
      // Если активная вкладка — OPEN, то t.data уже содержит открытые сделки.
      // Иначе делаем дополнительный fetch.
      if (statusFilter === 'OPEN') {
        setOpenTradesAll(t.data)
      } else {
        try {
          const openOnly = await getBreakoutPaperTrades({ status: [...ACTIVE_STATUSES], limit: 100 }, variant)
          setOpenTradesAll(openOnly.data)
        } catch { /* keep stale */ }
      }
      if (isLiveVariant(variant) && statusFilter === 'ATTEMPTS') {
        try {
          const a = await getLiveAttempts()
          setAttempts(a.data)
          setAttemptsTotals({
            total: a.total,
            placed: a.counts.placed,
            rejected: a.counts.rejected,
            gated: a.counts.gated,
            filtered: a.counts.filtered,
          })
        } catch { /* keep stale */ }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, closedPage, signalsPage, variant])

  useEffect(() => { loadAll() }, [loadAll])

  // LIVE: poll /status every 10s for Binance connectivity + kill-switch flag.
  useEffect(() => {
    if (!isLive) { setLiveStatus(null); return }
    let cancelled = false
    const tick = async () => {
      try {
        const s = await getLiveStatus()
        if (!cancelled) setLiveStatus(s)
      } catch { /* ignore — UI will just show stale state */ }
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [isLive])

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

  const handleKillSwitch = async () => {
    const reason = prompt('Причина kill switch (необязательно):', 'manual')
    if (reason === null) return
    if (!confirm('Закрыть ВСЕ позиции по рынку + отменить все ордера + выключить стратегию?')) return
    try {
      const r = await killSwitch(reason)
      alert(`Kill OK: cancelled=${r.cancelledOrders ?? 0}, closed=${r.closedPositions ?? 0}${r.note ? ' (' + r.note + ')' : ''}`)
      const s = await getLiveStatus(); setLiveStatus(s)
      await loadAll()
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`)
    }
  }

  const handleReleaseKillSwitch = async () => {
    if (!confirm('Снять kill switch? Стратегия останется выключенной — нужно включить отдельно.')) return
    try {
      await releaseKillSwitch()
      const s = await getLiveStatus(); setLiveStatus(s)
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`)
    }
  }

  const handleTogglePaperEnabled = async () => {
    if (!config) return
    const updated = await updateBreakoutPaperConfig({ enabled: !config.enabled }, variant)
    setConfig(updated)
  }

  const handleReset = async () => {
    const msg = isLive
      ? 'Сбросить baseline P&L до текущего availableBalance с Binance? Это влияет только на "Total P&L since baseline" — реальные сделки не трогаются.'
      : `Сбросить депо до $${resetAmount}? Все открытые позиции пометятся EXPIRED.`
    if (!confirm(msg)) return
    // LIVE backend ignores startingDepositUsd (baseline comes from Binance).
    const updated = await resetBreakoutPaper(isLive ? undefined : resetAmount, variant)
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
    // LIVE has its own wipe endpoint — deletes BreakoutLiveTradeC + Funding + Attempts
    // and resets baseline so the next 'enable' takes a fresh snapshot from Binance.
    if (isLive) {
      const isProd = liveStatus?.net === 'prod'
      const baseWarn = 'Удалить ВСЕ записи live-сделок, funding, attempts и сбросить baseline?\n\nПозиции на бирже не трогаются — Kill switch выше сделай ДО этого если они открыты.\n\nПри следующем включении стратегии baseline возьмётся свежим из Binance.'
      if (isProd) {
        const ack = prompt('ПРОДАКШН WIPE.\n\n' + baseWarn + '\n\nВведи PROD_WIPE_ACK для подтверждения:')
        if (ack !== 'PROD_WIPE_ACK') {
          if (ack !== null) alert('Отменено: не введён PROD_WIPE_ACK.')
          return
        }
        try {
          const r = await wipeAllLive('PROD_WIPE_ACK')
          alert(`Удалено: ${r.deletedTrades} сделок, ${r.deletedAttempts} attempts, ${r.deletedFunding} funding.\nДепо сброшено в $${r.config.currentDepositUsd.toFixed(2)} (подхватится с биржи при включении).`)
          const s = await getLiveStatus(); setLiveStatus(s)
          await loadAll()
        } catch (e: any) {
          alert(`Ошибка: ${e.message}`)
        }
        return
      }
      if (!confirm(baseWarn)) return
      try {
        const r = await wipeAllLive()
        alert(`Удалено: ${r.deletedTrades} сделок, ${r.deletedAttempts} attempts, ${r.deletedFunding} funding.\nДепо сброшено в $${r.config.currentDepositUsd.toFixed(2)} (подхватится с биржи при включении).`)
        const s = await getLiveStatus(); setLiveStatus(s)
        await loadAll()
      } catch (e: any) {
        alert(`Ошибка: ${e.message}`)
      }
      return
    }

    const note = variant === 'B'
      ? 'УДАЛИТЬ все B-сделки и сбросить B-депо? Сигналы и A-сделки не трогаются.'
      : 'УДАЛИТЬ ВСЕ сигналы и paper-сделки? Это нельзя отменить.'
    if (!confirm(note)) return
    const r = await wipeAllBreakoutPaper(resetAmount, variant)
    setConfig(r.config)
    alert(`Удалено: ${r.deletedSignals} сигналов, ${r.deletedTrades} сделок. Депо: $${r.config.currentDepositUsd}`)
    await loadAll()
  }

  const handleClearAttempts = async () => {
    if (!confirm('Очистить журнал попыток за сегодня?')) return
    try {
      await clearLiveAttempts()
      setAttempts([])
      setAttemptsTotals({ total: 0, placed: 0, rejected: 0, gated: 0, filtered: 0 })
    } catch (e: any) {
      alert(`Не удалось очистить: ${e.message}`)
    }
  }

  const handleTabChange = (s: StatusFilter) => () => {
    setClosedPage(1)
    setSignalsPage(1)
    setStatusFilter(s)
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

  // symbolsEnabled может быть пустым массивом — тогда бэк использует DEFAULT_BREAKOUT_SETUPS,
  // которые приходят отдельным запросом через getBreakoutSetups() в `setups`.
  const enabledCoins = (scannerCfg?.symbolsEnabled?.length ?? 0) > 0
    ? scannerCfg!.symbolsEnabled.length
    : setups.length

  return (
    <div>
      <HeaderActions
        variant={variant} isLive={isLive} config={config}
        enabledCoins={enabledCoins}
        showAbout={showAbout} setShowAbout={setShowAbout}
        showSettings={showSettings} setShowSettings={setShowSettings}
        openTradesCount={openTradesAll.length}
        onTogglePaperEnabled={handleTogglePaperEnabled}
        onCloseAllMarket={handleCloseAllMarket}
        onWipeAll={handleWipeAll}
      />

      {showAbout && <AboutStrategy variant={variant} isLive={isLive} enabledCoins={enabledCoins} />}

      <TopStats
        config={config} stats={stats} isLive={isLive} liveStatus={liveStatus}
        openCount={openCount} activeMarginUsd={activeMarginUsd}
        unrealizedPnlUsd={unrealizedPnlUsd} equityWithOpen={equityWithOpen}
      />

      {isLive && (
        <LiveStatusPanel
          config={config} liveStatus={liveStatus}
          onKillSwitch={handleKillSwitch}
          onReleaseKillSwitch={handleReleaseKillSwitch}
          onWipeAll={handleWipeAll}
          onConfigChanged={async () => {
            const s = await getLiveStatus(true)
            setLiveStatus(s)
            await loadAll()
          }}
        />
      )}

      {showSettings && (
        <SettingsPanel
          variant={variant} isLive={isLive} config={config} setConfig={setConfig}
          setups={setups}
          resetAmount={resetAmount} setResetAmount={setResetAmount}
          onReset={handleReset}
        />
      )}

      {/* Status filter — variant C / LIVE показывают "Pending" (висящие
          limit'ы) и "Отменено" вместо "Сигналы" (для C signal feed избыточен —
          лимитки ставятся пре-эмптивно на каждый range без привязки к сигналу). */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <FilterButton active={statusFilter === 'OPEN'} onClick={handleTabChange('OPEN')}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={handleTabChange('CLOSED')}>Закрытые</FilterButton>
        {(variant === 'C' || isLive) ? (
          <FilterButton active={statusFilter === 'PENDING'} onClick={handleTabChange('PENDING')}>Pending</FilterButton>
        ) : (
          <FilterButton active={statusFilter === 'SIGNALS'} onClick={handleTabChange('SIGNALS')}>Сигналы</FilterButton>
        )}
        {(variant === 'C' || isLive) && (
          <FilterButton active={statusFilter === 'CANCELLED'} onClick={handleTabChange('CANCELLED')}>Отменено</FilterButton>
        )}
        {isLive && (
          <FilterButton active={statusFilter === 'ATTEMPTS'} onClick={handleTabChange('ATTEMPTS')}>Отклонённые</FilterButton>
        )}
        {isLive && (
          <FilterButton active={statusFilter === 'EXCHANGE'} onClick={handleTabChange('EXCHANGE')}>Биржа</FilterButton>
        )}
      </div>

      {statusFilter === 'SIGNALS' && (
        <SignalsTable
          signals={signals} signalsTotal={signalsTotal}
          signalsPage={signalsPage} setSignalsPage={setSignalsPage}
          stats={stats} loading={loading}
          onSelectSignal={setSelectedSignal}
        />
      )}

      {statusFilter === 'PENDING' && (variant === 'C' || isLive) && (
        <PendingTable trades={trades} loading={loading} onSelectChartFor={setChartTrade} />
      )}

      {statusFilter === 'ATTEMPTS' && isLive && (
        <AttemptsTable
          attempts={attempts} attemptsTotals={attemptsTotals}
          loading={loading} onClear={handleClearAttempts}
        />
      )}

      {statusFilter === 'EXCHANGE' && isLive && (
        <ExchangeOrdersTable
          liveStatus={liveStatus}
          openSymbols={openTradesAll.map(t => t.symbol)}
          loading={loading}
          onForceRefresh={async () => {
            const s = await getLiveStatus(true)
            setLiveStatus(s)
          }}
        />
      )}

      {statusFilter !== 'SIGNALS' && statusFilter !== 'PENDING' && statusFilter !== 'ATTEMPTS' && statusFilter !== 'EXCHANGE' && (
        <>
          <TradeCards
            trades={trades} sortedTrades={sortedTrades}
            tradesTotal={tradesTotal} closedPage={closedPage} setClosedPage={setClosedPage}
            livePrices={livePrices} config={config} loading={loading}
            statusFilter={statusFilter}
            onSelectTrade={setSelectedTrade}
            onSelectChart={setChartTrade}
          />
          <TradesTable
            trades={trades} sortedTrades={sortedTrades}
            tradesTotal={tradesTotal} closedPage={closedPage} setClosedPage={setClosedPage}
            livePrices={livePrices} config={config} loading={loading}
            statusFilter={statusFilter}
            onSelectTrade={setSelectedTrade}
            onSelectChart={setChartTrade}
          />
        </>
      )}

      {stats && Object.keys(stats.bySymbol).length > 0 && (
        <BySymbolBreakdown
          stats={stats}
          show={showBySymbol} setShow={setShowBySymbol}
          onSelectSymbol={setSymbolHistory}
        />
      )}

      {stats && stats.equityCurve.length > 0 && (
        <EquityCurveSection stats={stats} startEquity={config.startingDepositUsd} />
      )}

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
          position={paperTradeToPosition(chartTrade, livePrices[chartTrade.id]?.currentPrice ?? null, isLive)}
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
