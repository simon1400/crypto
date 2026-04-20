import { useState, useEffect } from 'react'
import { Signal, SignalsResponse, getSignals, syncSignals, clearSignals, getSignalPrices, getSettings, saveSettings, executeSignal } from '../api/client'
import { sanitizeCsvField } from '../utils/sanitizeCsv'
import SignalTable from '../components/SignalTable'
import SignalModal from '../components/signals/SignalModal'
import DepositSimulator from '../components/signals/DepositSimulator'
import StrategyAnalysis from '../components/signals/StrategyAnalysis'

function exportCSV(signals: Signal[], prices: Record<string, number | null>, channel: string) {
  const esc = (v: string | number) => {
    const s = String(v)
    return `"${sanitizeCsvField(s).replace(/"/g, '""')}"`
  }
  const header = ['Дата', 'Тип', 'Монета', 'Цена', 'Плечо', 'Вход мин', 'Вход макс', 'SL', 'TP1', 'TP2', 'TP3', 'TP4', 'TP5', 'TP6', 'Статус', 'P&L %'].map(h => esc(h)).join(',')
  const rows = signals.map(s => {
    const entry = (s.entryMin + s.entryMax) / 2
    let pnl = ''
    if (s.status === 'SL_HIT') {
      const diff = s.type === 'LONG'
        ? ((s.stopLoss - entry) / entry) * 100
        : ((entry - s.stopLoss) / entry) * 100
      pnl = (diff * s.leverage).toFixed(2)
    } else if (s.status.startsWith('TP')) {
      const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
      const tp = s.takeProfits[tpIdx]
      if (tp != null) {
        const diff = s.type === 'LONG'
          ? ((tp - entry) / entry) * 100
          : ((entry - tp) / entry) * 100
        pnl = '+' + (diff * s.leverage).toFixed(2)
      }
    }
    const price: string | number = prices[s.coin] != null ? prices[s.coin]! : ''
    const date = new Date(s.publishedAt).toLocaleString('ru-RU')
    return [date, s.type, s.coin, price, s.leverage + 'x', s.entryMin, s.entryMax, s.stopLoss, ...Array.from({ length: 6 }, (_, i) => s.takeProfits[i] ?? ''), s.status, pnl].map(v => esc(v)).join(',')
  })

  const csv = '\uFEFF' + header + '\n' + rows.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `signals_${channel}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const CHANNELS = [
  { value: 'EveningTrader', label: 'EveningTrader' },
  { value: 'ETG', label: 'ETG x CSF Copytrading VIP' },
]

export default function Signals() {
  const [channel, setChannel] = useState<string>(() => localStorage.getItem('signals_channel') || 'EveningTrader')
  const [days, setDays] = useState(7)

  useEffect(() => {
    localStorage.setItem('signals_channel', channel)
  }, [channel])
  const [data, setData] = useState<SignalsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Signal | null>(null)
  const [prices, setPrices] = useState<Record<string, number | null>>({})
  const [syncedDays, setSyncedDays] = useState<number | null>(null)
  const [tradingMode, setTradingMode] = useState<string>('manual')

  useEffect(() => {
    getSettings().then(s => setTradingMode(s.tradingMode)).catch(() => {})
  }, [])

  const handleModeToggle = async (mode: 'manual' | 'auto') => {
    try {
      await saveSettings({ tradingMode: mode })
      setTradingMode(mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update mode')
    }
  }

  const handleExecuteSignal = async (signal: Signal) => {
    try {
      await executeSignal(signal.id)
      alert(`Сделка по ${signal.coin} отправлена на Bybit`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Execution failed')
    }
  }

  const fetchPrices = async (signals: Signal[]) => {
    const coins = [...new Set(signals.map(s => s.coin))]
    if (coins.length > 0) {
      const p = await getSignalPrices(coins)
      setPrices(p)
    }
  }

  const handleLoad = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getSignals(channel, days)
      setData(result)
      setSyncedDays(days)
      fetchPrices(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const result = await syncSignals(channel, days)
      setData(result)
      setSyncedDays(days)
      fetchPrices(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации')
    } finally {
      setSyncing(false)
    }
  }

  const handleClear = async () => {
    if (!confirm(`Удалить все сигналы ${channel} за ${days} дн.?`)) return
    setError(null)
    try {
      const result = await clearSignals(channel, days)
      setData(null)
      setSyncedDays(null)
      alert(`Удалено ${result.deleted} сигналов`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления')
    }
  }

  // Stats & analytics
  const stats = data ? (() => {
    let totalPnl = 0
    let closedCount = 0
    const winPnls: number[] = []
    const lossPnls: number[] = []
    const leverageStats: Record<string, { wins: number; losses: number }> = {}
    const directionStats = { longWins: 0, longLosses: 0, shortWins: 0, shortLosses: 0 }
    let tp2plus = 0

    for (const s of data.data) {
      const entry = (s.entryMin + s.entryMax) / 2
      const levKey = s.leverage <= 5 ? '1-5x' : s.leverage <= 10 ? '6-10x' : '11x+'
      if (!leverageStats[levKey]) leverageStats[levKey] = { wins: 0, losses: 0 }

      if (s.status === 'SL_HIT') {
        const diff = s.type === 'LONG'
          ? ((s.stopLoss - entry) / entry) * 100
          : ((entry - s.stopLoss) / entry) * 100
        const pnl = diff * s.leverage
        totalPnl += pnl
        closedCount++
        lossPnls.push(pnl)
        leverageStats[levKey].losses++
        if (s.type === 'LONG') directionStats.longLosses++
        else directionStats.shortLosses++
      } else if (s.status.startsWith('TP')) {
        const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
        const tp = s.takeProfits[tpIdx]
        if (tp != null) {
          const diff = s.type === 'LONG'
            ? ((tp - entry) / entry) * 100
            : ((entry - tp) / entry) * 100
          const pnl = diff * s.leverage
          totalPnl += pnl
          closedCount++
          winPnls.push(pnl)
          leverageStats[levKey].wins++
          if (s.type === 'LONG') directionStats.longWins++
          else directionStats.shortWins++
          if (tpIdx >= 1) tp2plus++
        }
      }
    }

    const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0
    const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0

    return {
      total: data.data.length,
      active: data.data.filter(s => s.status === 'ACTIVE' || s.status === 'ENTRY_WAIT').length,
      tp: data.data.filter(s => s.status.startsWith('TP')).length,
      sl: data.data.filter(s => s.status === 'SL_HIT').length,
      totalPnl,
      closedCount,
      avgWin,
      avgLoss,
      leverageStats,
      directionStats,
      tp2plus,
      winrate: closedCount > 0 ? (winPnls.length / closedCount) * 100 : 0,
    }
  })() : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold">Сигналы</h1>
          <p className="text-text-secondary mt-1">Мониторинг торговых сигналов из Telegram</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Channel selector */}
          <select
            value={channel}
            onChange={e => {
              setChannel(e.target.value)
              setData(null)
              setSyncedDays(null)
            }}
            className="bg-input text-text-primary rounded-lg px-3 py-2.5 text-sm border border-card focus:border-accent outline-none"
          >
            {CHANNELS.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>

          {/* Period selector */}
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="bg-input text-text-primary rounded-lg px-3 py-2.5 text-sm border border-card focus:border-accent outline-none"
          >
            <option value={3}>3 дня</option>
            <option value={7}>Неделя</option>
            <option value={14}>2 недели</option>
            <option value={30}>Месяц</option>
            <option value={90}>3 месяца</option>
          </select>

          <button
            onClick={handleLoad}
            disabled={loading}
            className="px-4 py-2.5 bg-card text-text-primary rounded-lg text-sm hover:bg-input transition-colors disabled:opacity-50"
          >
            {loading ? 'Загрузка...' : 'Загрузить'}
          </button>

          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-5 py-2.5 bg-accent text-primary font-bold rounded-lg text-sm hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? 'Синхронизирую...' : 'Синхронизировать'}
          </button>

          <button
            onClick={handleClear}
            className="px-4 py-2.5 bg-short/20 text-short rounded-lg text-sm hover:bg-short/30 transition-colors"
          >
            Очистить
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-short/10 border border-short/30 rounded-lg px-4 py-3 text-short text-sm">
          {error}
        </div>
      )}

      {/* Date range */}
      {data && syncedDays && (
        <div className="text-sm text-text-secondary">
          Период: <span className="text-text-primary font-medium">
            {new Date(Date.now() - syncedDays * 24 * 60 * 60 * 1000).toLocaleDateString('ru-RU')}
          </span> — <span className="text-text-primary font-medium">
            {new Date().toLocaleDateString('ru-RU')}
          </span>
          <span className="ml-2 text-xs">({data.data.length} сигналов)</span>
          <button
            onClick={() => exportCSV(data.data, prices, channel)}
            className="ml-3 px-3 py-1 bg-input text-text-secondary rounded-lg text-xs hover:text-text-primary transition-colors"
          >
            CSV
          </button>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-5 gap-3">
          <div className="bg-card rounded-lg p-4 text-center">
            <div className="text-xs text-text-secondary">Всего</div>
            <div className="font-mono text-2xl font-bold text-text-primary">{stats.total}</div>
          </div>
          <div className="bg-card rounded-lg p-4 text-center">
            <div className="text-xs text-text-secondary">Активных</div>
            <div className="font-mono text-2xl font-bold text-blue-400">{stats.active}</div>
          </div>
          <div className="bg-card rounded-lg p-4 text-center">
            <div className="text-xs text-text-secondary">Take Profit</div>
            <div className="font-mono text-2xl font-bold text-long">{stats.tp}</div>
          </div>
          <div className="bg-card rounded-lg p-4 text-center">
            <div className="text-xs text-text-secondary">Stop Loss</div>
            <div className="font-mono text-2xl font-bold text-short">{stats.sl}</div>
          </div>
          <div className={`rounded-lg p-4 text-center border ${stats.totalPnl >= 0 ? 'bg-long/10 border-long/30' : 'bg-short/10 border-short/30'}`}>
            <div className="text-xs text-text-secondary">Общий P&L</div>
            <div className={`font-mono text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-long' : 'text-short'}`}>
              {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toFixed(2)}%
            </div>
            <div className="text-xs text-text-secondary mt-0.5">{stats.closedCount} сделок</div>
          </div>
        </div>
      )}

      {/* Analytics */}
      {stats && stats.closedCount > 0 && (
        <div className="bg-card rounded-xl p-5 border border-card">
          <h3 className="text-lg font-semibold mb-4">Аналитика</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-input rounded-lg p-3">
              <div className="text-xs text-text-secondary mb-1">Средний P&L на победу</div>
              <div className="font-mono text-lg font-bold text-long">+{stats.avgWin.toFixed(2)}%</div>
            </div>
            <div className="bg-input rounded-lg p-3">
              <div className="text-xs text-text-secondary mb-1">Средний P&L на поражение</div>
              <div className="font-mono text-lg font-bold text-short">{stats.avgLoss.toFixed(2)}%</div>
            </div>
            <div className="bg-input rounded-lg p-3">
              <div className="text-xs text-text-secondary mb-1">Винрейт</div>
              <div className="font-mono text-lg font-bold text-text-primary">{stats.winrate.toFixed(0)}%</div>
            </div>
            <div className="bg-input rounded-lg p-3">
              <div className="text-xs text-text-secondary mb-1">Дошли до TP2+</div>
              <div className="font-mono text-lg font-bold text-accent">
                {stats.tp2plus} <span className="text-sm text-text-secondary">/ {stats.tp}</span>
              </div>
            </div>
          </div>

          {/* Long vs Short */}
          <div className="mt-4 grid grid-cols-2 gap-3">
            {(() => {
              const lt = stats.directionStats.longWins + stats.directionStats.longLosses
              const st = stats.directionStats.shortWins + stats.directionStats.shortLosses
              const lwr = lt > 0 ? (stats.directionStats.longWins / lt) * 100 : 0
              const swr = st > 0 ? (stats.directionStats.shortWins / st) * 100 : 0
              return (<>
                <div className="bg-input rounded-lg p-3">
                  <div className="text-xs text-text-secondary mb-1">LONG</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-lg font-bold text-long">{lwr.toFixed(0)}%</span>
                    <span className="text-xs text-text-secondary">
                      <span className="text-long">{stats.directionStats.longWins}W</span> / <span className="text-short">{stats.directionStats.longLosses}L</span>
                      <span className="ml-1">({lt} сделок)</span>
                    </span>
                  </div>
                </div>
                <div className="bg-input rounded-lg p-3">
                  <div className="text-xs text-text-secondary mb-1">SHORT</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-lg font-bold text-short">{swr.toFixed(0)}%</span>
                    <span className="text-xs text-text-secondary">
                      <span className="text-long">{stats.directionStats.shortWins}W</span> / <span className="text-short">{stats.directionStats.shortLosses}L</span>
                      <span className="ml-1">({st} сделок)</span>
                    </span>
                  </div>
                </div>
              </>)
            })()}
          </div>

          {/* Leverage breakdown */}
          <div className="mt-4">
            <div className="text-xs text-text-secondary mb-2">Результат по плечам</div>
            <div className="flex gap-3">
              {Object.entries(stats.leverageStats)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([lev, s]) => {
                  const total = s.wins + s.losses
                  const wr = total > 0 ? (s.wins / total) * 100 : 0
                  return (
                    <div key={lev} className="bg-input rounded-lg p-3 flex-1">
                      <div className="text-xs text-text-secondary mb-1">{lev}</div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono font-bold text-text-primary">{wr.toFixed(0)}%</span>
                        <span className="text-xs text-text-secondary">
                          <span className="text-long">{s.wins}W</span> / <span className="text-short">{s.losses}L</span>
                        </span>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      )}

      {/* Strategy Analysis */}
      {stats && stats.closedCount >= 10 && (
        <StrategyAnalysis stats={stats} />
      )}

      {/* Deposit Simulator */}
      {data && !loading && !syncing && data.data.some(s => s.status === 'SL_HIT' || s.status.startsWith('TP')) && (
        <DepositSimulator signals={data.data} />
      )}

      {/* Loading */}
      {(loading || syncing) && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-text-secondary mt-3">
            {syncing ? 'Синхронизирую сигналы из Telegram...' : 'Загружаю сигналы...'}
          </p>
        </div>
      )}

      {/* Table */}
      {data && !loading && !syncing && (
        <div className="bg-card rounded-xl overflow-hidden">
          <SignalTable
            signals={data.data}
            prices={prices}
            onSelect={setSelected}
            tradingMode={tradingMode}
            onModeToggle={handleModeToggle}
            onExecuteSignal={handleExecuteSignal}
          />
        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !syncing && (
        <div className="text-center py-16 text-text-secondary">
          <p className="text-lg">Нажми «Синхронизировать» чтобы загрузить сигналы из Telegram</p>
          <p className="text-sm mt-2">Или «Загрузить» чтобы посмотреть уже сохранённые</p>
        </div>
      )}

      {/* Modal */}
      {selected && <SignalModal signal={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
