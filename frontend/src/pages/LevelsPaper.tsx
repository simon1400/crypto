import { useState, useEffect, useCallback } from 'react'
import {
  getPaperConfig, updatePaperConfig, resetPaper,
  getPaperTrades, getPaperStats, runPaperCycleNow,
  getPaperLivePrices,
  type PaperConfig, type PaperTrade, type PaperStats, type PaperTradeLive,
} from '../api/levelsPaper'
import PaperTradeModal from '../components/PaperTradeModal'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import { formatDate, pnlColor, fmt2, fmt2Signed } from '../lib/formatters'

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

function formatElapsed(openedAt: string): string {
  const ms = Date.now() - new Date(openedAt).getTime()
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
function fmtPrice(n: number, symbol: string, market: string): string {
  if (n == null || isNaN(n)) return '—'
  const dec = market === 'CRYPTO' ? (symbol.includes('USDT') ? 2 : 6) : (/^XAU|^XAG/.test(symbol) ? 2 : /JPY/.test(symbol) ? 3 : 5)
  return n.toFixed(dec)
}

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
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})

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
  useEffect(() => {
    const t = setInterval(loadAll, 30_000)
    return () => clearInterval(t)
  }, [loadAll])

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
  const openCount = trades.filter(t => ['OPEN','TP1_HIT','TP2_HIT'].includes(t.status)).length

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Демо-счёт (Paper Trading)</h1>
          <p className="text-sm text-text-secondary">
            Автоматическая виртуальная торговля по сигналам из /levels · реальные данные, виртуальный депозит
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleCycleNow} disabled={cycleRunning}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input disabled:opacity-50">
            {cycleRunning ? 'Обновляю...' : 'Обновить сейчас'}
          </button>
          <button onClick={handleToggle}
            className={`px-4 py-2 rounded font-medium ${config.enabled
              ? 'bg-long/15 text-long border border-long/40 hover:bg-long/25'
              : 'bg-card border border-input hover:bg-input'}`}>
            {config.enabled ? '● Включён' : '○ Выключен'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">⚙ Настройки</button>
        </div>
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
          sub={`Max DD ${config.maxDrawdownPct.toFixed(1)}%`} />
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
                  ? 'После TP1 → SL в BE, после TP2 → SL в TP1'
                  : 'SL стоит на initial до ручного переноса (как Bybit)'}
              </div>
            </div>
            <ConfigField label="Daily loss limit (%)" value={config.dailyLossLimitPct}
              onChange={(v) => handleConfigSave({ dailyLossLimitPct: v })} step={1} min={1} max={50} />
            <ConfigField label="Weekly loss limit (%)" value={config.weeklyLossLimitPct}
              onChange={(v) => handleConfigSave({ weeklyLossLimitPct: v })} step={1} min={1} max={50} />
            <ConfigField label="Max позиций одновременно" value={config.maxConcurrentPositions}
              onChange={(v) => handleConfigSave({ maxConcurrentPositions: Math.round(v) })} step={1} min={1} max={10} />
            <ConfigField label="Max на инструмент" value={config.maxPositionsPerSymbol}
              onChange={(v) => handleConfigSave({ maxPositionsPerSymbol: Math.round(v) })} step={1} min={1} max={5} />
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

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => setStatusFilter('OPEN')}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => setStatusFilter('CLOSED')}>Закрытые</FilterButton>
        <FilterButton active={statusFilter === 'ALL'} onClick={() => setStatusFilter('ALL')}>Все</FilterButton>
      </div>

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
                <th className="text-right px-3 py-2">SL</th>
                <th className="text-right px-3 py-2">TP</th>
                <th className="text-right px-3 py-2">Рлз.</th>
                <th className="text-right px-3 py-2">P&L</th>
                <th className="text-center px-3 py-2">Статус</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={11} className="text-center py-12 text-text-secondary">Загрузка...</td></tr>}
              {!loading && trades.length === 0 && (
                <tr><td colSpan={11} className="text-center py-12 text-text-secondary">
                  {config.enabled
                    ? 'Сделок ещё нет. Демо-счёт работает — виртуальные сделки появятся когда сканер найдёт сигналы.'
                    : 'Демо-счёт выключен. Включи кнопкой ● Выключен сверху.'}
                </td></tr>
              )}
              {!loading && trades.map(t => {
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
                    <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{formatDate(t.openedAt)}</td>
                    <td className="px-3 py-2 font-mono text-accent">
                      {isOpen ? <LiveTimer openedAt={t.openedAt} /> : <span className="text-text-secondary">{formatElapsed(t.openedAt)}</span>}
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
                      <span className="text-text-primary">${fmt2(remainingPositionUsd)}</span>
                      {closedPctNum > 0 && closedPctNum < 100 && (
                        <div className="text-[10px] text-text-secondary">было ${fmt2(t.positionSizeUsd)}</div>
                      )}
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
          position={paperTradeToPosition(chartTrade, livePrices[chartTrade.id]?.currentPrice ?? null)}
          onClose={() => setChartTrade(null)}
        />
      )}
    </div>
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
