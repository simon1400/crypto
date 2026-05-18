/**
 * Variant C LIVE — Binance Futures real-money panel.
 *
 * Distinct from paper-trader panels: shows connectivity status to Binance,
 * REAL MONEY badge, kill switch, and testnet-only sanity-check controls.
 * Day-1 surface is intentionally minimal — the strategy itself doesn't trade
 * yet; this panel is for verifying the bridge between our backend and Binance
 * works (signing, order placement, reconciliation).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  getLiveConfig, updateLiveConfig, getLiveStatus, getLiveTrades,
  killSwitch, releaseKillSwitch, testPlaceOrder, cancelTestOrders,
  type BreakoutLiveConfig, type BreakoutLiveStatus, type BreakoutLiveTrade,
} from '../api/breakoutLiveC'
import { formatDate, fmt2, fmt2Signed, formatPrice } from '../lib/formatters'

export default function BreakoutLiveCPanel() {
  const [config, setConfig] = useState<BreakoutLiveConfig | null>(null)
  const [status, setStatus] = useState<BreakoutLiveStatus | null>(null)
  const [trades, setTrades] = useState<BreakoutLiveTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [testSymbol, setTestSymbol] = useState('BTCUSDT')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [c, s, t] = await Promise.all([
        getLiveConfig(),
        getLiveStatus(),
        getLiveTrades({ limit: 50 }),
      ])
      setConfig(c)
      setStatus(s)
      setTrades(t.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => { getLiveStatus().then(setStatus).catch(() => {}) }, 10_000)
    return () => clearInterval(t)
  }, [])

  async function handleToggleEnabled() {
    if (!config) return
    const next = !config.enabled
    if (next && !config.useTestnet) {
      if (!confirm('Включить C-live на PROD Binance с РЕАЛЬНЫМИ деньгами? Стратегия начнёт ставить ордера.')) return
    }
    const updated = await updateLiveConfig({ enabled: next })
    setConfig(updated)
  }

  async function handleToggleTestnet() {
    if (!config) return
    if (config.enabled) {
      alert('Сначала отключите strategy (enabled=off), затем меняйте сеть.')
      return
    }
    const updated = await updateLiveConfig({ useTestnet: !config.useTestnet })
    setConfig(updated)
    await load()
  }

  async function handleKill() {
    const reason = prompt('Причина kill switch (необязательно):', 'manual')
    if (reason === null) return
    if (!confirm('Закрыть ВСЕ позиции по рынку + отменить все ордера + выключить strategy?')) return
    setActionMsg('Killing...')
    try {
      const r = await killSwitch(reason)
      setActionMsg(`Kill OK: cancelled=${r.cancelledOrders ?? 0}, closed=${r.closedPositions ?? 0}${r.note ? ' (' + r.note + ')' : ''}`)
      await load()
    } catch (e: any) {
      setActionMsg(`Kill failed: ${e.message}`)
    }
  }

  async function handleReleaseKill() {
    if (!confirm('Снять kill switch? Strategy останется выключенной — включите её отдельно.')) return
    try {
      const c = await releaseKillSwitch()
      setConfig(c)
      setActionMsg('Kill switch released')
    } catch (e: any) {
      setActionMsg(`Release failed: ${e.message}`)
    }
  }

  async function handleTestOrder(side: 'BUY' | 'SELL') {
    setActionMsg(`Placing test ${side}...`)
    try {
      const r = await testPlaceOrder({ symbol: testSymbol, side, priceOffsetPct: 5 })
      setActionMsg(`Test order placed: ${r.placed?.clientOrderId} (${r.placed?.symbol} ${r.placed?.side} @ ${r.placed?.price})`)
      await load()
    } catch (e: any) {
      setActionMsg(`Test order failed: ${e.message}`)
    }
  }

  async function handleCancelTestOrders() {
    setActionMsg(`Cancelling all open orders for ${testSymbol}...`)
    try {
      await cancelTestOrders(testSymbol)
      setActionMsg(`Cancelled all open orders for ${testSymbol}`)
      await load()
    } catch (e: any) {
      setActionMsg(`Cancel failed: ${e.message}`)
    }
  }

  if (loading) {
    return <div className="text-text-secondary text-sm py-8 text-center">Загрузка...</div>
  }

  if (!config) {
    return <div className="text-short text-sm py-8 text-center">Не удалось загрузить конфиг</div>
  }

  const isTestnet = config.useTestnet
  const isLive = !isTestnet

  return (
    <div className="space-y-4">
      {/* === Header: REAL MONEY badge + status === */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Daily Breakout — C LIVE</h1>
        {isLive ? (
          <span className="px-3 py-1 rounded font-mono text-xs bg-short text-white animate-pulse">
            ⚠ REAL MONEY · Binance PROD
          </span>
        ) : (
          <span className="px-3 py-1 rounded font-mono text-xs bg-accent/15 text-accent">
            TESTNET
          </span>
        )}
        {config.killSwitchActive && (
          <span className="px-3 py-1 rounded font-mono text-xs bg-short/20 text-short">
            🛑 KILLED: {config.killSwitchReason ?? 'unknown'}
          </span>
        )}
      </div>

      <p className="text-sm text-text-secondary">
        Реальная торговля C на Binance Futures USDT-M. Та же стратегия что paper C,
        но ордера ставятся на бирже. Депо изолирован от paper.
        Ключи добавляются на странице <a href="/settings" className="text-accent hover:underline">Настройки</a>.
      </p>

      {/* === Connectivity card === */}
      <div className="bg-card rounded-lg p-4 border border-input">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.connected ? 'bg-long' : 'bg-short'}`} />
            <span className="font-medium">
              {status?.connected ? `Подключено к Binance (${status.net})` : 'НЕТ подключения'}
            </span>
          </div>
          <button onClick={load} className="px-3 py-1 rounded text-xs bg-input hover:bg-input/70">
            Обновить
          </button>
        </div>
        {!status?.connected && (
          <div className="text-short text-xs font-mono p-2 bg-short/10 rounded">
            {status?.reason ?? 'неизвестная ошибка'}
          </div>
        )}
        {status?.connected && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Metric label="Баланс USDT" value={fmt2(status.balanceUsdt ?? 0)} mono />
            <Metric label="Открытых позиций" value={String(status.openPositions ?? 0)} />
            <Metric label="Открытых ордеров" value={String(status.openOrders ?? 0)} />
            <Metric label="API weight 1m" value={`${status.usedWeight1m ?? 0} / 2400`} mono />
          </div>
        )}
        {status?.positions && status.positions.length > 0 && (
          <div className="mt-3 text-xs">
            <div className="text-text-secondary mb-1">Позиции на Binance:</div>
            <table className="w-full font-mono">
              <thead className="text-text-secondary">
                <tr><th className="text-left">Symbol</th><th className="text-right">Qty</th><th className="text-right">Entry</th><th className="text-right">Mark</th><th className="text-right">uPnL</th><th className="text-right">Lev</th></tr>
              </thead>
              <tbody>
                {status.positions.map(p => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td className="text-right">{p.positionAmt}</td>
                    <td className="text-right">{formatPrice(p.entryPrice)}</td>
                    <td className="text-right">{formatPrice(p.markPrice)}</td>
                    <td className={`text-right ${p.unRealizedProfit >= 0 ? 'text-long' : 'text-short'}`}>{fmt2Signed(p.unRealizedProfit)}</td>
                    <td className="text-right">×{p.leverage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {status?.orders && status.orders.length > 0 && (
          <div className="mt-3 text-xs">
            <div className="text-text-secondary mb-1">Открытые ордера на Binance:</div>
            <table className="w-full font-mono">
              <thead className="text-text-secondary">
                <tr><th className="text-left">cID</th><th className="text-left">Symbol</th><th className="text-left">Side/Type</th><th className="text-right">Price</th><th className="text-right">Qty</th><th className="text-left">Status</th></tr>
              </thead>
              <tbody>
                {status.orders.map(o => (
                  <tr key={o.orderId}>
                    <td className="truncate max-w-[140px]">{o.clientOrderId}</td>
                    <td>{o.symbol}</td>
                    <td>{o.side} {o.type}</td>
                    <td className="text-right">{formatPrice(o.type.includes('STOP') ? o.stopPrice : o.price)}</td>
                    <td className="text-right">{o.origQty}</td>
                    <td>{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* === Controls === */}
      <div className="bg-card rounded-lg p-4 border border-input space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleToggleEnabled}
            disabled={config.killSwitchActive}
            className={`px-4 py-2 rounded font-medium text-sm transition-colors ${
              config.enabled
                ? 'bg-long/20 text-long hover:bg-long/30'
                : 'bg-input text-text-secondary hover:bg-input/70'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {config.enabled ? '● Strategy включена' : '○ Strategy выключена'}
          </button>

          <button
            onClick={handleToggleTestnet}
            disabled={config.enabled}
            className="px-4 py-2 rounded text-sm bg-input hover:bg-input/70 disabled:opacity-50 disabled:cursor-not-allowed"
            title={config.enabled ? 'Сначала выключите strategy' : ''}
          >
            Сеть: {isTestnet ? 'TESTNET' : 'PROD'} → переключить
          </button>

          {config.killSwitchActive ? (
            <button
              onClick={handleReleaseKill}
              className="px-4 py-2 rounded text-sm bg-accent/20 text-accent hover:bg-accent/30"
            >
              Снять kill switch
            </button>
          ) : (
            <button
              onClick={handleKill}
              className="px-4 py-2 rounded text-sm bg-short/20 text-short hover:bg-short/30 font-medium"
            >
              🛑 KILL SWITCH
            </button>
          )}
        </div>

        {actionMsg && (
          <div className="text-xs font-mono p-2 bg-input/50 rounded">
            {actionMsg}
          </div>
        )}
      </div>

      {/* === Testnet smoke-test controls === */}
      {isTestnet && (
        <div className="bg-card rounded-lg p-4 border border-accent/30">
          <div className="text-sm font-medium mb-2 text-accent">🧪 Testnet smoke test</div>
          <div className="text-xs text-text-secondary mb-3">
            Ставит LIMIT GTC на 5% от mark price — не зафиллится. Доступно только на testnet.
            Проверяет подпись, leverage, что ордер дошёл до биржи.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={testSymbol}
              onChange={e => setTestSymbol(e.target.value.toUpperCase())}
              className="px-3 py-1.5 rounded bg-input text-sm font-mono w-32"
              placeholder="SYMBOL"
            />
            <button onClick={() => handleTestOrder('BUY')} className="px-3 py-1.5 rounded text-xs bg-long/20 text-long hover:bg-long/30">
              Place BUY @ -5%
            </button>
            <button onClick={() => handleTestOrder('SELL')} className="px-3 py-1.5 rounded text-xs bg-short/20 text-short hover:bg-short/30">
              Place SELL @ +5%
            </button>
            <button onClick={handleCancelTestOrders} className="px-3 py-1.5 rounded text-xs bg-input hover:bg-input/70">
              Cancel all {testSymbol}
            </button>
          </div>
        </div>
      )}

      {/* === Config preview === */}
      <details className="bg-card rounded-lg p-4 border border-input">
        <summary className="cursor-pointer text-sm font-medium">Параметры стратегии</summary>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
          <Metric label="Стартовый депо" value={`$${fmt2(config.startingDepositUsd)}`} />
          <Metric label="Текущий депо (DB)" value={`$${fmt2(config.currentDepositUsd)}`} />
          <Metric label="Total P&L" value={fmt2Signed(config.totalPnLUsd)} />
          <Metric label="Risk/trade" value={`${config.riskPctPerTrade}%`} />
          <Metric label="Maker fee" value={`${config.feeMakerPct}%`} />
          <Metric label="Taker fee" value={`${config.feeTakerPct}%`} />
          <Metric label="Margin target" value={`${config.targetMarginPct}%`} />
          <Metric label="Concurrent max" value={String(config.maxConcurrentPositions)} />
          <Metric label="Daily breaker" value={`-${config.dailyLossLimitPct}% / -${config.dailyLossLimitR}R`} />
        </div>
      </details>

      {/* === Trades === */}
      <div className="bg-card rounded-lg p-4 border border-input">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">Сделки ({trades.length})</div>
        </div>
        {trades.length === 0 ? (
          <div className="text-text-secondary text-sm py-4 text-center">Сделок ещё нет</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-text-secondary text-left">
                <tr>
                  <th className="py-1">Открыта</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Status</th>
                  <th>Entry</th>
                  <th>SL</th>
                  <th className="text-right">Margin</th>
                  <th className="text-right">P&L</th>
                  <th>cID</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id} className="border-t border-input/30">
                    <td className="py-1">{formatDate(t.openedAt)}</td>
                    <td>{t.symbol}</td>
                    <td className={t.side === 'BUY' ? 'text-long' : 'text-short'}>{t.side}</td>
                    <td>{t.status}</td>
                    <td>{formatPrice(t.entryPrice)}</td>
                    <td>{formatPrice(t.currentStop)}</td>
                    <td className="text-right">${fmt2(t.marginUsd ?? 0)}</td>
                    <td className={`text-right ${t.netPnlUsd >= 0 ? 'text-long' : 'text-short'}`}>
                      {fmt2Signed(t.netPnlUsd)}
                    </td>
                    <td className="truncate max-w-[100px]">{t.binanceClientOrderId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-short/10 text-short rounded p-3 text-sm">
          Ошибка: {error}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-text-secondary text-[10px] uppercase">{label}</div>
      <div className={`text-base ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}
