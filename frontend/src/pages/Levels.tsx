import { useState, useEffect, useCallback } from 'react'
import {
  getLevelsSignals,
  getLevelsStats,
  getLevelsConfig,
  updateLevelsConfig,
  scanLevelsNow,
  trackLevelsNow,
  cancelLevelsSignal,
  type LevelsSignal,
  type LevelsStatus,
  type LevelsStats,
  type LevelsConfig,
  type LevelsSetup,
} from '../api/levels'
import LevelsSignalModal from '../components/LevelsSignalModal'

type StatusFilter = 'ALL' | 'OPEN' | 'CLOSED'
type MarketFilter = 'ALL' | 'FOREX' | 'CRYPTO'

const statusBadge: Record<LevelsStatus, { bg: string; text: string; label: string }> = {
  NEW:        { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: 'NEW' },
  ACTIVE:     { bg: 'bg-blue-500/15',   text: 'text-blue-400',   label: 'ACTIVE' },
  TP1_HIT:    { bg: 'bg-green-500/15',  text: 'text-green-400',  label: 'TP1' },
  TP2_HIT:    { bg: 'bg-green-500/20',  text: 'text-green-400',  label: 'TP2' },
  TP3_HIT:    { bg: 'bg-green-500/25',  text: 'text-green-400',  label: 'TP3' },
  CLOSED:     { bg: 'bg-green-500/30',  text: 'text-green-300',  label: 'CLOSED' },
  SL_HIT:     { bg: 'bg-red-500/15',    text: 'text-red-400',    label: 'SL' },
  EXPIRED:    { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'EXP' },
}

function fmtNum(n: number, dec = 5): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  return n.toFixed(dec)
}
function fmtR(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
}
function pricePrecision(symbol: string, market: string): number {
  if (market === 'CRYPTO') return symbol.includes('USDT') ? 2 : 6
  if (/^XAU|^XAG/.test(symbol)) return 2
  if (/JPY/.test(symbol)) return 3
  return 5
}

export default function Levels() {
  const [signals, setSignals] = useState<LevelsSignal[]>([])
  const [stats, setStats] = useState<LevelsStats | null>(null)
  const [config, setConfig] = useState<LevelsConfig | null>(null)
  const [setups, setSetups] = useState<LevelsSetup[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL')
  const [loading, setLoading] = useState(true)
  const [scanRunning, setScanRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LevelsSignal | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const loadSignals = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status: LevelsStatus[] | undefined = statusFilter === 'OPEN'
        ? ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT']
        : statusFilter === 'CLOSED'
        ? ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT']
        : undefined
      const market = marketFilter === 'ALL' ? undefined : marketFilter
      const res = await getLevelsSignals({ status, market, limit: 200 })
      setSignals(res.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, marketFilter])

  const loadStats = useCallback(async () => {
    try { setStats(await getLevelsStats()) } catch (e: any) { console.error(e) }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const r = await getLevelsConfig()
      setConfig(r.config)
      setSetups(r.defaultSetups)
    } catch (e: any) { console.error(e) }
  }, [])

  useEffect(() => { loadSignals() }, [loadSignals])
  useEffect(() => { loadStats(); loadConfig() }, [loadStats, loadConfig])
  // Auto-refresh every 30s for live signals
  useEffect(() => {
    const t = setInterval(() => { loadSignals(); loadStats() }, 30_000)
    return () => clearInterval(t)
  }, [loadSignals, loadStats])

  const handleScanNow = async () => {
    setScanRunning(true)
    try {
      await scanLevelsNow()
      await trackLevelsNow()
      await loadSignals()
      await loadStats()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setScanRunning(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!config) return
    const updated = await updateLevelsConfig({ enabled: !config.enabled })
    setConfig(updated)
  }

  const handleCancel = async (id: number) => {
    if (!confirm('Отменить сигнал?')) return
    await cancelLevelsSignal(id)
    await loadSignals()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Уровни (Live)</h1>
          <p className="text-sm text-text-secondary">Стратегия V2 + Fibo · авто-сигналы каждые 5 мин · Telegram + UI</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleScanNow}
            disabled={scanRunning}
            className="px-4 py-2 bg-accent text-bg-primary rounded font-medium hover:bg-accent/90 disabled:opacity-50"
          >
            {scanRunning ? 'Сканирую…' : 'Скан сейчас'}
          </button>
          <button
            onClick={handleToggleEnabled}
            className={`px-4 py-2 rounded font-medium ${
              config?.enabled
                ? 'bg-long/15 text-long border border-long/40 hover:bg-long/25'
                : 'bg-card border border-input hover:bg-input'
            }`}
          >
            {config?.enabled ? '● Включён' : '○ Выключен'}
          </button>
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input"
          >
            ⚙ Настройки
          </button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && stats.totalTrades > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Stat label="Всего" value={stats.totalTrades.toString()} />
          <Stat label="Win Rate" value={`${(stats.winRate * 100).toFixed(1)}%`} />
          <Stat
            label="Total R"
            value={fmtR(stats.totalR)}
            tone={stats.totalR > 0 ? 'long' : stats.totalR < 0 ? 'short' : 'neutral'}
          />
          <Stat
            label="EV / trade"
            value={fmtR(stats.expectancyR)}
            tone={stats.expectancyR > 0 ? 'long' : 'short'}
          />
          <Stat label="Открытых" value={signals.filter(s => ['NEW','ACTIVE','TP1_HIT','TP2_HIT'].includes(s.status)).length.toString()} />
        </div>
      )}

      {/* Config panel */}
      {showConfig && config && (
        <div className="bg-card border border-input rounded p-4 mb-4">
          <h3 className="font-semibold mb-3">Активные инструменты</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {setups.map(s => {
              const enabledList = config.symbolsEnabled || []
              const isEnabled = enabledList.length === 0 || enabledList.some(e => e.startsWith(s.symbol))
              const sideText = s.side === 'BUY' ? 'LONG' : s.side === 'SELL' ? 'SHORT' : 'BOTH'
              const sideColor = s.side === 'BUY' ? 'text-long' : s.side === 'SELL' ? 'text-short' : 'text-text-primary'
              return (
                <div key={s.symbol} className={`rounded p-3 border ${isEnabled ? 'border-accent/30 bg-accent/5' : 'border-input'}`}>
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-mono font-semibold">{s.symbol}</div>
                      <div className="text-xs text-text-secondary">{s.market} · <span className={sideColor}>{sideText}</span> · fr{s.fractalLR}/{s.fractalLR}</div>
                    </div>
                    <div className={`text-xs ${isEnabled ? 'text-long' : 'text-text-secondary'}`}>{isEnabled ? '●' : '○'}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-text-secondary mt-3">
            Конфигурация загружается из <code>backend/src/services/levelsLiveScanner.ts</code> — DEFAULT_SETUPS.
          </p>
          {config.lastScanAt && (
            <p className="text-xs text-text-secondary mt-2">
              Последний скан: {new Date(config.lastScanAt).toLocaleString('ru-RU')}
            </p>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <FilterButton active={statusFilter === 'OPEN'} onClick={() => setStatusFilter('OPEN')}>Открытые</FilterButton>
        <FilterButton active={statusFilter === 'CLOSED'} onClick={() => setStatusFilter('CLOSED')}>Закрытые</FilterButton>
        <FilterButton active={statusFilter === 'ALL'} onClick={() => setStatusFilter('ALL')}>Все</FilterButton>
        <div className="ml-auto flex gap-2">
          <FilterButton active={marketFilter === 'ALL'} onClick={() => setMarketFilter('ALL')}>Все</FilterButton>
          <FilterButton active={marketFilter === 'FOREX'} onClick={() => setMarketFilter('FOREX')}>Forex</FilterButton>
          <FilterButton active={marketFilter === 'CRYPTO'} onClick={() => setMarketFilter('CRYPTO')}>Crypto</FilterButton>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-short/15 border border-short/30 text-short rounded p-3 mb-4">{error}</div>
      )}

      {/* Signals table */}
      <div className="bg-card border border-input rounded overflow-hidden">
        <table className="w-full text-sm">
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={11} className="text-center py-8 text-text-secondary">Загрузка...</td></tr>
            )}
            {!loading && signals.length === 0 && (
              <tr><td colSpan={11} className="text-center py-8 text-text-secondary">Сигналов нет</td></tr>
            )}
            {!loading && signals.map(s => {
              const dec = pricePrecision(s.symbol, s.market)
              const tps = s.tpLadder.slice(0, 3)
              const sideColor = s.side === 'BUY' ? 'text-long' : 'text-short'
              const sideEmoji = s.side === 'BUY' ? '🟢' : '🔴'
              const badge = statusBadge[s.status]
              const rTone = s.realizedR > 0 ? 'text-long' : s.realizedR < 0 ? 'text-short' : 'text-text-secondary'
              return (
                <tr
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className="border-t border-input hover:bg-input/40 cursor-pointer"
                >
                  <td className="px-3 py-2 text-text-secondary text-xs">
                    {new Date(s.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-3 py-2 font-mono font-semibold">{s.symbol}</td>
                  <td className={`px-3 py-2 font-medium ${sideColor}`}>{sideEmoji} {s.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.event === 'BREAKOUT_RETEST' ? '🚀 BR' : '🎯 React'}
                    {s.isFiboConfluence && <span className="ml-1 text-accent">🌀</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{fmtNum(s.level, dec)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtNum(s.entryPrice, dec)}</td>
                  <td className="px-3 py-2 text-right font-mono text-short">{fmtNum(s.currentStop, dec)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {tps.map(tp => fmtNum(tp, dec)).join(' / ')}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>
                      {badge.label}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${rTone}`}>
                    {s.realizedR !== 0 ? fmtR(s.realizedR) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(s.status === 'NEW' || s.status === 'ACTIVE') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancel(s.id) }}
                        className="text-xs text-text-secondary hover:text-short"
                      >✕</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Per-symbol stats breakdown */}
      {stats && Object.keys(stats.bySymbol).length > 0 && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">По инструментам</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {Object.entries(stats.bySymbol).map(([sym, s]) => (
              <div key={sym} className="bg-card border border-input rounded p-3">
                <div className="font-mono font-semibold">{sym}</div>
                <div className="text-xs text-text-secondary">{s.trades} trades</div>
                <div className={`text-sm font-mono ${s.totalR > 0 ? 'text-long' : s.totalR < 0 ? 'text-short' : 'text-text-secondary'}`}>
                  {fmtR(s.totalR)}
                </div>
                <div className="text-xs text-text-secondary">WR {s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : 0}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <LevelsSignalModal signal={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'long' | 'short' | 'neutral' }) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-input rounded p-3">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-lg font-mono font-semibold ${color}`}>{value}</div>
    </div>
  )
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm font-medium ${
        active
          ? 'bg-accent text-bg-primary'
          : 'bg-card border border-input text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
