import { useState } from 'react'
import { Signal, SignalsResponse, getSignals, syncSignals, getSignalPrices } from '../api/client'
import SignalTable from '../components/SignalTable'
import SignalBadge from '../components/SignalBadge'
import SignalChart from '../components/SignalChart'

function exportCSV(signals: Signal[], prices: Record<string, number | null>, channel: string) {
  const header = 'Дата,Тип,Монета,Цена,Плечо,Вход мин,Вход макс,SL,TP1,TP2,TP3,TP4,TP5,TP6,Статус,P&L %'
  const rows = signals.map(s => {
    const entry = (s.entryMin + s.entryMax) / 2
    let pnl = ''
    if (s.status === 'SL_HIT') {
      const diff = s.type === 'LONG'
        ? ((s.stopLoss - entry) / entry) * 100
        : ((entry - s.stopLoss) / entry) * 100
      pnl = (diff * s.leverage).toFixed(1)
    } else if (s.status.startsWith('TP')) {
      const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
      const tp = s.takeProfits[tpIdx]
      if (tp != null) {
        const diff = s.type === 'LONG'
          ? ((tp - entry) / entry) * 100
          : ((entry - tp) / entry) * 100
        pnl = '+' + (diff * s.leverage).toFixed(1)
      }
    }
    const tps = Array.from({ length: 6 }, (_, i) => s.takeProfits[i] ?? '').join(',')
    const price = prices[s.coin] != null ? prices[s.coin] : ''
    const date = new Date(s.publishedAt).toLocaleString('ru-RU')
    return `${date},${s.type},${s.coin},${price},${s.leverage}x,${s.entryMin},${s.entryMax},${s.stopLoss},${tps},${s.status},${pnl}`
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
  { id: 'EveningTrader', name: 'Evening Trader' },
  { id: 'BitcoinBullets', name: 'Bitcoin Bullets' },
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

interface SimTrade {
  date: string
  coin: string
  type: string
  leverage: number
  pnlPercent: number
  positionSize: number
  profit: number
  balanceBefore: number
  balanceAfter: number
}

function simulateDeposit(signals: Signal[], deposit: number, positionPct: number): {
  trades: SimTrade[]
  finalBalance: number
  totalProfit: number
  maxDrawdown: number
  peak: number
} {
  // Sort chronologically (oldest first)
  const sorted = [...signals]
    .filter(s => s.status === 'SL_HIT' || s.status.startsWith('TP'))
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime())

  let balance = deposit
  let peak = deposit
  let maxDrawdown = 0
  const trades: SimTrade[] = []

  for (const s of sorted) {
    const entry = (s.entryMin + s.entryMax) / 2
    let pnlPercent = 0

    if (s.status === 'SL_HIT') {
      pnlPercent = s.type === 'LONG'
        ? ((s.stopLoss - entry) / entry) * 100 * s.leverage
        : ((entry - s.stopLoss) / entry) * 100 * s.leverage
    } else {
      const tpIdx = parseInt(s.status.replace('TP', '').replace('_HIT', '')) - 1
      const tp = s.takeProfits[tpIdx]
      if (tp == null) continue
      pnlPercent = s.type === 'LONG'
        ? ((tp - entry) / entry) * 100 * s.leverage
        : ((entry - tp) / entry) * 100 * s.leverage
    }

    const positionSize = balance * (positionPct / 100)
    const profit = positionSize * (pnlPercent / 100)
    const balanceBefore = balance
    balance += profit

    if (balance > peak) peak = balance
    const drawdown = ((peak - balance) / peak) * 100
    if (drawdown > maxDrawdown) maxDrawdown = drawdown

    trades.push({
      date: new Date(s.publishedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      coin: s.coin,
      type: s.type,
      leverage: s.leverage,
      pnlPercent,
      positionSize,
      profit,
      balanceBefore,
      balanceAfter: balance,
    })
  }

  return { trades, finalBalance: balance, totalProfit: balance - deposit, maxDrawdown, peak }
}

function DepositSimulator({ signals }: { signals: Signal[] }) {
  const [deposit, setDeposit] = useState(100)
  const [positionPct, setPositionPct] = useState(10)
  const [showTrades, setShowTrades] = useState(false)

  const sim = simulateDeposit(signals, deposit, positionPct)
  const roi = ((sim.finalBalance - deposit) / deposit) * 100

  return (
    <div className="bg-card rounded-xl p-5 border border-card">
      <h3 className="text-lg font-semibold mb-4">Симулятор депозита</h3>

      {/* Inputs */}
      <div className="flex gap-4 mb-5">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Начальный депозит ($)</label>
          <input
            type="number"
            value={deposit}
            onChange={e => setDeposit(Math.max(1, Number(e.target.value)))}
            className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-32 font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Размер позиции (%)</label>
          <input
            type="number"
            value={positionPct}
            onChange={e => setPositionPct(Math.max(1, Math.min(100, Number(e.target.value))))}
            className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-32 font-mono"
          />
        </div>
      </div>

      {/* Results */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Финальный баланс</div>
          <div className={`font-mono text-xl font-bold ${roi >= 0 ? 'text-long' : 'text-short'}`}>
            ${sim.finalBalance.toFixed(2)}
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Прибыль</div>
          <div className={`font-mono text-xl font-bold ${sim.totalProfit >= 0 ? 'text-long' : 'text-short'}`}>
            {sim.totalProfit >= 0 ? '+' : ''}${sim.totalProfit.toFixed(2)}
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">ROI</div>
          <div className={`font-mono text-xl font-bold ${roi >= 0 ? 'text-long' : 'text-short'}`}>
            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
          </div>
        </div>
        <div className="bg-input rounded-lg p-3 text-center">
          <div className="text-xs text-text-secondary">Макс. просадка</div>
          <div className="font-mono text-xl font-bold text-short">
            -{sim.maxDrawdown.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Trade log toggle */}
      <button
        onClick={() => setShowTrades(!showTrades)}
        className="text-sm text-accent hover:text-accent/80 transition-colors"
      >
        {showTrades ? '▾ Скрыть' : '▸ Показать'} историю сделок ({sim.trades.length})
      </button>

      {showTrades && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-secondary border-b border-card">
                <th className="text-left py-2 px-2">#</th>
                <th className="text-left py-2 px-2">Дата</th>
                <th className="text-left py-2 px-2">Монета</th>
                <th className="text-right py-2 px-2">Баланс до</th>
                <th className="text-right py-2 px-2">Позиция</th>
                <th className="text-right py-2 px-2">P&L</th>
                <th className="text-right py-2 px-2">Результат</th>
                <th className="text-right py-2 px-2">Баланс после</th>
              </tr>
            </thead>
            <tbody>
              {sim.trades.map((t, i) => (
                <tr key={i} className="border-b border-card/30">
                  <td className="py-2 px-2 text-text-secondary">{i + 1}</td>
                  <td className="py-2 px-2 text-text-secondary">{t.date}</td>
                  <td className="py-2 px-2">
                    <span className="font-mono font-bold text-text-primary">{t.coin}</span>
                    <span className={`ml-1 text-[10px] ${t.type === 'LONG' ? 'text-long' : 'text-short'}`}>
                      {t.type} {t.leverage}x
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">
                    ${t.balanceBefore.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-text-secondary">
                    ${t.positionSize.toFixed(2)}
                  </td>
                  <td className={`py-2 px-2 text-right font-mono font-bold ${t.pnlPercent >= 0 ? 'text-long' : 'text-short'}`}>
                    {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(1)}%
                  </td>
                  <td className={`py-2 px-2 text-right font-mono font-bold ${t.profit >= 0 ? 'text-long' : 'text-short'}`}>
                    {t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono font-bold text-text-primary">
                    ${t.balanceAfter.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StrategyAnalysis({ stats }: { stats: {
  avgWin: number; avgLoss: number; winrate: number; tp2plus: number; tp: number;
  sl: number; closedCount: number;
  leverageStats: Record<string, { wins: number; losses: number }>;
  directionStats: { longWins: number; longLosses: number; shortWins: number; shortLosses: number }
}}) {
  const rr = stats.avgLoss !== 0 ? Math.abs(stats.avgWin / stats.avgLoss) : 0
  const tp2pct = stats.tp > 0 ? (stats.tp2plus / stats.tp) * 100 : 0

  // Leverage verdicts
  const levVerdicts: { lev: string; wr: number; total: number; verdict: string; color: string }[] = []
  for (const [lev, s] of Object.entries(stats.leverageStats).sort(([a], [b]) => a.localeCompare(b))) {
    const total = s.wins + s.losses
    const wr = total > 0 ? (s.wins / total) * 100 : 0
    let verdict = 'нормальные'
    let color = 'text-accent'
    if (wr >= 60) { verdict = 'лучшие'; color = 'text-long' }
    else if (wr < 55) { verdict = 'рискованные'; color = 'text-short' }
    levVerdicts.push({ lev, wr, total, verdict, color })
  }

  // Build recommendations
  const recs: string[] = []

  // Leverage advice
  const worstLev = levVerdicts.find(l => l.wr < 55 && l.total >= 3)
  const bestLev = levVerdicts.find(l => l.wr >= 60 && l.total >= 3)
  if (worstLev) recs.push(`Избегать сигналы ${worstLev.lev} — винрейт ${worstLev.wr.toFixed(0)}%, высокий риск ликвидации`)
  if (bestLev) recs.push(`Приоритет: сигналы ${bestLev.lev} — винрейт ${bestLev.wr.toFixed(0)}%`)

  // TP strategy
  if (tp2pct >= 50) {
    recs.push(`${tp2pct.toFixed(0)}% побед дошли до TP2+ — закрывать 50% на TP1, остальное держать до TP2-TP3`)
  } else {
    recs.push('Большинство побед на TP1 — закрывать 70-80% на TP1, остальное на TP2')
  }

  // Long vs Short advice
  const longTotal = stats.directionStats.longWins + stats.directionStats.longLosses
  const shortTotal = stats.directionStats.shortWins + stats.directionStats.shortLosses
  const longWr = longTotal > 0 ? (stats.directionStats.longWins / longTotal) * 100 : 0
  const shortWr = shortTotal > 0 ? (stats.directionStats.shortWins / shortTotal) * 100 : 0
  if (longTotal >= 5 && shortTotal >= 5) {
    if (Math.abs(longWr - shortWr) >= 15) {
      const better = longWr > shortWr ? 'LONG' : 'SHORT'
      const worse = longWr > shortWr ? 'SHORT' : 'LONG'
      const betterPct = Math.max(longWr, shortWr)
      const worsePct = Math.min(longWr, shortWr)
      recs.push(`Канал значительно лучше в ${better} (${betterPct.toFixed(0)}%) чем в ${worse} (${worsePct.toFixed(0)}%) — можно фильтровать`)
    } else {
      recs.push(`LONG (${longWr.toFixed(0)}%) и SHORT (${shortWr.toFixed(0)}%) примерно одинаковы — торговать оба направления`)
    }
  }

  // Position sizing
  recs.push('Фиксированный размер позиции на каждый сигнал — без исключений')

  // Risk/Reward
  const mathPositive = stats.winrate * stats.avgWin + (100 - stats.winrate) * stats.avgLoss
  if (mathPositive > 0) {
    recs.push('Математическое ожидание положительное — стратегия прибыльна на дистанции')
  }

  return (
    <div className="bg-card rounded-xl p-5 border border-accent/20">
      <h3 className="text-lg font-semibold mb-4">Стратегический анализ</h3>

      {/* R:R and Math */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="bg-input rounded-lg p-4">
          <div className="text-xs text-text-secondary mb-2">Математика Risk/Reward</div>
          <div className="text-sm text-text-primary">
            Средний выигрыш <span className="font-mono font-bold text-long">+{stats.avgWin.toFixed(1)}%</span> vs
            средний проигрыш <span className="font-mono font-bold text-short">{stats.avgLoss.toFixed(1)}%</span> —
            соотношение <span className="font-mono font-bold text-accent">~{rr.toFixed(1)}:1</span>
          </div>
          <div className="text-xs text-text-secondary mt-2">
            {rr >= 2 ? 'Отличная асимметрия. ' : rr >= 1.5 ? 'Хорошая асимметрия. ' : 'Слабая асимметрия. '}
            {stats.winrate >= 55
              ? `При ${stats.winrate.toFixed(0)}% win rate итоговая математика сильно положительная.`
              : `Win rate ${stats.winrate.toFixed(0)}% — на грани, требуется осторожность.`
            }
          </div>
        </div>

        <div className="bg-input rounded-lg p-4">
          <div className="text-xs text-text-secondary mb-2">Глубина побед</div>
          <div className="text-sm text-text-primary">
            <span className="font-mono font-bold text-accent">{stats.tp2plus}</span> из{' '}
            <span className="font-mono font-bold">{stats.tp}</span> победителей дошли до TP2+ ({tp2pct.toFixed(0)}%)
          </div>
          <div className="text-xs text-text-secondary mt-2">
            {tp2pct >= 50
              ? 'Хороший показатель — не стоит закрывать всё на TP1.'
              : 'Большинство побед на TP1 — лучше фиксировать основную часть сразу.'
            }
          </div>
        </div>
      </div>

      {/* Leverage table */}
      <div className="mb-5">
        <div className="text-xs text-text-secondary mb-2">Находка по плечам</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs border-b border-card">
                <th className="text-left py-2 px-3">Плечо</th>
                <th className="text-left py-2 px-3">Win rate</th>
                <th className="text-left py-2 px-3">Сделок</th>
                <th className="text-left py-2 px-3">Вывод</th>
              </tr>
            </thead>
            <tbody>
              {levVerdicts.map(l => (
                <tr key={l.lev} className="border-b border-card/30">
                  <td className="py-2 px-3 font-mono font-bold">{l.lev}</td>
                  <td className="py-2 px-3 font-mono">{l.wr.toFixed(0)}%</td>
                  <td className="py-2 px-3 font-mono text-text-secondary">{l.total}</td>
                  <td className={`py-2 px-3 font-semibold ${l.color}`}>{l.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recommendations */}
      <div>
        <div className="text-xs text-text-secondary mb-2">Практическая стратегия на основе данных</div>
        <ol className="space-y-1.5">
          {recs.map((r, i) => (
            <li key={i} className="text-sm text-text-primary flex gap-2">
              <span className="text-accent font-bold">{i + 1}.</span> {r}
            </li>
          ))}
        </ol>
        <div className="mt-3 text-xs text-text-secondary border-t border-card pt-3">
          Data-driven стратегия на основе {stats.closedCount} реальных сделок. Рекомендуется тестировать на небольших суммах.
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
              {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toFixed(1)}%
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
              <div className="font-mono text-lg font-bold text-long">+{stats.avgWin.toFixed(1)}%</div>
            </div>
            <div className="bg-input rounded-lg p-3">
              <div className="text-xs text-text-secondary mb-1">Средний P&L на поражение</div>
              <div className="font-mono text-lg font-bold text-short">{stats.avgLoss.toFixed(1)}%</div>
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
