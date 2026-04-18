import { useState, useEffect } from 'react'
import {
  triggerScan, cancelScan, takeSignalAsTrade, skipSignal, deleteSignal,
  getScannerCoins, getBudget,
  subscribeScanProgress, ScanProgress,
  ScannerSignal, ScanResponse,
} from '../api/client'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import ScannerSignalsTab from '../components/scanner/ScannerSignalsTab'
import ScannerScanTab from '../components/scanner/ScannerScanTab'
import ScannerEntryTab from '../components/scanner/ScannerEntryTab'
import ScannerCalcTab from '../components/scanner/ScannerCalcTab'
import ScannerCoinListTab from '../components/scanner/ScannerCoinListTab'
import ScannerAnalyticsTab from '../components/scanner/ScannerAnalyticsTab'

function scannerSignalToPosition(s: ScannerSignal): PositionChartPosition {
  const tps = (s.takeProfits as { price: number; rr: number }[] | undefined)?.map(tp => tp.price) || []
  return {
    coin: s.coin,
    type: s.type as 'LONG' | 'SHORT',
    entry: s.entry,
    stopLoss: s.stopLoss,
    takeProfits: tps,
    // For scanner signals: takenAt = real entry (if taken), otherwise null (NEW — pale projection only)
    openedAt: s.takenAt,
    closedAt: s.closedAt,
    partialCloses: (s.closes || []).map(c => ({
      price: c.price,
      percent: c.percent,
      closedAt: c.closedAt,
      isSL: c.isSL,
    })),
  }
}

export default function Scanner() {
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'saved' | 'scan' | 'entry' | 'calc' | 'coins' | 'analytics'>('saved')
  const [useGPT, setUseGPT] = useState(true)
  const [minScore, setMinScore] = useState(70)
  const [chartSignal, setChartSignal] = useState<ScannerSignal | null>(null)
  const [coinCount, setCoinCount] = useState(0)
  const [balance, setBalance] = useState(0)
  const [manualBalance, setManualBalance] = useState('')
  const [riskPct, setRiskPct] = useState(2)
  const [signalsRefreshKey, setSignalsRefreshKey] = useState(0)
  const refreshSignals = () => setSignalsRefreshKey(k => k + 1)

  // Entry Analyzer state (loading + message stay in parent for overlay display)
  const [entryLoading, setEntryLoading] = useState(false)

  // Load coin count & balance on mount
  useEffect(() => {
    getScannerCoins().then(c => setCoinCount(c.length)).catch(() => {})
    getBudget().then(r => { if (r.balance) setBalance(r.balance) }).catch(() => {})
  }, [])

  async function handleScanTake(id: number, amount: number, modelType?: string, leverage?: number, orderType?: 'market' | 'limit') {
    try {
      await takeSignalAsTrade(id, amount, modelType, leverage, orderType || 'market')
      setScanResults(prev => prev ? {
        ...prev,
        signals: prev.signals.map(s => s.savedId === id ? { ...s, _taken: true } as any : s),
      } : prev)
      refreshSignals()
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
      refreshSignals()
    } catch (err: any) { alert(err?.message || 'Failed to skip signal') }
  }

  async function handleScanDelete(id: number) {
    try {
      await deleteSignal(id)
      setScanResults(prev => prev ? {
        ...prev,
        signals: prev.signals.filter(s => s.savedId !== id),
        total: prev.total - 1,
      } : prev)
    } catch (err) { console.error('[Scanner] Failed to delete scan signal:', err) }
  }

  // Run scan
  async function handleScan() {
    setLoading(true)
    setError('')
    setScanResults(null)
    setTab('scan')
    setProgress(null)

    // Подписка на live-прогресс через SSE
    const unsubscribe = subscribeScanProgress((p) => {
      setProgress(p)
    })

    try {
      const res = await triggerScan(undefined, minScore, useGPT)
      setScanResults(res)
      refreshSignals()
    } catch (err: any) {
      setError(err.message || 'Scan failed')
    } finally {
      unsubscribe()
      setLoading(false)
      setProgress(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Сканер сигналов</h1>
          <p className="text-sm text-text-secondary mt-1">
            Автоматический поиск торговых возможностей по {coinCount || '...'} монетам
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Balance & Risk */}
          <div className="flex items-center gap-2 bg-input rounded-lg px-3 py-1.5">
            <label className="text-xs text-text-secondary">Депо:</label>
            <input
              type="number"
              value={balance > 0 && !manualBalance ? String(Math.round(balance)) : manualBalance}
              onChange={e => { setManualBalance(e.target.value); setBalance(Number(e.target.value) || 0) }}
              placeholder="0"
              className="w-20 bg-card text-text-primary rounded px-2 py-0.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
            />
            <span className="text-text-secondary text-xs">|</span>
            <label className="text-xs text-text-secondary">Риск:</label>
            <input
              type="number"
              value={riskPct}
              onChange={e => setRiskPct(Number(e.target.value) || 0)}
              min={0.5} max={20} step={0.5}
              className="w-14 bg-card text-text-primary rounded px-2 py-0.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
            />
            <span className="text-xs text-text-secondary">%</span>
          </div>

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
          {loading ? (
            <button
              onClick={() => cancelScan().catch(() => {})}
              className="px-4 py-2 rounded-lg font-medium text-sm transition-colors bg-short text-white hover:bg-short/80"
            >
              Остановить
            </button>
          ) : (
            <button
              onClick={handleScan}
              className="px-4 py-2 rounded-lg font-medium text-sm transition-colors bg-accent text-[#0b0e11] hover:bg-accent/90"
            >
              Сканировать
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="bg-card rounded-xl p-6">
          {progress ? (() => {
            const phaseLabels: Record<string, string> = {
              starting: 'Старт',
              market_data: 'Рыночные данные',
              fetching: 'Свечи',
              regime: 'Режим',
              scoring: 'Скоринг',
              gpt: 'GPT анализ',
              saving: 'Сохранение',
              done: 'Готово',
              error: 'Ошибка',
            }
            const phases = ['market_data', 'fetching', 'regime', 'scoring', 'gpt', 'saving']
            const currentIdx = phases.indexOf(progress.phase)
            const elapsed = progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0
            return (
              <>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    {progress.phase !== 'done' && progress.phase !== 'error' && (
                      <div className="animate-spin h-5 w-5 border-2 border-accent border-t-transparent rounded-full" />
                    )}
                    <div>
                      <div className="text-text-primary font-medium text-sm">{progress.message}</div>
                      <div className="text-xs text-text-secondary mt-0.5">
                        {phaseLabels[progress.phase] || progress.phase}
                        {progress.total > 0 && ` · ${progress.current}/${progress.total}`}
                        {elapsed > 0 && ` · ${elapsed}s`}
                      </div>
                    </div>
                  </div>
                  <div className="font-mono text-accent text-lg font-bold">{progress.percent}%</div>
                </div>

                {/* Progress bar */}
                <div className="h-2 bg-input rounded-full overflow-hidden mb-4">
                  <div
                    className={`h-full transition-all duration-300 ${
                      progress.phase === 'error' ? 'bg-short' : 'bg-accent'
                    }`}
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>

                {/* Phase steps */}
                <div className="flex items-center justify-between gap-1 text-[10px]">
                  {phases.map((p, i) => {
                    const done = currentIdx > i || progress.phase === 'done'
                    const active = currentIdx === i
                    return (
                      <div
                        key={p}
                        className={`flex-1 text-center px-1 py-1 rounded ${
                          active
                            ? 'bg-accent/15 text-accent border border-accent/40'
                            : done
                              ? 'text-long'
                              : 'text-text-secondary'
                        }`}
                      >
                        {done && !active ? '✓ ' : ''}
                        {phaseLabels[p]}
                      </div>
                    )
                  })}
                </div>

                {/* Counters */}
                {(progress.candidates !== undefined || progress.passed !== undefined) && (
                  <div className="flex gap-4 mt-4 pt-3 border-t border-input text-xs text-text-secondary">
                    {progress.candidates !== undefined && (
                      <span>Кандидатов: <span className="text-text-primary font-mono">{progress.candidates}</span></span>
                    )}
                    {progress.passed !== undefined && (
                      <span>Прошли скоринг: <span className="text-long font-mono">{progress.passed}</span></span>
                    )}
                  </div>
                )}
              </>
            )
          })() : (
            <div className="text-center py-2">
              <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
              <div className="text-text-secondary text-sm">Подключение к стриму прогресса...</div>
            </div>
          )}
        </div>
      )}

      {/* Entry loading (старый цикл фраз) */}
      {entryLoading && (
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
      {!loading && !entryLoading && (
        <div className="overflow-x-auto -mx-4 px-4 scrollbar-hide">
          <div className="flex gap-1 border-b border-card min-w-max">
            {([
              { key: 'saved', label: 'Сигналы' },
              { key: 'scan', label: `Скан${scanResults ? ` (${scanResults.total})` : ''}` },
              { key: 'entry', label: 'Анализ входа' },
              { key: 'calc', label: 'Калькулятор' },
              { key: 'coins', label: `Монеты${coinCount > 0 ? ` (${coinCount})` : ''}` },
              { key: 'analytics', label: 'Аналитика' },
            ] as const).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 sm:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${tab === t.key ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Saved signals tab */}
      {tab === 'saved' && !loading && (
        <ScannerSignalsTab
          balance={balance}
          riskPct={riskPct}
          refreshKey={signalsRefreshKey}
          onShowChart={setChartSignal}
        />
      )}

      {/* Scan results tab */}
      {tab === 'scan' && !loading && (
        <ScannerScanTab
          scanResults={scanResults}
          balance={balance}
          riskPct={riskPct}
          onTake={handleScanTake}
          onSkip={handleScanSkip}
          onDelete={handleScanDelete}
        />
      )}

      {/* Entry Analyzer tab */}
      {tab === 'entry' && !loading && !entryLoading && (
        <ScannerEntryTab
          balance={balance}
          riskPct={riskPct}
          entryLoading={entryLoading}
          loadingMsg={loadingMsg}
          onEntryLoadingChange={setEntryLoading}
          onLoadingMsgChange={setLoadingMsg}
        />
      )}

      {/* Risk Calculator tab */}
      {tab === 'calc' && (
        <ScannerCalcTab balance={balance} riskPct={riskPct} />
      )}

      {/* Coin List tab */}
      {tab === 'coins' && (
        <ScannerCoinListTab onCoinCountChange={setCoinCount} />
      )}

      {/* Analytics tab */}
      {tab === 'analytics' && (
        <ScannerAnalyticsTab />
      )}

      {chartSignal && (
        <PositionChartModal
          position={scannerSignalToPosition(chartSignal)}
          onClose={() => setChartSignal(null)}
        />
      )}
    </div>
  )
}
