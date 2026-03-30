import { useState, useEffect } from 'react'
import {
  getScannerSignals, triggerScan, updateSignalStatus, getScannerCoins, getScannerStatus,
  ScannerSignal, ScanResponse,
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
    TAKEN: { label: 'Взят', color: 'text-long bg-long/10' },
    EXPIRED: { label: 'Истёк', color: 'text-neutral bg-neutral/10' },
    HIT_TP: { label: 'TP Hit', color: 'text-long bg-long/10' },
    HIT_SL: { label: 'SL Hit', color: 'text-short bg-short/10' },
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
  const isLong = signal.type === 'LONG'
  const tps = (signal.takeProfits as { price: number; rr: number }[]) || []

  async function handleStatus(status: string) {
    try {
      await updateSignalStatus(signal.id, status)
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
        <ScoreBadge score={signal.score} />
      </div>

      {/* Score breakdown bar */}
      {signal.marketContext && (
        <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden mb-3">
          <div className="bg-blue-500" style={{ width: `${((signal.marketContext as any)?.scoreBreakdown?.technical || 0) / 100 * 100}%` }} title="Technical" />
          <div className="bg-purple-500" style={{ width: `${((signal.marketContext as any)?.scoreBreakdown?.multiTF || 0) / 100 * 100}%` }} title="Multi-TF" />
          <div className="bg-green-500" style={{ width: `${((signal.marketContext as any)?.scoreBreakdown?.volume || 0) / 100 * 100}%` }} title="Volume" />
          <div className="bg-yellow-500" style={{ width: `${((signal.marketContext as any)?.scoreBreakdown?.marketContext || 0) / 100 * 100}%` }} title="Market" />
          <div className="bg-orange-500" style={{ width: `${((signal.marketContext as any)?.scoreBreakdown?.patterns || 0) / 100 * 100}%` }} title="Patterns" />
        </div>
      )}

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

      {/* Leverage + Position + R:R */}
      <div className="flex items-center gap-3 mb-3 text-sm">
        <span className="text-text-secondary">Leverage: <span className="text-text-primary font-mono">{signal.leverage}x</span></span>
        <span className="text-text-secondary">Позиция: <span className="text-text-primary font-mono">{signal.positionPct}%</span></span>
        {signal.marketContext && (
          <span className="text-text-secondary">Режим: <span className="text-text-primary">{(signal.marketContext as any)?.regime}</span></span>
        )}
      </div>

      {/* AI Analysis */}
      {signal.aiAnalysis && (
        <div className="bg-input rounded-lg p-3 mb-3 text-sm text-text-secondary">
          <div className="text-xs text-accent mb-1 font-medium">GPT-5.4 анализ:</div>
          <div className="whitespace-pre-wrap">{signal.aiAnalysis}</div>
        </div>
      )}

      {/* Expandable details */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-text-secondary hover:text-accent transition-colors mb-2"
      >
        {expanded ? '▾ Скрыть детали' : '▸ Показать детали'}
      </button>

      {expanded && tps.length > 2 && (
        <div className="mb-3">
          <div className="bg-input rounded-lg p-2 inline-block">
            <div className="text-xs text-text-secondary">TP3 (R:R {tps[2].rr})</div>
            <div className="font-mono font-bold text-long">${tps[2].price}</div>
          </div>
        </div>
      )}

      {/* Footer: time + actions */}
      <div className="flex items-center justify-between border-t border-card pt-2">
        <span className="text-xs text-text-secondary">
          {formatDate(signal.createdAt)}
          {signal.expiresAt && <span> · истекает {formatDate(signal.expiresAt)}</span>}
        </span>

        {signal.status === 'NEW' && (
          <div className="flex gap-1">
            <button
              onClick={() => handleStatus('TAKEN')}
              className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20 transition-colors"
            >
              Взять
            </button>
            <button
              onClick={() => handleStatus('EXPIRED')}
              className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20 transition-colors"
            >
              Пропустить
            </button>
          </div>
        )}
        {signal.status === 'TAKEN' && (
          <div className="flex gap-1">
            <button onClick={() => handleStatus('HIT_TP')} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20">TP Hit</button>
            <button onClick={() => handleStatus('HIT_SL')} className="px-2 py-1 text-xs rounded bg-short/10 text-short hover:bg-short/20">SL Hit</button>
          </div>
        )}
      </div>
    </div>
  )
}

// === Scan Results (from fresh scan) ===
function ScanResultCard({ result }: { result: ScanResponse['signals'][0] }) {
  const isLong = result.type === 'LONG'
  const isRejected = result.gptVerdict === 'REJECT'

  return (
    <div className={`bg-card rounded-xl p-4 border ${isRejected ? 'border-short/20 opacity-60' : 'border-card hover:border-accent/30'} transition-colors`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-text-primary">{result.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {result.type}
          </span>
          <StrategyBadge strategy={result.strategy} />
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${isRejected ? 'bg-short/10 text-short' : 'bg-long/10 text-long'}`}>
            GPT: {result.gptVerdict} ({result.gptConfidence}/10)
          </span>
        </div>
        <ScoreBadge score={result.score} />
      </div>

      {/* Score breakdown */}
      <div className="flex gap-2 mb-3 text-xs text-text-secondary">
        <span>Tech: {result.scoreBreakdown.technical}/35</span>
        <span>Multi-TF: {result.scoreBreakdown.multiTF}/20</span>
        <span>Vol: {result.scoreBreakdown.volume}/15</span>
        <span>Market: {result.scoreBreakdown.marketContext}/15</span>
        <span>Patterns: {result.scoreBreakdown.patterns}/15</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход</div>
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

      {/* GPT analysis */}
      {result.gptReasoning && (
        <div className="bg-input rounded-lg p-3 text-sm text-text-secondary">
          <div className="text-xs text-accent mb-1 font-medium">GPT-5.4:</div>
          <div>{result.gptReasoning}</div>
          {result.gptRisks.length > 0 && (
            <div className="mt-1 text-xs text-short">
              Риски: {result.gptRisks.join(' · ')}
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
  const [minScore, setMinScore] = useState(55)

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
            Автоматический поиск торговых возможностей по 20 монетам
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
            Результаты скана {scanResults ? `(${scanResults.confirmed}/${scanResults.total})` : ''}
          </button>
        </div>
      )}

      {/* Saved signals tab */}
      {tab === 'saved' && !loading && (
        <>
          {/* Status filter */}
          <div className="flex gap-1">
            {['', 'NEW', 'TAKEN', 'HIT_TP', 'HIT_SL', 'EXPIRED'].map(s => (
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
              <div className="ml-auto">
                <span className="text-long">{scanResults.confirmed} подтверждено</span>
                <span className="text-text-secondary mx-1">·</span>
                <span className="text-short">{scanResults.rejected} отклонено</span>
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
