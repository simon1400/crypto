import { useState } from 'react'
import { Signal, SignalsResponse, getSignals, syncSignals, getSignalPrices } from '../api/client'
import SignalTable from '../components/SignalTable'
import SignalBadge from '../components/SignalBadge'
import SignalChart from '../components/SignalChart'

const CHANNELS = [
  { id: 'EveningTrader', name: 'Evening Trader' },
]

function formatPrice(n: number): string {
  if (n >= 1) return n.toFixed(2)
  if (n >= 0.01) return n.toFixed(4)
  return n.toFixed(5)
}

function SignalModal({ signal, onClose }: { signal: Signal; onClose: () => void }) {
  const entry = (signal.entryMin + signal.entryMax) / 2

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-card rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl font-bold text-text-primary">{signal.coin}</span>
            <span className={`text-lg font-bold ${signal.type === 'LONG' ? 'text-long' : 'text-short'}`}>
              {signal.type}
            </span>
            <span className="text-text-secondary font-mono">{signal.leverage}x</span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">
            ✕
          </button>
        </div>

        {/* Status */}
        <div className="mb-5">
          <SignalBadge status={signal.status} type={signal.type} />
          <span className="ml-3 text-xs text-text-secondary">
            {new Date(signal.publishedAt).toLocaleString('ru-RU')}
          </span>
        </div>

        {/* Price levels grid */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-input rounded-lg p-3">
            <div className="text-xs text-text-secondary mb-1">Вход</div>
            <div className="font-mono font-bold text-accent">
              {formatPrice(signal.entryMin)}
              {signal.entryMin !== signal.entryMax && ` - ${formatPrice(signal.entryMax)}`}
            </div>
          </div>
          <div className="bg-input rounded-lg p-3">
            <div className="text-xs text-text-secondary mb-1">Stop Loss</div>
            <div className="font-mono font-bold text-short">
              {formatPrice(signal.stopLoss)}
              <span className="text-xs text-text-secondary ml-1">
                ({(((Math.abs(signal.stopLoss - entry)) / entry) * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Take Profits */}
        <div className="mb-5">
          <div className="text-xs text-text-secondary mb-2">Take Profits</div>
          <div className="grid grid-cols-5 gap-2">
            {signal.takeProfits.map((tp, i) => {
              const tpHit = signal.status.startsWith('TP')
                && parseInt(signal.status.replace('TP', '').replace('_HIT', '')) > i
              const diff = ((Math.abs(tp - entry)) / entry) * 100
              return (
                <div
                  key={i}
                  className={`rounded-lg p-2.5 text-center ${
                    tpHit ? 'bg-long/20 border border-long/30' : 'bg-input'
                  }`}
                >
                  <div className="text-xs text-text-secondary mb-1">TP{i + 1}</div>
                  <div className={`font-mono text-sm font-bold ${tpHit ? 'text-long' : 'text-text-primary'}`}>
                    {formatPrice(tp)}
                  </div>
                  <div className="text-xs text-text-secondary">+{diff.toFixed(1)}%</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Chart */}
        <div className="mb-4">
          <div className="text-xs text-text-secondary mb-2">График цены</div>
          <SignalChart signal={signal} />
        </div>

        {/* Metadata */}
        <div className="text-xs text-text-secondary space-y-1">
          <div>Канал: {signal.channel}</div>
          {signal.entryFilledAt && (
            <div>Вход заполнен: {new Date(signal.entryFilledAt).toLocaleString('ru-RU')}</div>
          )}
          {signal.statusUpdatedAt && (
            <div>Обновлено: {new Date(signal.statusUpdatedAt).toLocaleString('ru-RU')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Signals() {
  const [channel, setChannel] = useState('EveningTrader')
  const [days, setDays] = useState(7)
  const [data, setData] = useState<SignalsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Signal | null>(null)
  const [prices, setPrices] = useState<Record<string, number | null>>({})
  const [syncedDays, setSyncedDays] = useState<number | null>(null)

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

  // Stats summary
  const stats = data ? (() => {
    let totalPnl = 0
    let closedCount = 0
    for (const s of data.data) {
      const entry = (s.entryMin + s.entryMax) / 2
      if (s.status === 'SL_HIT') {
        const diff = s.type === 'LONG'
          ? ((s.stopLoss - entry) / entry) * 100
          : ((entry - s.stopLoss) / entry) * 100
        totalPnl += diff * s.leverage
        closedCount++
      } else if (s.status.startsWith('TP')) {
        const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
        const tp = s.takeProfits[tpIdx]
        if (tp != null) {
          const diff = s.type === 'LONG'
            ? ((tp - entry) / entry) * 100
            : ((entry - tp) / entry) * 100
          totalPnl += diff * s.leverage
          closedCount++
        }
      }
    }
    return {
      total: data.data.length,
      active: data.data.filter(s => s.status === 'ACTIVE' || s.status === 'ENTRY_WAIT').length,
      tp: data.data.filter(s => s.status.startsWith('TP')).length,
      sl: data.data.filter(s => s.status === 'SL_HIT').length,
      totalPnl,
      closedCount,
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
            onChange={e => setChannel(e.target.value)}
            className="bg-input text-text-primary rounded-lg px-3 py-2.5 text-sm border border-card focus:border-accent outline-none"
          >
            {CHANNELS.map(ch => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
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
              {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toFixed(1)}%
            </div>
            <div className="text-xs text-text-secondary mt-0.5">{stats.closedCount} сделок</div>
          </div>
        </div>
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
          <SignalTable signals={data.data} prices={prices} onSelect={setSelected} />
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
