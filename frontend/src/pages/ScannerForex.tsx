import { useState, useEffect, useCallback } from 'react'
import {
  getForexScannerStatus,
  runForexScannerManual,
  updateForexScannerSettings,
  getForexSignals,
  takeForexSignal,
  closeForexSignal,
  slHitForexSignal,
  deleteForexSignal,
  takeForexSignalAsMultiTrade,
  getMt5Balance,
  type ForexSignal,
  type ForexScannerStatus,
} from '../api/client'
import Mt5PositionCalc, { findInstrument, computeMt5Position } from '../components/Mt5PositionCalc'
import { Link } from 'react-router-dom'

type StatusFilter = 'ALL' | 'NEW' | 'TAKEN' | 'CLOSED' | 'SL_HIT' | 'EXPIRED'

export default function ScannerForex() {
  const [status, setStatus] = useState<ForexScannerStatus | null>(null)
  const [signals, setSignals] = useState<ForexSignal[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<StatusFilter>('ALL')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ForexSignal | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const s = await getForexScannerStatus()
      setStatus(s)
    } catch (e: any) {
      setError(e.message || 'Не удалось загрузить статус')
    }
  }, [])

  const loadSignals = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const statusParam = filter === 'ALL' ? undefined : filter
      const res = await getForexSignals(page, 20, statusParam)
      setSignals(res.data)
      setTotal(res.total)
    } catch (e: any) {
      setError(e.message || 'Не удалось загрузить сигналы')
    } finally {
      setLoading(false)
    }
  }, [page, filter])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    loadSignals()
  }, [loadSignals])

  const handleRun = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await runForexScannerManual()
      if (r.skipped) {
        setError(r.skipReason || 'Сканирование пропущено')
      }
      await loadStatus()
      await loadSignals()
    } catch (e: any) {
      setError(e.message || 'Ошибка сканирования')
    } finally {
      setRunning(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!status) return
    try {
      const r = await updateForexScannerSettings({ enabled: !status.enabled })
      setStatus({ ...status, ...r })
    } catch (e: any) {
      setError(e.message || 'Ошибка сохранения настроек')
    }
  }

  const handleMinScoreChange = async (v: number) => {
    if (!status) return
    try {
      const r = await updateForexScannerSettings({ minScore: v })
      setStatus({ ...status, ...r })
    } catch (e: any) {
      setError(e.message || 'Ошибка сохранения настроек')
    }
  }

  const handleTake = async (signal: ForexSignal, lots?: number) => {
    try {
      const upd = await takeForexSignal(signal.id, lots)
      setSignals((prev) => prev.map((s) => (s.id === upd.id ? upd : s)))
      if (selected?.id === upd.id) setSelected(upd)
    } catch (e: any) {
      alert(e.message || 'Ошибка take')
    }
  }

  const handleTakeAsTrade = async (signal: ForexSignal, lotsPerLeg: number) => {
    try {
      const { trades, fallback } = await takeForexSignalAsMultiTrade(signal.id, { lotsPerLeg })
      const totalLots = trades.reduce((s, t) => s + t.lots, 0)
      setSignals((prev) =>
        prev.map((s) =>
          s.id === signal.id
            ? { ...s, status: 'TAKEN', takenAt: new Date().toISOString(), amount: totalLots }
            : s,
        ),
      )
      setSelected(null)
      const baseMsg = `Создано ${trades.length} сделок (${signal.coin} ${signal.type} итого ${totalLots.toFixed(2)} лот). Смотри Forex Trades.`
      alert(
        fallback
          ? `⚠ Под целевой риск выходило меньше 0.01 лота на ногу — открыта 1 сделка 0.01 с TP${fallback.chosenTpIdx + 1} (ближайший к entry).\n\n${baseMsg}`
          : baseMsg,
      )
    } catch (e: any) {
      alert(e.message || 'Ошибка take-as-trade')
    }
  }

  const handleClose = async (signal: ForexSignal, price: number, pct: number) => {
    try {
      const upd = await closeForexSignal(signal.id, price, pct)
      setSignals((prev) => prev.map((s) => (s.id === upd.id ? upd : s)))
      if (selected?.id === upd.id) setSelected(upd)
    } catch (e: any) {
      alert(e.message || 'Ошибка закрытия')
    }
  }

  const handleSlHit = async (signal: ForexSignal) => {
    if (!confirm('Отметить SL?')) return
    try {
      const upd = await slHitForexSignal(signal.id)
      setSignals((prev) => prev.map((s) => (s.id === upd.id ? upd : s)))
      if (selected?.id === upd.id) setSelected(upd)
    } catch (e: any) {
      alert(e.message || 'Ошибка')
    }
  }

  const handleDelete = async (signal: ForexSignal) => {
    if (!confirm(`Удалить сигнал ${signal.coin} ${signal.type}?`)) return
    try {
      await deleteForexSignal(signal.id)
      setSignals((prev) => prev.filter((s) => s.id !== signal.id))
      if (selected?.id === signal.id) setSelected(null)
    } catch (e: any) {
      alert(e.message || 'Ошибка удаления')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Forex Scanner</h1>
          <p className="text-xs text-text-secondary mt-1">
            Авто-сканирование форекс, металлов и индексов через Twelve Data. Сигналы каждый час, 24/5.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRun}
            disabled={running}
            className="px-4 py-2 bg-accent text-primary font-medium text-sm rounded hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {running ? 'Сканирую...' : 'Запустить сейчас'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-short/10 border border-short/30 text-short text-sm rounded p-3">
          {error}
        </div>
      )}

      {status && <StatusCard status={status} onToggle={handleToggleEnabled} onMinScoreChange={handleMinScoreChange} />}

      <div className="flex items-center gap-2 flex-wrap">
        {(['ALL', 'NEW', 'TAKEN', 'CLOSED', 'SL_HIT', 'EXPIRED'] as StatusFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f)
              setPage(1)
            }}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              filter === f
                ? 'bg-accent/20 text-accent'
                : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-text-secondary ml-2">Всего: {total}</span>
      </div>

      {loading ? (
        <p className="text-text-secondary text-sm">Загрузка...</p>
      ) : signals.length === 0 ? (
        <p className="text-text-secondary text-sm">Нет сигналов.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {signals.map((s) => (
            <SignalCard key={s.id} signal={s} onClick={() => setSelected(s)} />
          ))}
        </div>
      )}

      {selected && (
        <SignalModal
          signal={selected}
          onClose={() => setSelected(null)}
          onTake={handleTake}
          onTakeAsTrade={handleTakeAsTrade}
          onCloseSignal={handleClose}
          onSlHit={handleSlHit}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

// ===================== Status Card =====================

function StatusCard({
  status,
  onToggle,
  onMinScoreChange,
}: {
  status: ForexScannerStatus
  onToggle: () => void
  onMinScoreChange: (v: number) => void
}) {
  const [minScore, setMinScore] = useState(status.minScore)

  useEffect(() => {
    setMinScore(status.minScore)
  }, [status.minScore])

  const lastRunLabel = status.state.lastRunAt
    ? new Date(status.state.lastRunAt).toLocaleString('ru-RU')
    : status.lastScanAt
    ? new Date(status.lastScanAt).toLocaleString('ru-RU')
    : '—'

  return (
    <div className="bg-card rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`px-2 py-0.5 text-xs font-semibold rounded ${
              status.enabled
                ? status.state.isRunning
                  ? 'bg-accent/20 text-accent'
                  : 'bg-long/20 text-long'
                : 'bg-neutral/20 text-neutral'
            }`}
          >
            {status.state.isRunning ? 'Сканирую' : status.enabled ? 'Включён' : 'Выключен'}
          </span>
          <span className="text-xs text-text-secondary">
            Инструменты: {status.instruments.length} · Последний скан: {lastRunLabel}
          </span>
        </div>

        <button
          onClick={onToggle}
          className={`text-xs px-3 py-1.5 rounded transition-colors ${
            status.enabled
              ? 'bg-short/20 text-short hover:bg-short/30'
              : 'bg-long/20 text-long hover:bg-long/30'
          }`}
        >
          {status.enabled ? 'Выключить авто-скан' : 'Включить авто-скан'}
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-text-secondary">Мин. Score для уведомления:</label>
        <input
          type="number"
          value={minScore}
          onChange={(e) => setMinScore(Number(e.target.value))}
          onBlur={() => {
            if (minScore !== status.minScore && minScore >= 0 && minScore <= 100) {
              onMinScoreChange(minScore)
            }
          }}
          min={0}
          max={100}
          className="w-20 bg-input text-text-primary font-mono text-xs rounded px-2 py-1 outline-none focus:ring-1 focus:ring-accent"
        />
        <span className="text-[10px] text-text-secondary">
          {status.instruments.join(' · ')}
        </span>
      </div>

      {status.state.lastError && (
        <p className="text-xs text-short">Последняя ошибка: {status.state.lastError}</p>
      )}
    </div>
  )
}

// ===================== Signal Card =====================

function formatPrice(instrument: string, v: number): string {
  if (/^US30|NAS100|SPX500|GER40|UK100/.test(instrument)) return v.toFixed(2)
  if (/JPY/.test(instrument)) return v.toFixed(3)
  if (/^XAU/.test(instrument)) return v.toFixed(2)
  if (/^XAG/.test(instrument)) return v.toFixed(3)
  return v.toFixed(5)
}

function scoreColor(score: number): string {
  if (score >= 85) return 'text-long'
  if (score >= 70) return 'text-accent'
  return 'text-text-secondary'
}

function statusColor(status: string): string {
  switch (status) {
    case 'NEW':
      return 'bg-accent/20 text-accent'
    case 'TAKEN':
    case 'PARTIALLY_CLOSED':
      return 'bg-long/20 text-long'
    case 'CLOSED':
      return 'bg-neutral/20 text-neutral'
    case 'SL_HIT':
      return 'bg-short/20 text-short'
    case 'EXPIRED':
      return 'bg-neutral/20 text-neutral'
    default:
      return 'bg-neutral/20 text-neutral'
  }
}

function SignalCard({ signal, onClick }: { signal: ForexSignal; onClick: () => void }) {
  const typeColor = signal.type === 'LONG' ? 'text-long' : 'text-short'
  const createdAt = new Date(signal.createdAt).toLocaleString('ru-RU')

  return (
    <button
      onClick={onClick}
      className="bg-card rounded-lg p-4 text-left hover:bg-card/80 transition-colors border border-transparent hover:border-accent/30"
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono font-semibold text-text-primary">{signal.coin}</span>
            <span className={`text-xs font-semibold ${typeColor}`}>{signal.type}</span>
          </div>
          <p className="text-[10px] text-text-secondary mt-0.5">{createdAt}</p>
        </div>

        <div className="text-right">
          <div className={`text-lg font-mono font-bold ${scoreColor(signal.score)}`}>
            {signal.score}
          </div>
          <p className="text-[10px] text-text-secondary">Score</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-text-secondary">Вход</span>
        <span className="font-mono text-right text-text-primary">{formatPrice(signal.coin, signal.entry)}</span>

        <span className="text-text-secondary">SL</span>
        <span className="font-mono text-right text-short">{formatPrice(signal.coin, signal.stopLoss)}</span>

        {signal.takeProfits[0] && (
          <>
            <span className="text-text-secondary">TP1</span>
            <span className="font-mono text-right text-long">
              {formatPrice(signal.coin, signal.takeProfits[0].price)}
              <span className="text-[10px] text-text-secondary ml-1">R:R 1:{signal.takeProfits[0].rr}</span>
            </span>
          </>
        )}
      </div>

      <div className="flex items-center justify-between mt-2">
        <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${statusColor(signal.status)}`}>
          {signal.status}
        </span>
        {signal.session && (
          <span className="text-[10px] text-text-secondary">{signal.session}</span>
        )}
      </div>
    </button>
  )
}

// ===================== Signal Modal =====================

function SignalModal({
  signal,
  onClose,
  onTake,
  onTakeAsTrade,
  onCloseSignal,
  onSlHit,
  onDelete,
}: {
  signal: ForexSignal
  onClose: () => void
  onTake: (signal: ForexSignal, lots?: number) => void
  onTakeAsTrade: (signal: ForexSignal, lotsPerLeg: number) => void
  onCloseSignal: (signal: ForexSignal, price: number, pct: number) => void
  onSlHit: (signal: ForexSignal) => void
  onDelete: (signal: ForexSignal) => void
}) {
  const [closePrice, setClosePrice] = useState('')
  const [lotsInput, setLotsInput] = useState('')
  const [closePct, setClosePct] = useState('50')
  const tpCount = signal.takeProfits?.length || 1
  // Сырое значение perSplitLots из MT5 калькулятора. Может быть < 0.01 (тогда backend применит fallback в single-leg).
  const [rawLotsPerLeg, setRawLotsPerLeg] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    getMt5Balance()
      .then(({ balance, riskPct }) => {
        if (cancelled) return
        const instr = findInstrument(signal.coin)
        if (!instr || !balance || balance <= 0) {
          setRawLotsPerLeg(null)
          setLotsInput('0.01')
          return
        }
        const calc = computeMt5Position(instr, signal.entry, signal.stopLoss, balance, riskPct, tpCount)
        if (!calc) {
          setRawLotsPerLeg(null)
          setLotsInput('0.01')
          return
        }
        setRawLotsPerLeg(calc.perSplitLots)
        // В input показываем округлённое до 0.01 (минимум брокера) — юзер видит то, что реально откроется.
        // Но при отправке мы шлём raw значение, чтобы backend сам решил fallback vs split.
        const rounded = Math.floor(calc.perSplitLots * 100) / 100
        setLotsInput(String(Math.max(0.01, rounded)))
      })
      .catch(() => setLotsInput('0.01'))
    return () => { cancelled = true }
  }, [signal.id, signal.coin, signal.entry, signal.stopLoss, tpCount])

  // Будет ли сейчас fallback в single-leg? (перерисовывает UI и подсказку)
  const willFallback = rawLotsPerLeg != null && rawLotsPerLeg < 0.01
  const effectiveLegs = willFallback ? 1 : tpCount

  const reasons = signal.marketContext?.reasons || []
  const breakdown = signal.marketContext?.scoreBreakdown

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-primary border border-card rounded-lg p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              <span className="font-mono">{signal.coin}</span>{' '}
              <span className={signal.type === 'LONG' ? 'text-long' : 'text-short'}>
                {signal.type}
              </span>
            </h2>
            <p className="text-xs text-text-secondary mt-1">
              Score: <span className={`font-mono ${scoreColor(signal.score)}`}>{signal.score}</span>
              {' · '}
              {signal.strategy}
              {signal.session && ` · ${signal.session}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 bg-card rounded p-3 text-sm">
          <span className="text-text-secondary">Вход</span>
          <span className="font-mono text-text-primary">{formatPrice(signal.coin, signal.entry)}</span>

          <span className="text-text-secondary">Stop Loss</span>
          <span className="font-mono text-short">{formatPrice(signal.coin, signal.stopLoss)}</span>

          {signal.takeProfits.map((tp, i) => (
            <div key={`tp-${i}`} className="contents">
              <span className="text-text-secondary">TP{i + 1}</span>
              <span className="font-mono text-long">
                {formatPrice(signal.coin, tp.price)}
                <span className="text-xs text-text-secondary ml-2">R:R 1:{tp.rr}</span>
              </span>
            </div>
          ))}

          <span className="text-text-secondary">Статус</span>
          <span>
            <span className={`px-2 py-0.5 text-xs font-semibold rounded ${statusColor(signal.status)}`}>
              {signal.status}
            </span>
          </span>
        </div>

        {breakdown && (
          <div className="bg-card rounded p-3 text-xs space-y-1">
            <p className="text-text-secondary font-medium">Разбивка score:</p>
            <div className="grid grid-cols-3 gap-2 font-mono">
              <div>
                <span className="text-text-secondary">Trend </span>
                <span className="text-text-primary">{breakdown.trend}/40</span>
              </div>
              <div>
                <span className="text-text-secondary">Momentum </span>
                <span className="text-text-primary">{breakdown.momentum}/30</span>
              </div>
              <div>
                <span className="text-text-secondary">Structure </span>
                <span className="text-text-primary">{breakdown.structure}/30</span>
              </div>
            </div>
          </div>
        )}

        {reasons.length > 0 && (
          <div className="bg-card rounded p-3 text-xs">
            <p className="text-text-secondary font-medium mb-1">Причины:</p>
            <ul className="space-y-0.5 text-text-primary">
              {reasons.map((r: string, i: number) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        )}

        {/* MT5 calculator — inline */}
        <Mt5PositionCalc
          instrument={signal.coin}
          entry={signal.entry}
          sl={signal.stopLoss}
          splits={signal.takeProfits.length}
        />

        {/* Actions */}
        {signal.status === 'NEW' && (
          <div className="bg-card rounded p-3 space-y-2">
            <p className="text-xs text-text-secondary">
              {willFallback ? (
                <>
                  ⚠ Под целевой риск выходит <span className="font-mono text-short">{rawLotsPerLeg!.toFixed(4)}</span> лота на ногу — это меньше минимума 0.01.
                  Будет открыта <span className="text-text-primary">1 сделка 0.01 лот</span> с ближайшим к entry TP (TP1).
                </>
              ) : (
                <>
                  Взять в сделку — будет создано <span className="text-text-primary">{effectiveLegs}</span> отдельных позиций (по одной на каждый TP), как в MT5.
                </>
              )}
              {' '}Записи попадут в журнал <Link to="/trades-forex" className="text-accent hover:underline">Forex Trades</Link>.
            </p>
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
              <div>
                <label className="text-[10px] text-text-secondary block mb-0.5">
                  {willFallback
                    ? <>Лоты (single-leg fallback)</>
                    : <>Лоты на 1 позицию (всего: <span className="text-accent font-mono">{(Number(lotsInput) * tpCount || 0).toFixed(2)}</span> × {tpCount} TP)</>
                  }
                </label>
                <input
                  type="number"
                  value={lotsInput}
                  onChange={(e) => setLotsInput(e.target.value)}
                  step="0.01"
                  min="0.01"
                  className="w-full bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <button
                onClick={() => {
                  const lotsFromInput = Number(lotsInput)
                  if (!(lotsFromInput > 0)) return alert('Введи количество лотов на одну позицию')
                  // Если калькулятор насчитал raw < 0.01, а юзер input не правил (input = 0.01),
                  // шлём raw — backend увидит < 0.01 и применит fallback в single-leg.
                  // Если юзер сам поставил 0.01 — это override, шлём 0.01 (3 ноги).
                  const inputLooksAuto = Math.abs(lotsFromInput - Math.max(0.01, Math.floor((rawLotsPerLeg ?? 0) * 100) / 100)) < 1e-9
                  const lotsToSend = (rawLotsPerLeg != null && inputLooksAuto) ? rawLotsPerLeg : lotsFromInput
                  onTakeAsTrade(signal, lotsToSend)
                }}
                className="px-3 py-1.5 bg-accent text-primary text-xs font-medium rounded hover:bg-accent/90"
              >
                {willFallback ? 'Взять 1 сделку' : `Взять ${effectiveLegs} ${effectiveLegs === 1 ? 'сделку' : effectiveLegs < 5 ? 'сделки' : 'сделок'}`}
              </button>
              <button
                onClick={() => onTake(signal)}
                className="px-3 py-1.5 bg-long/20 text-long text-xs rounded hover:bg-long/30"
                title="Отметить сигнал как взятый без создания записи сделки"
              >
                Только отметить
              </button>
            </div>
            <button
              onClick={() => onDelete(signal)}
              className="text-[10px] text-short hover:text-short/80"
            >
              Удалить сигнал
            </button>
          </div>
        )}

        {['TAKEN', 'PARTIALLY_CLOSED'].includes(signal.status) && (
          <div className="bg-card rounded p-3 space-y-2">
            <p className="text-xs text-text-secondary">
              Закрыто: <span className="text-text-primary font-mono">{signal.closedPct}%</span>
              {signal.realizedPnl !== 0 && (
                <span className={signal.realizedPnl >= 0 ? ' text-long' : ' text-short'}>
                  {' · P&L: '}
                  {signal.realizedPnl >= 0 ? '+' : ''}
                  {signal.realizedPnl}%
                </span>
              )}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="number"
                value={closePrice}
                onChange={(e) => setClosePrice(e.target.value)}
                placeholder="Цена"
                className="bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
              />
              <input
                type="number"
                value={closePct}
                onChange={(e) => setClosePct(e.target.value)}
                placeholder="%"
                className="bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
              />
              <button
                onClick={() => {
                  const p = Number(closePrice)
                  const pct = Number(closePct)
                  if (!p || !pct) return alert('Нужны цена и %')
                  onCloseSignal(signal, p, pct)
                  setClosePrice('')
                }}
                className="px-3 py-1.5 bg-long/20 text-long text-xs rounded hover:bg-long/30"
              >
                Закрыть
              </button>
            </div>
            <button
              onClick={() => onSlHit(signal)}
              className="px-3 py-1.5 bg-short/20 text-short text-xs rounded hover:bg-short/30"
            >
              Отметить SL
            </button>
          </div>
        )}

        {signal.closes.length > 0 && (
          <div className="bg-card rounded p-3 text-xs space-y-1">
            <p className="text-text-secondary font-medium">История закрытий:</p>
            {signal.closes.map((c, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 font-mono">
                <span>{c.percent}%</span>
                <span>{formatPrice(signal.coin, c.price)}</span>
                <span className={c.pnl >= 0 ? 'text-long' : 'text-short'}>
                  {c.pnlPercent >= 0 ? '+' : ''}
                  {c.pnlPercent.toFixed(2)}%
                </span>
                <span className="text-text-secondary text-[10px]">
                  {new Date(c.closedAt).toLocaleString('ru-RU')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
