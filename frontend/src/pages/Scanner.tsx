import { useState, useEffect } from 'react'
import {
  getScannerSignals, triggerScan, takeSignal, closeSignal, slHitSignal, skipSignal,
  ScannerSignal, ScanResponse, SignalClose,
} from '../api/client'

function formatDate(d: string) {
  return new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// === Score badge ===
function ScoreBadge({ score }: { score: number }) {
  let color = 'text-neutral bg-neutral/10'
  if (score >= 80) color = 'text-long bg-long/10'
  else if (score >= 65) color = 'text-accent bg-accent/10'
  else if (score >= 50) color = 'text-yellow-400 bg-yellow-400/10'

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${color}`}>
      {score}
    </span>
  )
}

// === Strategy badge ===
function StrategyBadge({ strategy }: { strategy: string }) {
  const map: Record<string, { label: string; color: string }> = {
    trend_follow: { label: 'Тренд', color: 'text-blue-400 bg-blue-400/10' },
    mean_revert: { label: 'Реверс', color: 'text-purple-400 bg-purple-400/10' },
    breakout: { label: 'Пробой', color: 'text-orange-400 bg-orange-400/10' },
  }
  const s = map[strategy] || { label: strategy, color: 'text-neutral bg-neutral/10' }
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>
}

// === Status badge ===
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    NEW: { label: 'Новый', color: 'text-accent bg-accent/10' },
    TAKEN: { label: 'Открыт', color: 'text-blue-400 bg-blue-400/10' },
    PARTIALLY_CLOSED: { label: 'Частично', color: 'text-purple-400 bg-purple-400/10' },
    CLOSED: { label: 'Закрыт', color: 'text-long bg-long/10' },
    SL_HIT: { label: 'Стоп-лосс', color: 'text-short bg-short/10' },
    EXPIRED: { label: 'Пропущен', color: 'text-neutral bg-neutral/10' },
  }
  const s = map[status] || { label: status, color: 'text-neutral bg-neutral/10' }
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>
}

// === Signal Card ===
function SignalCard({ signal, onStatusChange }: {
  signal: ScannerSignal
  onStatusChange: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [showCloseForm, setShowCloseForm] = useState(false)
  const [amount, setAmount] = useState('')
  const [closePrice, setClosePrice] = useState('')
  const [closePercent, setClosePercent] = useState('100')
  const [loading, setLoading] = useState(false)
  const isLong = signal.type === 'LONG'
  const tps = (signal.takeProfits as { price: number; rr: number }[]) || []
  const closes = (signal.closes as SignalClose[]) || []
  const hasPnl = signal.closedPct > 0

  async function handleTake() {
    if (!amount) return
    setLoading(true)
    try {
      await takeSignal(signal.id, Number(amount))
      setShowTakeForm(false)
      onStatusChange()
    } catch {} finally { setLoading(false) }
  }

  async function handleClose() {
    if (!closePrice || !closePercent) return
    setLoading(true)
    try {
      await closeSignal(signal.id, Number(closePrice), Number(closePercent))
      setShowCloseForm(false)
      setClosePrice('')
      setClosePercent('100')
      onStatusChange()
    } catch {} finally { setLoading(false) }
  }

  async function handleSLHit() {
    setLoading(true)
    try {
      await slHitSignal(signal.id)
      onStatusChange()
    } catch {} finally { setLoading(false) }
  }

  async function handleSkip() {
    try {
      await skipSignal(signal.id)
      onStatusChange()
    } catch {}
  }

  return (
    <div className="bg-card rounded-xl p-4 border border-card hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{signal.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {signal.type}
          </span>
          <StrategyBadge strategy={signal.strategy} />
          <StatusBadge status={signal.status} />
        </div>
        <div className="flex items-center gap-2">
          {hasPnl && (
            <span className={`font-mono font-bold text-sm ${signal.realizedPnl > 0 ? 'text-long' : signal.realizedPnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
              {signal.realizedPnl > 0 ? '+' : ''}{signal.realizedPnl}$
            </span>
          )}
          <ScoreBadge score={signal.score} />
        </div>
      </div>

      {/* Key levels grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход</div>
          <div className="font-mono font-bold text-accent">${signal.entry}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Stop Loss</div>
          <div className="font-mono font-bold text-short">${signal.stopLoss}</div>
        </div>
        {tps[0] && (
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP1 (R:R {tps[0].rr})</div>
            <div className="font-mono font-bold text-long">${tps[0].price}</div>
          </div>
        )}
        {tps[1] && (
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP2 (R:R {tps[1].rr})</div>
            <div className="font-mono font-bold text-long">${tps[1].price}</div>
          </div>
        )}
      </div>

      {/* Info row */}
      <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
        <span className="text-text-secondary">Leverage: <span className="text-text-primary font-mono">{signal.leverage}x</span></span>
        {signal.amount > 0 && (
          <span className="text-text-secondary">Размер: <span className="text-text-primary font-mono">${signal.amount}</span></span>
        )}
        {signal.closedPct > 0 && (
          <span className="text-text-secondary">Закрыто: <span className="text-text-primary font-mono">{signal.closedPct}%</span></span>
        )}
        {signal.marketContext && (
          <span className="text-text-secondary">Режим: <span className="text-text-primary">{(signal.marketContext as any)?.regime}</span></span>
        )}
      </div>

      {/* Closes history */}
      {closes.length > 0 && (
        <div className="mb-3 space-y-1">
          <div className="text-xs text-text-secondary mb-1">Закрытия:</div>
          {closes.map((c, i) => (
            <div key={i} className="flex items-center gap-3 text-xs bg-input rounded-lg px-3 py-1.5">
              <span className="font-mono text-text-primary">${c.price}</span>
              <span className="text-text-secondary">{c.percent}%</span>
              <span className={`font-mono font-bold ${c.pnl > 0 ? 'text-long' : c.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                {c.pnl > 0 ? '+' : ''}{c.pnl}$ ({c.pnlPercent > 0 ? '+' : ''}{c.pnlPercent}%)
              </span>
              {c.isSL && <span className="text-short">SL</span>}
              <span className="text-text-secondary ml-auto">{formatDate(c.closedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI Analysis */}
      {signal.aiAnalysis && signal.aiAnalysis !== 'GPT фильтр отключен\n\nРиски: \nУровни: ' && (
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-text-secondary hover:text-accent transition-colors mb-2">
          {expanded ? '▾ Скрыть GPT анализ' : '▸ GPT-5.4 анализ'}
        </button>
      )}
      {expanded && signal.aiAnalysis && (
        <div className="bg-input rounded-lg p-3 mb-3 text-sm text-text-secondary whitespace-pre-wrap">
          {signal.aiAnalysis}
        </div>
      )}

      {/* === Take Form === */}
      {showTakeForm && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="text-xs text-text-secondary">Размер позиции (USDT):</div>
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="100"
              className="flex-1 bg-input text-text-primary rounded px-3 py-1.5 text-sm font-mono"
            />
            <button onClick={handleTake} disabled={loading || !amount} className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50">
              {loading ? '...' : 'Подтвердить'}
            </button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* === Close Form === */}
      {showCloseForm && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="text-xs text-text-secondary">Закрыть часть позиции:</div>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-[120px]">
              <label className="text-xs text-text-secondary">Цена закрытия</label>
              <input
                type="number"
                value={closePrice}
                onChange={e => setClosePrice(e.target.value)}
                placeholder={String(tps[0]?.price || signal.entry)}
                className="w-full bg-input text-text-primary rounded px-3 py-1.5 text-sm font-mono mt-0.5"
                step="any"
              />
            </div>
            <div className="w-24">
              <label className="text-xs text-text-secondary">% позиции</label>
              <input
                type="number"
                value={closePercent}
                onChange={e => setClosePercent(e.target.value)}
                className="w-full bg-input text-text-primary rounded px-3 py-1.5 text-sm font-mono mt-0.5"
                min={1} max={100 - signal.closedPct}
              />
            </div>
          </div>
          {/* Quick TP buttons */}
          <div className="flex gap-1 flex-wrap">
            {tps.map((tp, i) => (
              <button key={i} onClick={() => setClosePrice(String(tp.price))}
                className="px-2 py-0.5 text-xs rounded bg-long/10 text-long hover:bg-long/20">
                TP{i + 1}: ${tp.price}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={handleClose} disabled={loading || !closePrice} className="px-3 py-1.5 text-sm rounded bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50">
              {loading ? '...' : 'Закрыть'}
            </button>
            <button onClick={() => setShowCloseForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* Footer: time + actions */}
      <div className="flex items-center justify-between border-t border-card pt-2">
        <span className="text-xs text-text-secondary">
          {formatDate(signal.createdAt)}
          {signal.takenAt && <span> · взят {formatDate(signal.takenAt)}</span>}
        </span>

        {signal.status === 'NEW' && !showTakeForm && (
          <div className="flex gap-1">
            <button onClick={() => setShowTakeForm(true)} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20">Взять</button>
            <button onClick={handleSkip} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20">Пропустить</button>
          </div>
        )}

        {(signal.status === 'TAKEN' || signal.status === 'PARTIALLY_CLOSED') && !showCloseForm && (
          <div className="flex gap-1">
            <button onClick={() => setShowCloseForm(true)} className="px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20">Закрыть</button>
            <button onClick={handleSLHit} disabled={loading} className="px-2 py-1 text-xs rounded bg-short/10 text-short hover:bg-short/20">SL Hit</button>
          </div>
        )}
      </div>
    </div>
  )
}

// === Category badge ===
const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  READY: { bg: 'bg-long/15', text: 'text-long', label: 'Ready' },
  WATCHLIST: { bg: 'bg-accent/15', text: 'text-accent', label: 'Watchlist' },
  WAIT_CONFIRMATION: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Wait' },
  LATE_ENTRY: { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Late' },
  CONFLICTED: { bg: 'bg-short/15', text: 'text-short', label: 'Conflicted' },
  REJECTED: { bg: 'bg-neutral/15', text: 'text-neutral', label: 'Rejected' },
}

function CategoryBadge({ category }: { category: string }) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.REJECTED
  return <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.bg} ${style.text}`}>{style.label}</span>
}

const QUALITY_COLORS: Record<string, string> = {
  A: 'text-long',
  B: 'text-accent',
  C: 'text-text-secondary',
  D: 'text-orange-400',
  F: 'text-short',
}

// === Scan Results (from fresh scan) ===
function ScanResultCard({ result }: { result: ScanResponse['signals'][0] }) {
  const isLong = result.type === 'LONG'
  const isRejected = result.category === 'REJECTED'

  return (
    <div className={`bg-card rounded-xl p-4 border ${isRejected ? 'border-short/20 opacity-60' : 'border-card hover:border-accent/30'} transition-colors`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{result.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {result.type}
          </span>
          <StrategyBadge strategy={result.strategy} />
          <CategoryBadge category={result.category} />
          <span className={`font-mono font-bold text-sm ${QUALITY_COLORS[result.setupQuality] || 'text-neutral'}`}>
            {result.setupQuality}
          </span>
        </div>
        <ScoreBadge score={result.score} />
      </div>

      {/* Score breakdown */}
      <div className="flex gap-2 mb-3 text-xs text-text-secondary">
        <span>Tech: {result.scoreBreakdown.technical}/25</span>
        <span>MTF: {result.scoreBreakdown.multiTF}/20</span>
        <span>Vol: {result.scoreBreakdown.volume}/15</span>
        <span>Market: {result.scoreBreakdown.marketContext}/15</span>
        <span>Patterns: {result.scoreBreakdown.patterns}/15</span>
      </div>

      {/* Entry models: primary + alternative (max 2) */}
      {result.entryModels && result.entryModels.length > 0 && (
        <div className={`grid ${result.entryModels.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mb-3`}>
          {result.entryModels.map((model, idx) => (
            <div key={model.type} className={`bg-input rounded-lg p-2 border ${idx === 0 ? 'border-accent/40' : 'border-text-secondary/20'}`}>
              <div className="text-xs text-text-secondary capitalize">{idx === 0 ? `${model.type} ★` : model.type}</div>
              <div className="font-mono text-sm text-accent">${model.entry}</div>
              <div className="text-xs text-text-secondary">
                SL: <span className="text-short">{model.slPercent}%</span> · R:R: <span className="text-text-primary">1:{model.riskReward}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход ({result.bestEntryType})</div>
          <div className="font-mono font-bold text-accent">${result.entry}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">SL ({result.slPercent}%)</div>
          <div className="font-mono font-bold text-short">${result.stopLoss}</div>
        </div>
        {result.takeProfits[0] && (
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP1 (+{result.tp1Percent}%)</div>
            <div className="font-mono font-bold text-long">${result.takeProfits[0].price}</div>
          </div>
        )}
        {result.takeProfits[1] && (
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP2 (+{result.tp2Percent}%)</div>
            <div className="font-mono font-bold text-long">${result.takeProfits[1].price}</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mb-2 text-sm">
        <span className="text-text-secondary">Leverage: <span className="font-mono text-text-primary">{result.leverage}x</span></span>
        <span className="text-text-secondary">Позиция: <span className="font-mono text-text-primary">{result.positionPct}%</span></span>
        <span className="text-text-secondary">R:R: <span className="font-mono text-text-primary">1:{result.riskReward}</span></span>
      </div>

      {/* Reasons */}
      <div className="mb-2">
        <div className="text-xs text-text-secondary mb-1">Причины:</div>
        <ul className="text-xs text-text-primary space-y-0.5">
          {result.reasons.map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
      </div>

      {/* AI annotation */}
      {result.aiCommentary && (
        <div className="bg-input rounded-lg p-3 text-sm text-text-secondary">
          <div className="text-xs text-accent mb-1 font-medium">AI Annotation [{result.setupQuality}]:</div>
          <div>{result.aiCommentary}</div>
          {result.aiConflicts.length > 0 && (
            <div className="mt-1 text-xs text-orange-400">
              Конфликты: {result.aiConflicts.join(' · ')}
            </div>
          )}
          {result.aiRisks.length > 0 && (
            <div className="mt-1 text-xs text-short">
              Риски: {result.aiRisks.join(' · ')}
            </div>
          )}
          {result.waitForConfirmation && (
            <div className="mt-1 text-xs text-blue-400">
              ⏳ Ждать: {result.waitForConfirmation}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// === Loading messages ===
const LOADING_MESSAGES = [
  'Сканирую монеты...',
  'Получаю данные с MEXC...',
  'Считаю индикаторы (15m, 1h, 4h)...',
  'Проверяю Funding Rate и Open Interest...',
  'Читаю новости...',
  'Определяю режим рынка...',
  'Запускаю стратегии...',
  'Считаю скоринг...',
  'GPT-5.4 проверяет сигналы...',
  'Формирую торговый план...',
]

// === Main Scanner Page ===
export default function Scanner() {
  const [signals, setSignals] = useState<ScannerSignal[]>([])
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'saved' | 'scan'>('saved')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [useGPT, setUseGPT] = useState(true)
  const [minScore, setMinScore] = useState(40)

  // Load saved signals
  useEffect(() => {
    loadSignals()
  }, [page, statusFilter])

  async function loadSignals() {
    try {
      const res = await getScannerSignals(page, statusFilter || undefined)
      setSignals(res.data)
      setTotalPages(res.totalPages)
    } catch {}
  }

  // Run scan
  async function handleScan() {
    setLoading(true)
    setError('')
    setScanResults(null)
    setTab('scan')

    let msgIdx = 0
    setLoadingMsg(LOADING_MESSAGES[0])
    const interval = setInterval(() => {
      msgIdx = (msgIdx + 1) % LOADING_MESSAGES.length
      setLoadingMsg(LOADING_MESSAGES[msgIdx])
    }, 3000)

    try {
      const res = await triggerScan(undefined, minScore, useGPT)
      setScanResults(res)
      // Reload saved signals too
      loadSignals()
    } catch (err: any) {
      setError(err.message || 'Scan failed')
    } finally {
      clearInterval(interval)
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Сканер сигналов</h1>
          <p className="text-sm text-text-secondary mt-1">
            Автоматический поиск торговых возможностей по 125 монетам
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Settings */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-secondary">Min Score:</label>
            <input
              type="number"
              value={minScore}
              onChange={e => setMinScore(Number(e.target.value))}
              className="w-14 bg-input text-text-primary rounded px-2 py-1 text-sm font-mono"
              min={0}
              max={100}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={useGPT}
              onChange={e => setUseGPT(e.target.checked)}
              className="accent-accent"
            />
            GPT-5.4 фильтр
          </label>
          <button
            onClick={handleScan}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-accent text-bg-primary font-medium text-sm hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Сканирую...' : 'Сканировать'}
          </button>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="bg-card rounded-xl p-8 text-center">
          <div className="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-text-primary font-medium">{loadingMsg}</div>
          <div className="text-xs text-text-secondary mt-2">Это может занять 1-2 минуты</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-short/10 text-short rounded-lg px-4 py-3 text-sm">{error}</div>
      )}

      {/* Tabs */}
      {!loading && (
        <div className="flex gap-1 border-b border-card">
          <button
            onClick={() => setTab('saved')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'saved' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Сохранённые сигналы
          </button>
          <button
            onClick={() => setTab('scan')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'scan' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Результаты скана {scanResults ? `(${scanResults.total})` : ''}
          </button>
        </div>
      )}

      {/* Saved signals tab */}
      {tab === 'saved' && !loading && (
        <>
          {/* Status filter */}
          <div className="flex gap-1">
            {['', 'NEW', 'TAKEN', 'PARTIALLY_CLOSED', 'CLOSED', 'SL_HIT', 'EXPIRED'].map(s => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setPage(1) }}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {s || 'Все'}
              </button>
            ))}
          </div>

          {signals.length === 0 ? (
            <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
              Нет сигналов. Запустите сканер чтобы найти торговые возможности.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {signals.map(s => (
                <SignalCard key={s.id} signal={s} onStatusChange={loadSignals} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary"
              >
                ←
              </button>
              <span className="px-3 py-1 text-sm text-text-secondary">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded bg-card text-text-secondary disabled:opacity-30 hover:text-text-primary"
              >
                →
              </button>
            </div>
          )}
        </>
      )}

      {/* Scan results tab */}
      {tab === 'scan' && !loading && scanResults && (
        <>
          {/* Regime info */}
          {scanResults.regime && (
            <div className="bg-card rounded-xl p-4 flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-text-secondary">Режим рынка: </span>
                <span className="text-text-primary font-medium">{scanResults.regime.regime}</span>
                <span className="text-text-secondary ml-1">({scanResults.regime.confidence}%)</span>
              </div>
              <div>
                <span className="text-text-secondary">BTC: </span>
                <span className={scanResults.regime.btcTrend === 'BULLISH' ? 'text-long' : scanResults.regime.btcTrend === 'BEARISH' ? 'text-short' : 'text-neutral'}>
                  {scanResults.regime.btcTrend}
                </span>
              </div>
              <div>
                <span className="text-text-secondary">Fear & Greed: </span>
                <span className="text-text-primary">{scanResults.regime.fearGreedZone}</span>
              </div>
              <div>
                <span className="text-text-secondary">Volatility: </span>
                <span className="text-text-primary">{scanResults.regime.volatility}</span>
              </div>
              <div className="ml-auto flex gap-2 text-xs">
                {scanResults.funnel && Object.entries(scanResults.funnel.byCategory).filter(([, v]) => v > 0).map(([cat, count]) => {
                  const style = CATEGORY_STYLES[cat]
                  return <span key={cat} className={style?.text || 'text-neutral'}>{count} {style?.label || cat}</span>
                })}
              </div>
            </div>
          )}

          {scanResults.signals.length === 0 ? (
            <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
              Сигналов не найдено. Попробуйте снизить минимальный score.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {scanResults.signals.map((s, i) => (
                <ScanResultCard key={i} result={s} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
