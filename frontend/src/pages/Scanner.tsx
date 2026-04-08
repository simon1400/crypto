import { useState, useEffect } from 'react'
import {
  getScannerSignals, triggerScan, takeSignalAsTrade, closeSignal, slHitSignal, skipSignal, deleteSignal,
  ScannerSignal, ScanResponse, ScanSignal, SignalClose,
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

// === AI Analysis with colored sections ===
const AI_MARKERS = [
  { prefix: 'Конфликты:', color: 'text-orange-400', key: 'conflicts' },
  { prefix: 'Риски:', color: 'text-short', key: 'risks' },
  { prefix: 'Уровни:', color: 'text-blue-400', key: 'levels' },
  { prefix: '⏳ Ждать:', color: 'text-blue-400', key: 'wait' },
]

function AiAnalysisBlock({ text }: { text: string }) {
  const qualityMatch = text.match(/^\[([A-F])\]\s*/)
  const quality = qualityMatch?.[1] || ''
  const body = qualityMatch ? text.slice(qualityMatch[0].length) : text

  // Find all marker positions, sort by position in text
  const found = AI_MARKERS
    .map(m => ({ ...m, idx: body.indexOf(m.prefix) }))
    .filter(m => m.idx !== -1)
    .sort((a, b) => a.idx - b.idx)

  // Commentary = everything before the first marker
  const commentaryEnd = found.length > 0 ? found[0].idx : body.length
  const commentary = body.slice(0, commentaryEnd).replace(/\n+$/, '').trim()

  // Each section runs from its prefix to the next marker (or end)
  const sections = found.map((m, i) => {
    const start = m.idx + m.prefix.length
    const end = i < found.length - 1 ? found[i + 1].idx : body.length
    return { key: m.key, label: m.prefix, color: m.color, content: body.slice(start, end).trim() }
  }).filter(s => s.content)

  return (
    <div className="bg-input rounded-lg p-3 mb-3 text-sm">
      {quality && (
        <div className={`text-xs font-medium mb-1 ${QUALITY_COLORS[quality] || 'text-neutral'}`}>
          AI Annotation [{quality}]:
        </div>
      )}
      {commentary && (
        <div className="text-text-secondary mb-2">{commentary}</div>
      )}
      {sections.map(s => (
        <div key={s.key} className={`${s.color} text-xs mt-1`}>
          <span className="font-medium">{s.label}</span> {s.content}
        </div>
      ))}
    </div>
  )
}

// === Signal Card ===
function SignalCard({ signal, onStatusChange, onDelete }: {
  signal: ScannerSignal
  onStatusChange: () => void
  onDelete: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [showCloseForm, setShowCloseForm] = useState(false)
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [closePrice, setClosePrice] = useState('')
  const [closePercent, setClosePercent] = useState('100')
  const [loading, setLoading] = useState(false)
  const isLong = signal.type === 'LONG'
  const mc = signal.marketContext as any
  const models = (mc?.entryModels as { type: string; entry: number; stopLoss: number; takeProfits: { price: number; rr: number }[]; leverage: number; positionPct: number; slPercent: number; riskReward: number; viable: boolean }[] || []).filter(m => m.viable)
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || (signal.takeProfits as { price: number; rr: number }[]) || []
  const closes = (signal.closes as SignalClose[]) || []
  const hasPnl = signal.closedPct > 0

  async function handleTake() {
    if (!amount) return
    setLoading(true)
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      await takeSignalAsTrade(signal.id, Number(amount), active?.type, lev)
      setShowTakeForm(false)
      onStatusChange()
    } catch (err: any) {
      alert(err.message || 'Failed to take signal')
    } finally { setLoading(false) }
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

      {/* Entry model selector */}
      {models.length > 1 && (
        <div className="flex gap-1 mb-3">
          {models.map((model, idx) => (
            <button
              key={model.type}
              onClick={() => setSelectedModel(idx)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                selectedModel === idx
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-input text-text-secondary border border-transparent hover:text-text-primary'
              }`}
            >
              {MODEL_LABELS[model.type] || model.type}
              {idx === 0 && ' ★'}
            </button>
          ))}
        </div>
      )}

      {/* Key levels grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход{active ? ` (${MODEL_LABELS[active.type] || active.type})` : ''}</div>
          <div className="font-mono font-bold text-accent">${active?.entry ?? signal.entry}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Stop Loss{active ? ` (${active.slPercent}%)` : ''}</div>
          <div className="font-mono font-bold text-short">${active?.stopLoss ?? signal.stopLoss}</div>
        </div>
        {tps.map((tp, i) => (
          <div key={i} className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
            <div className="font-mono font-bold text-long">${tp.price}</div>
          </div>
        ))}
      </div>

      {/* Info row */}
      <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
        <span className="text-text-secondary">Leverage: <span className="text-text-primary font-mono">{active?.leverage ?? signal.leverage}x</span></span>
        {active && (
          <>
            <span className="text-text-secondary">Позиция: <span className="text-text-primary font-mono">{active.positionPct}%</span></span>
            <span className="text-text-secondary">R:R: <span className="text-text-primary font-mono">1:{active.riskReward}</span></span>
          </>
        )}
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
        <AiAnalysisBlock text={signal.aiAnalysis} />
      )}

      {/* === Take Form === */}
      {showTakeForm && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-24">
              <div className="text-xs text-text-secondary mb-1">Leverage</div>
              <input
                type="number"
                value={customLeverage || (active?.leverage ?? signal.leverage)}
                onChange={e => setCustomLeverage(e.target.value)}
                min={1} max={125}
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          {amount && (
            <div className="text-xs text-text-secondary">
              Позиция: <span className="text-text-primary font-mono">${Number(amount) * (Number(customLeverage) || active?.leverage || signal.leverage)}</span>
            </div>
          )}
          <div className="flex gap-2">
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
                className="w-full bg-input text-text-primary border border-card rounded px-3 py-1.5 text-sm font-mono mt-0.5 focus:outline-none focus:border-accent"
                step="any"
              />
            </div>
            <div className="w-24">
              <label className="text-xs text-text-secondary">% позиции</label>
              <input
                type="number"
                value={closePercent}
                onChange={e => setClosePercent(e.target.value)}
                className="w-full bg-input text-text-primary border border-card rounded px-3 py-1.5 text-sm font-mono mt-0.5 focus:outline-none focus:border-accent"
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

        <div className="flex gap-1">
          {signal.status === 'NEW' && !showTakeForm && (
            <>
              <button onClick={() => setShowTakeForm(true)} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20">Взять</button>
              <button onClick={handleSkip} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20">Пропустить</button>
            </>
          )}

          {(signal.status === 'TAKEN' || signal.status === 'PARTIALLY_CLOSED') && !showCloseForm && (
            <>
              <button onClick={() => setShowCloseForm(true)} className="px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20">Закрыть</button>
              <button onClick={handleSLHit} disabled={loading} className="px-2 py-1 text-xs rounded bg-short/10 text-short hover:bg-short/20">SL Hit</button>
            </>
          )}

          <button
            onClick={() => onDelete(signal.id)}
            className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
            title="Удалить"
          >
            ✕
          </button>
        </div>
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

// === Entry model labels ===
const MODEL_LABELS: Record<string, string> = {
  aggressive: 'Агрессивный',
  confirmation: 'Подтверждение',
  pullback: 'Откат',
}

// === Scan Results (from fresh scan) ===
function ScanResultCard({ result, onTake, onSkip, onDelete }: {
  result: ScanSignal
  onTake: (id: number, amount: number, modelType?: string, leverage?: number) => void
  onSkip: (id: number) => void
  onDelete: (id: number) => void
}) {
  const [selectedModel, setSelectedModel] = useState(0)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [takeAmount, setTakeAmount] = useState('')
  const [takeLeverage, setTakeLeverage] = useState('')
  const isLong = result.type === 'LONG'
  const isRejected = result.category === 'REJECTED'
  const models = result.entryModels?.filter(m => m.viable) || []
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || result.takeProfits

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

      {/* Entry model selector */}
      {models.length > 1 && (
        <div className="flex gap-1 mb-3">
          {models.map((model, idx) => (
            <button
              key={model.type}
              onClick={() => setSelectedModel(idx)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                selectedModel === idx
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-input text-text-secondary border border-transparent hover:text-text-primary'
              }`}
            >
              {MODEL_LABELS[model.type] || model.type}
              {idx === 0 && ' ★'}
            </button>
          ))}
        </div>
      )}

      {/* Levels grid from selected model */}
      {active && (
        <div className={`grid grid-cols-2 gap-2 mb-3`}>
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">Вход ({MODEL_LABELS[active.type] || active.type})</div>
            <div className="font-mono font-bold text-accent">${active.entry}</div>
          </div>
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">SL ({active.slPercent}%)</div>
            <div className="font-mono font-bold text-short">${active.stopLoss}</div>
          </div>
          {tps.map((tp, i) => (
            <div key={i} className="bg-input rounded-lg p-2">
              <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
              <div className="font-mono font-bold text-long">${tp.price}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mb-2 text-sm">
        {active && (
          <>
            <span className="text-text-secondary">Leverage: <span className="font-mono text-text-primary">{active.leverage}x</span></span>
            <span className="text-text-secondary">Позиция: <span className="font-mono text-text-primary">{active.positionPct}%</span></span>
            <span className="text-text-secondary">R:R: <span className="font-mono text-text-primary">1:{active.riskReward}</span></span>
          </>
        )}
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

      {/* Take form */}
      {showTakeForm && result.savedId && (
        <div className="bg-input rounded-lg p-3 mt-3 space-y-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
              <input
                type="number"
                value={takeAmount}
                onChange={e => setTakeAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-24">
              <div className="text-xs text-text-secondary mb-1">Leverage</div>
              <input
                type="number"
                value={takeLeverage || (active?.leverage || result.leverage)}
                onChange={e => setTakeLeverage(e.target.value)}
                min={1} max={125}
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          {takeAmount && (
            <div className="text-xs text-text-secondary">
              Позиция: <span className="text-text-primary font-mono">${Number(takeAmount) * (Number(takeLeverage) || active?.leverage || result.leverage)}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!takeAmount) return
                const lev = takeLeverage ? Number(takeLeverage) : undefined
                onTake(result.savedId!, Number(takeAmount), active?.type, lev)
                setShowTakeForm(false)
              }}
              disabled={!takeAmount}
              className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50"
            >
              Подтвердить
            </button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {result.savedId && (
        <div className="flex items-center justify-end gap-1 border-t border-card pt-2 mt-3">
          {(result as any)._taken ? (
            <span className="text-xs text-long font-medium">Взят — сделка создана</span>
          ) : (result as any)._skipped ? (
            <span className="text-xs text-neutral font-medium">Пропущен</span>
          ) : !showTakeForm ? (
            <>
              <button
                onClick={() => setShowTakeForm(true)}
                className="px-3 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20 transition-colors"
              >
                Взять
              </button>
              <button
                onClick={() => onSkip(result.savedId!)}
                className="px-3 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20 transition-colors"
              >
                Пропустить
              </button>
              <button
                onClick={() => onDelete(result.savedId!)}
                className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
                title="Удалить"
              >
                ✕
              </button>
            </>
          ) : null}
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
  const [showAll, setShowAll] = useState(false)
  const [sortBy, setSortBy] = useState<'score' | 'date'>('score')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Load saved signals
  useEffect(() => {
    loadSignals()
  }, [page, statusFilter, dateFrom, dateTo])

  async function loadSignals() {
    try {
      const res = await getScannerSignals(page, statusFilter || undefined, dateFrom || undefined, dateTo || undefined)
      setSignals(res.data)
      setTotalPages(res.totalPages)
    } catch {}
  }

  async function handleDelete(id: number) {
    try {
      await deleteSignal(id)
      setSignals(prev => prev.filter(s => s.id !== id))
    } catch {}
  }

  async function handleScanTake(id: number, amount: number, modelType?: string, leverage?: number) {
    try {
      await takeSignalAsTrade(id, amount, modelType, leverage)
      setScanResults(prev => prev ? {
        ...prev,
        signals: prev.signals.map(s => s.savedId === id ? { ...s, _taken: true } as any : s),
      } : prev)
      loadSignals()
    } catch (err: any) {
      alert(err.message || 'Failed to take signal')
    }
  }

  async function handleScanSkip(id: number) {
    try {
      await skipSignal(id)
      setScanResults(prev => prev ? {
        ...prev,
        signals: prev.signals.map(s => s.savedId === id ? { ...s, _skipped: true } as any : s),
      } : prev)
      loadSignals()
    } catch {}
  }

  async function handleScanDelete(id: number) {
    try {
      await deleteSignal(id)
      setScanResults(prev => prev ? {
        ...prev,
        signals: prev.signals.filter(s => s.savedId !== id),
        total: prev.total - 1,
      } : prev)
    } catch {}
  }

  const sortedSignals = [...signals].sort((a, b) => {
    if (sortBy === 'score') return b.score - a.score
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
  const INITIAL_LIMIT = 8
  const visibleSignals = showAll ? sortedSignals : sortedSignals.slice(0, INITIAL_LIMIT)
  const hasMore = sortedSignals.length > INITIAL_LIMIT

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
          {/* Filters row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Status filter */}
            <div className="flex gap-1">
              {['', 'NEW', 'TAKEN', 'PARTIALLY_CLOSED', 'CLOSED', 'SL_HIT', 'EXPIRED'].map(s => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setPage(1); setShowAll(false) }}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {s || 'Все'}
                </button>
              ))}
            </div>

            {/* Date filter */}
            <div className="flex items-center gap-1.5 ml-auto">
              <input
                type="date"
                value={dateFrom}
                onChange={e => { setDateFrom(e.target.value); setPage(1); setShowAll(false) }}
                className="bg-input text-text-primary text-xs rounded px-2 py-1 border border-transparent focus:border-accent/40 focus:outline-none"
              />
              <span className="text-text-secondary text-xs">—</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => { setDateTo(e.target.value); setPage(1); setShowAll(false) }}
                className="bg-input text-text-primary text-xs rounded px-2 py-1 border border-transparent focus:border-accent/40 focus:outline-none"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(''); setDateTo(''); setPage(1) }}
                  className="text-xs text-text-secondary hover:text-short transition-colors px-1"
                  title="Сбросить даты"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Sort controls */}
          {signals.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">Сортировка:</span>
              <button
                onClick={() => setSortBy('score')}
                className={`px-2 py-0.5 text-xs rounded ${sortBy === 'score' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                По скору ↓
              </button>
              <button
                onClick={() => setSortBy('date')}
                className={`px-2 py-0.5 text-xs rounded ${sortBy === 'date' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                По дате
              </button>
              <span className="text-xs text-text-secondary ml-auto">{signals.length} сигналов</span>
            </div>
          )}

          {signals.length === 0 ? (
            <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
              Нет сигналов. Запустите сканер чтобы найти торговые возможности.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {visibleSignals.map(s => (
                  <SignalCard key={s.id} signal={s} onStatusChange={loadSignals} onDelete={handleDelete} />
                ))}
              </div>
              {hasMore && !showAll && (
                <div className="flex justify-center">
                  <button
                    onClick={() => setShowAll(true)}
                    className="px-4 py-2 text-sm rounded-lg bg-card text-text-secondary hover:text-accent hover:bg-card/80 transition-colors"
                  >
                    Показать все ({sortedSignals.length})
                  </button>
                </div>
              )}
              {showAll && hasMore && (
                <div className="flex justify-center">
                  <button
                    onClick={() => setShowAll(false)}
                    className="px-4 py-2 text-sm rounded-lg bg-card text-text-secondary hover:text-accent hover:bg-card/80 transition-colors"
                  >
                    Свернуть
                  </button>
                </div>
              )}
            </>
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
                <ScanResultCard key={i} result={s} onTake={handleScanTake} onSkip={handleScanSkip} onDelete={handleScanDelete} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
