import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  getBreakoutPaperConfig, updateBreakoutPaperConfig, resetBreakoutPaper,
  getBreakoutPaperTrades, getBreakoutPaperStats, runBreakoutPaperCycleNow,
  getBreakoutPaperLivePrices, wipeAllBreakoutPaper,
  getBreakoutConfig, updateBreakoutConfig, scanBreakoutNow, getBreakoutSetups,
  type BreakoutPaperConfig as PaperConfig,
  type BreakoutTrade as PaperTrade,
  type BreakoutStats as PaperStats,
  type BreakoutTradeLive as PaperTradeLive,
  type BreakoutConfig as ScannerCfg,
} from '../api/breakoutPaper'
import { formatDate, pnlColor, fmt2, fmt2Signed, fmtPrice as fmtPriceShared } from '../lib/formatters'

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL'

const PAPER_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  OPEN:    { bg: 'bg-accent/15',     text: 'text-accent',     label: 'Открыта' },
  TP1_HIT: { bg: 'bg-long/10',       text: 'text-long',       label: 'TP1 ✓' },
  TP2_HIT: { bg: 'bg-long/15',       text: 'text-long',       label: 'TP2 ✓' },
  TP3_HIT: { bg: 'bg-long/20',       text: 'text-long',       label: 'TP3 ✓' },
  CLOSED:  { bg: 'bg-long/10',       text: 'text-long',       label: 'Закрыта' },
  SL_HIT:  { bg: 'bg-short/15',      text: 'text-short',      label: 'SL' },
  EXPIRED: { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Истёк' },
}

function PaperStatusBadge({ status, pnl }: { status: string; pnl: number }) {
  if (status === 'CLOSED' && pnl < 0) {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-short/10 text-short">Стоп</span>
  }
  const cfg = PAPER_STATUS_BADGE[status] ?? { bg: 'bg-input', text: 'text-text-secondary', label: status }
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>
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
  return fmtPriceShared(n)
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
  const [stats, setStats] = useState<PaperStats | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [resetAmount, setResetAmount] = useState(500)
  const [cycleRunning, setCycleRunning] = useState(false)
  const [scanRunning, setScanRunning] = useState(false)
  const [livePrices, setLivePrices] = useState<Record<number, PaperTradeLive>>({})

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = statusFilter === 'OPEN' ? ['OPEN', 'TP1_HIT', 'TP2_HIT']
                   : statusFilter === 'CLOSED' ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT']
                   : undefined
      const [c, sc, su, t, s] = await Promise.all([
        getBreakoutPaperConfig(),
        getBreakoutConfig(),
        getBreakoutSetups(),
        getBreakoutPaperTrades({ status, limit: 200 }),
        getBreakoutPaperStats(),
      ])
      setConfig(c)
      setScannerCfg(sc)
      setSetups(su.setups)
      setTrades(t.data)
      setStats(s)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { loadAll() }, [loadAll])

  // Poll live prices every 3s for OPEN trades
  useEffect(() => {
    if (statusFilter !== 'OPEN') return
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
  }, [statusFilter])

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
  const openTrades = trades.filter(t => ['OPEN','TP1_HIT','TP2_HIT'].includes(t.status))
  const openCount = openTrades.length
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
      <div className="flex gap-2 mb-3">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => setStatusFilter('OPEN')}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => setStatusFilter('CLOSED')}>Закрытые</FilterButton>
        <FilterButton active={statusFilter === 'ALL'} onClick={() => setStatusFilter('ALL')}>Все</FilterButton>
      </div>

      {/* Trades table */}
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
                const lev = t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
                  ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
                  : 1
                const marginFull = t.positionSizeUsd / lev
                const marginRemaining = remainingPositionUsd / lev

                return (
                  <tr key={t.id} className="border-t border-input hover:bg-input/50 transition-colors">
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
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-text-primary">${fmtPrice(t.entryPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {isOpen && live?.currentPrice != null ? (
                        <span className={pnlColor(live.unrealizedPnl)}>${fmtPrice(live.currentPrice)}</span>
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
            {Object.entries(stats.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, s]) => (
              <div key={sym} className="bg-card border border-input rounded p-2 text-xs">
                <div className="font-medium text-text-primary">{sym}</div>
                <div className="text-text-secondary">{s.trades} trades</div>
                <div className={pnlColor(s.pnl)}>{fmt2Signed(s.pnl)}$</div>
                <div className="text-text-secondary">WR {((s.wins / s.trades) * 100).toFixed(0)}%</div>
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
    </div>
  )
}
