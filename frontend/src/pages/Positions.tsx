import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getLivePositions,
  closePosition,
  marketEntry,
  cancelOrder,
  getPnlStats,
  getOrderLogs,
  getCoinStats,
  BybitPosition,
  PnlStats,
  OrderLogEntry,
  CoinStat,
} from '../api/client'
import { useBalance } from '../contexts/BalanceContext'
import PositionCard from '../components/PositionCard'
import PnlSummary from '../components/PnlSummary'
import PnlChart from '../components/PnlChart'
import OrderLogTable, { LogFilters } from '../components/OrderLogTable'

export default function Positions() {
  // Positions state
  const [positions, setPositions] = useState<BybitPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [closingId, setClosingId] = useState<number | null>(null)
  const [actionId, setActionId] = useState<number | null>(null)

  // P&L stats state
  const [stats, setStats] = useState<PnlStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('month')

  // Balance for exposure calculation (from shared context)
  const { budget: balanceBudget } = useBalance()
  const balance = balanceBudget?.balance ?? null

  // Order logs state
  const [logs, setLogs] = useState<OrderLogEntry[]>([])
  const [logsTotal, setLogsTotal] = useState(0)
  const [logsPage, setLogsPage] = useState(1)
  const [logsTotalPages, setLogsTotalPages] = useState(1)
  const [logFilters, setLogFilters] = useState<LogFilters>({})

  // Coin stats state
  const [coinStats, setCoinStats] = useState<CoinStat[]>([])
  const [coinStatsLoading, setCoinStatsLoading] = useState(true)
  const [coinSortKey, setCoinSortKey] = useState<'trades' | 'winRate' | 'totalPnl'>('trades')
  const [coinSortAsc, setCoinSortAsc] = useState(false)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch functions
  const fetchPositions = useCallback(async () => {
    try {
      const res = await getLivePositions()
      setPositions(res.data)
    } catch (err) {
      console.error('Failed to fetch positions:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await getPnlStats(period)
      setStats(res)
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    } finally {
      setStatsLoading(false)
    }
  }, [period])

  const fetchLogs = useCallback(async () => {
    try {
      const res = await getOrderLogs(logsPage, logFilters)
      setLogs(res.data)
      setLogsTotal(res.total)
      setLogsTotalPages(res.totalPages)
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    }
  }, [logsPage, logFilters])

  const fetchCoinStats = useCallback(async () => {
    setCoinStatsLoading(true)
    try {
      const res = await getCoinStats()
      setCoinStats(res.data)
    } catch (err) {
      console.error('Failed to fetch coin stats:', err)
    } finally {
      setCoinStatsLoading(false)
    }
  }, [])

  // Initial load and polling
  useEffect(() => {
    fetchPositions()
    // Poll positions every 10 seconds for live P&L
    intervalRef.current = setInterval(fetchPositions, 10000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchPositions])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    fetchCoinStats()
  }, [fetchCoinStats])

  // Balance is read from BalanceContext (shared polling, no local fetch needed)

  // Close position handler
  const handleClose = async (id: number) => {
    setClosingId(id)
    try {
      await closePosition(id)
      await fetchPositions()
    } catch (err: any) {
      alert(err.message || 'Failed to close position')
    } finally {
      setClosingId(null)
    }
  }

  // Market entry handler
  const handleMarketEntry = async (id: number) => {
    setActionId(id)
    try {
      await marketEntry(id)
      await fetchPositions()
    } catch (err: any) {
      alert(err.message || 'Failed to enter market')
    } finally {
      setActionId(null)
    }
  }

  // Cancel order handler
  const handleCancel = async (id: number) => {
    setActionId(id)
    try {
      await cancelOrder(id)
      await fetchPositions()
    } catch (err: any) {
      alert(err.message || 'Failed to cancel order')
    } finally {
      setActionId(null)
    }
  }

  const handlePeriodChange = (p: 'day' | 'week' | 'month') => {
    setPeriod(p)
  }

  const handleLogFiltersChange = (f: LogFilters) => {
    setLogFilters(f)
    setLogsPage(1) // Reset to first page on filter change
  }

  const handleCoinSort = (key: 'trades' | 'winRate' | 'totalPnl') => {
    if (coinSortKey === key) {
      setCoinSortAsc(!coinSortAsc)
    } else {
      setCoinSortKey(key)
      setCoinSortAsc(false)
    }
  }

  const sortedCoinStats = [...coinStats].sort((a, b) => {
    const diff = a[coinSortKey] - b[coinSortKey]
    return coinSortAsc ? diff : -diff
  })

  const openPositions = positions.filter(
    (p) => p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED' || p.status === 'PENDING_ENTRY'
  )

  const totalMargin = openPositions.reduce((sum, p) => sum + (p.margin || 0), 0)
  const exposurePct = balance && balance > 0 ? (totalMargin / balance) * 100 : 0

  return (
    <div>
      <h1 className="text-2xl font-semibold text-text-primary mb-6">Positions</h1>

      {openPositions.length > 0 && (
        <div className="flex items-center gap-4 mb-6 text-sm">
          <span className="text-text-secondary">Exposure:</span>
          <span className="font-mono text-text-primary">
            ${totalMargin.toFixed(2)}
            {balance !== null && (
              <span className="text-text-secondary"> / ${balance.toFixed(2)} ({exposurePct.toFixed(2)}%)</span>
            )}
          </span>
        </div>
      )}

      {/* P&L Summary */}
      <section className="bg-card rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">P&L Summary</h2>
        <PnlSummary
          stats={stats}
          period={period}
          onPeriodChange={handlePeriodChange}
          loading={statsLoading}
        />
      </section>

      {/* P&L Chart */}
      <section className="bg-card rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Cumulative P&L</h2>
        <PnlChart data={stats?.dailySeries || []} />
      </section>

      {/* Open Positions */}
      <section className="bg-card rounded-xl p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Open Positions</h2>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent">
            {openPositions.length}
          </span>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-input rounded-xl p-5 h-64 animate-pulse" />
            ))}
          </div>
        ) : openPositions.length === 0 ? (
          <div className="text-center text-text-secondary text-sm py-12">
            No open positions
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {openPositions.map((pos) => (
              <PositionCard
                key={pos.id}
                position={pos}
                onClose={handleClose}
                onMarketEntry={handleMarketEntry}
                onCancel={handleCancel}
                closingId={closingId}
                actionId={actionId}
              />
            ))}
          </div>
        )}
      </section>

      {/* Coin Performance */}
      <section className="bg-card rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Win Rate by Coin</h2>
        {coinStatsLoading ? (
          <div className="text-text-secondary text-sm py-4">Loading...</div>
        ) : coinStats.length === 0 ? (
          <div className="text-center text-text-secondary text-sm py-8">No closed positions yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary text-xs border-b border-input">
                  <th className="text-left py-2 px-3 font-medium">Coin</th>
                  <th className="text-right py-2 px-3 font-medium cursor-pointer hover:text-text-primary" onClick={() => handleCoinSort('trades')}>
                    Trades {coinSortKey === 'trades' ? (coinSortAsc ? '↑' : '↓') : ''}
                  </th>
                  <th className="text-right py-2 px-3 font-medium">Wins</th>
                  <th className="text-right py-2 px-3 font-medium cursor-pointer hover:text-text-primary" onClick={() => handleCoinSort('winRate')}>
                    Win Rate {coinSortKey === 'winRate' ? (coinSortAsc ? '↑' : '↓') : ''}
                  </th>
                  <th className="text-right py-2 px-3 font-medium">Avg P&L</th>
                  <th className="text-right py-2 px-3 font-medium cursor-pointer hover:text-text-primary" onClick={() => handleCoinSort('totalPnl')}>
                    Total P&L {coinSortKey === 'totalPnl' ? (coinSortAsc ? '↑' : '↓') : ''}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedCoinStats.map((stat) => (
                  <tr key={stat.coin} className="border-b border-input/50 hover:bg-input/30">
                    <td className="py-2 px-3 font-mono font-semibold text-text-primary">{stat.coin}</td>
                    <td className="py-2 px-3 font-mono text-text-primary text-right">{stat.trades}</td>
                    <td className="py-2 px-3 font-mono text-text-primary text-right">{stat.wins}</td>
                    <td className="py-2 px-3 font-mono text-right">
                      <span className={stat.winRate >= 50 ? 'text-long' : 'text-short'}>{stat.winRate}%</span>
                    </td>
                    <td className="py-2 px-3 font-mono text-right">
                      <span className={stat.avgPnl >= 0 ? 'text-long' : 'text-short'}>
                        {stat.avgPnl >= 0 ? '+' : ''}${stat.avgPnl.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono text-right">
                      <span className={stat.totalPnl >= 0 ? 'text-long' : 'text-short'}>
                        {stat.totalPnl >= 0 ? '+' : ''}${stat.totalPnl.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Order Log */}
      <section className="bg-card rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Trade Log</h2>
        <OrderLogTable
          logs={logs}
          total={logsTotal}
          page={logsPage}
          totalPages={logsTotalPages}
          onPageChange={setLogsPage}
          filters={logFilters}
          onFiltersChange={handleLogFiltersChange}
        />
      </section>
    </div>
  )
}
