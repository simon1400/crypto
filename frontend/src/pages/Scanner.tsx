import { useState, useEffect } from 'react'
import {
  triggerScan, takeSignalAsTrade, skipSignal, deleteSignal,
  getScannerCoins, getBudget,
  getScannerCoinList, saveScannerCoinList,
  subscribeScanProgress, ScanProgress,
  ScannerSignal, ScanResponse,
  getPostTp1Analytics, getSetupPerformance, getEntryModelComparison,
} from '../api/client'
import { LOADING_MESSAGES } from '../components/scanner/constants'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'
import ScannerSignalsTab from '../components/scanner/ScannerSignalsTab'
import ScannerScanTab from '../components/scanner/ScannerScanTab'
import ScannerEntryTab from '../components/scanner/ScannerEntryTab'
import ScannerCalcTab from '../components/scanner/ScannerCalcTab'

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
  const [minScore, setMinScore] = useState(50)
  const [chartSignal, setChartSignal] = useState<ScannerSignal | null>(null)
  const [coinCount, setCoinCount] = useState(0)
  const [balance, setBalance] = useState(0)
  const [manualBalance, setManualBalance] = useState('')
  const [riskPct, setRiskPct] = useState(2)
  const [signalsRefreshKey, setSignalsRefreshKey] = useState(0)
  const refreshSignals = () => setSignalsRefreshKey(k => k + 1)

  // Entry Analyzer state (loading + message stay in parent for overlay display)
  const [entryLoading, setEntryLoading] = useState(false)

  // Coin List state
  const [allCoins, setAllCoins] = useState<string[]>([])
  const [selectedCoins, setSelectedCoins] = useState<string[]>([])
  const [coinSearch, setCoinSearch] = useState('')
  const [coinListLoading, setCoinListLoading] = useState(false)
  const [coinListSaving, setCoinListSaving] = useState(false)

  // Analytics state
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsDays, setAnalyticsDays] = useState(30)

  async function loadAnalytics(days?: number) {
    setAnalyticsLoading(true)
    try {
      const d = days ?? analyticsDays
      const [postTp1, setupPerf, entryModels] = await Promise.all([
        getPostTp1Analytics(d),
        getSetupPerformance(d),
        getEntryModelComparison(d),
      ])
      setAnalyticsData({ postTp1, setupPerf, entryModels })
    } catch (err) { console.error('[Scanner] Failed to load analytics:', err) } finally {
      setAnalyticsLoading(false)
    }
  }

  async function loadCoinList() {
    if (allCoins.length > 0) return // already loaded
    setCoinListLoading(true)
    try {
      const data = await getScannerCoinList()
      setAllCoins(data.available)
      setSelectedCoins(data.selected)
    } catch (err) { console.error('[Scanner] Failed to load coin list:', err) } finally {
      setCoinListLoading(false)
    }
  }

  async function handleSaveCoinList() {
    setCoinListSaving(true)
    try {
      await saveScannerCoinList(selectedCoins)
      setCoinCount(selectedCoins.length)
    } catch (err: any) { alert(err?.message || 'Failed to save coin list') } finally {
      setCoinListSaving(false)
    }
  }

  function toggleCoin(coin: string) {
    setSelectedCoins(prev =>
      prev.includes(coin) ? prev.filter(c => c !== coin) : [...prev, coin]
    )
  }

  function selectAllFiltered(coins: string[]) {
    setSelectedCoins(prev => {
      const set = new Set(prev)
      coins.forEach(c => set.add(c))
      return [...set]
    })
  }

  function deselectAllFiltered(coins: string[]) {
    setSelectedCoins(prev => prev.filter(c => !coins.includes(c)))
  }

  // Load coin count, coin list & balance
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
          <button
            onClick={handleScan}
            disabled={loading}
            className="px-4 py-2 rounded-lg font-medium text-sm disabled:opacity-50 transition-colors bg-accent text-[#0b0e11] hover:bg-accent/90"
          >
            {loading ? 'Сканирую...' : 'Сканировать'}
          </button>
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
          <button
            onClick={() => setTab('entry')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'entry' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Анализ входа
          </button>
          <button
            onClick={() => setTab('calc')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'calc' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Калькулятор
          </button>
          <button
            onClick={() => { setTab('coins'); loadCoinList() }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'coins' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Монеты {selectedCoins.length > 0 ? `(${selectedCoins.length})` : ''}
          </button>
          <button
            onClick={() => { setTab('analytics'); loadAnalytics() }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'analytics' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Аналитика
          </button>
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

      {/* Coins tab */}
      {tab === 'coins' && (
        <div className="space-y-4">
          {coinListLoading ? (
            <p className="text-text-secondary text-sm">Загрузка списка монет с Bybit...</p>
          ) : (
            <>
              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="text"
                  value={coinSearch}
                  onChange={e => setCoinSearch(e.target.value.toUpperCase())}
                  placeholder="Поиск монеты..."
                  className="bg-input text-text-primary rounded-lg px-3 py-2 text-sm border border-card focus:border-accent outline-none w-48"
                />
                <span className="text-text-secondary text-sm">
                  Выбрано: <span className="text-accent font-mono">{selectedCoins.length}</span> из {allCoins.length}
                </span>
                <button
                  onClick={() => {
                    const filtered = allCoins.filter(c => !coinSearch || c.includes(coinSearch))
                    const allSelected = filtered.every(c => selectedCoins.includes(c))
                    allSelected ? deselectAllFiltered(filtered) : selectAllFiltered(filtered)
                  }}
                  className="px-3 py-1.5 bg-input text-text-secondary rounded-lg text-xs hover:text-text-primary transition-colors"
                >
                  {coinSearch
                    ? (allCoins.filter(c => c.includes(coinSearch)).every(c => selectedCoins.includes(c)) ? 'Снять найденные' : 'Выбрать найденные')
                    : (selectedCoins.length === allCoins.length ? 'Снять все' : 'Выбрать все')}
                </button>
                <button
                  onClick={() => setSelectedCoins([])}
                  className="px-3 py-1.5 bg-short/20 text-short rounded-lg text-xs hover:bg-short/30 transition-colors"
                >
                  Очистить
                </button>
                <button
                  onClick={handleSaveCoinList}
                  disabled={coinListSaving}
                  className="px-4 py-1.5 bg-accent text-primary font-bold rounded-lg text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {coinListSaving ? 'Сохраняю...' : 'Сохранить'}
                </button>
              </div>

              {/* Coin grid */}
              <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 xl:grid-cols-14 gap-1.5">
                {allCoins
                  .filter(c => !coinSearch || c.includes(coinSearch))
                  .map(coin => {
                    const isSelected = selectedCoins.includes(coin)
                    return (
                      <button
                        key={coin}
                        onClick={() => toggleCoin(coin)}
                        className={`px-2 py-1.5 rounded text-xs font-mono transition-all ${
                          isSelected
                            ? 'bg-accent/15 text-accent border border-accent/50'
                            : 'bg-card text-text-secondary border border-transparent hover:border-card hover:text-text-primary'
                        }`}
                      >
                        {coin}
                      </button>
                    )
                  })}
              </div>

              {allCoins.length > 0 && !allCoins.filter(c => !coinSearch || c.includes(coinSearch)).length && (
                <p className="text-text-secondary text-sm text-center py-4">Ничего не найдено</p>
              )}
            </>
          )}
        </div>
      )}

      {/* Analytics tab */}
      {tab === 'analytics' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-sm text-text-secondary">Период:</span>
            {[7, 14, 30, 90].map(d => (
              <button key={d} onClick={() => { setAnalyticsDays(d); loadAnalytics(d) }}
                className={`px-3 py-1 text-xs rounded ${analyticsDays === d ? 'bg-accent/15 text-accent' : 'bg-card text-text-secondary hover:text-text-primary'}`}>
                {d}д
              </button>
            ))}
          </div>

          {analyticsLoading && <div className="text-text-secondary text-sm">Загрузка аналитики...</div>}

          {analyticsData && (
            <>
              {/* Post-TP1 Stats */}
              {analyticsData.postTp1 && (
                <div className="bg-card rounded-xl p-5">
                  <h3 className="text-text-primary font-bold mb-3">Post-TP1 анализ</h3>
                  {analyticsData.postTp1.totalTrades === 0 ? (
                    <div className="text-text-secondary text-sm">Нет закрытых сделок за выбранный период</div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">Всего сделок</div>
                        <div className="font-bold text-text-primary">{analyticsData.postTp1.totalTrades}</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">TP1 hit rate</div>
                        <div className="font-bold text-long">{analyticsData.postTp1.tp1HitRate}%</div>
                        <div className="text-xs text-text-secondary">{analyticsData.postTp1.tp1HitCount} из {analyticsData.postTp1.totalTrades}</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">TP2 после TP1</div>
                        <div className="font-bold text-long">{analyticsData.postTp1.tp2AfterTp1Rate}%</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">BE стоп после TP1</div>
                        <div className="font-bold text-short">{analyticsData.postTp1.beExitAfterTp1Rate}%</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">Средний MFE</div>
                        <div className="font-bold text-long">+{analyticsData.postTp1.avgMfe}%</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">MFE после TP1</div>
                        <div className="font-bold text-long">+{analyticsData.postTp1.avgMfeAfterTp1}%</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">Потенциальный TP2 упущен</div>
                        <div className="font-bold text-accent">{analyticsData.postTp1.potentialTp2Missed}</div>
                        <div className="text-xs text-text-secondary">{analyticsData.postTp1.potentialTp2MissedRate}% от TP1</div>
                      </div>
                      <div className="bg-input rounded-lg p-3">
                        <div className="text-xs text-text-secondary">Среднее время в сделке</div>
                        <div className="font-bold text-text-primary">
                          {analyticsData.postTp1.avgTimeInTradeMin >= 60
                            ? `${Math.floor(analyticsData.postTp1.avgTimeInTradeMin / 60)}ч ${Math.round(analyticsData.postTp1.avgTimeInTradeMin % 60)}м`
                            : `${Math.round(analyticsData.postTp1.avgTimeInTradeMin)}м`}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Setup Performance */}
              {analyticsData.setupPerf?.length > 0 && (
                <div className="bg-card rounded-xl p-5">
                  <h3 className="text-text-primary font-bold mb-3">Перформанс по категориям</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-text-secondary text-xs">
                          <th className="text-left py-2 px-2">Категория</th>
                          <th className="text-right py-2 px-2">Кол-во</th>
                          <th className="text-right py-2 px-2">Win Rate</th>
                          <th className="text-right py-2 px-2">Avg MFE</th>
                          <th className="text-right py-2 px-2">Avg MAE</th>
                          <th className="text-right py-2 px-2">TP1 Rate</th>
                          <th className="text-right py-2 px-2">Avg R:R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsData.setupPerf.map((row: any) => (
                          <tr key={row.setupCategory} className="border-t border-card">
                            <td className="py-2 px-2 font-medium text-text-primary">{row.setupCategory}</td>
                            <td className="py-2 px-2 text-right font-mono">{row.count}</td>
                            <td className={`py-2 px-2 text-right font-mono ${row.winRate >= 50 ? 'text-long' : 'text-short'}`}>{row.winRate}%</td>
                            <td className="py-2 px-2 text-right font-mono text-long">+{row.avgMfe}%</td>
                            <td className="py-2 px-2 text-right font-mono text-short">{row.avgMae}%</td>
                            <td className="py-2 px-2 text-right font-mono">{row.tp1HitRate}%</td>
                            <td className="py-2 px-2 text-right font-mono">{row.avgRR}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Entry Model Comparison */}
              {analyticsData.entryModels?.length > 0 && (
                <div className="bg-card rounded-xl p-5">
                  <h3 className="text-text-primary font-bold mb-3">Модели входа: confirmation vs aggressive</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-text-secondary text-xs">
                          <th className="text-left py-2 px-2">Модель</th>
                          <th className="text-right py-2 px-2">Кол-во</th>
                          <th className="text-right py-2 px-2">Win Rate</th>
                          <th className="text-right py-2 px-2">Avg P&L%</th>
                          <th className="text-right py-2 px-2">Avg MFE</th>
                          <th className="text-right py-2 px-2">Avg MAE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsData.entryModels.map((row: any) => (
                          <tr key={row.model} className="border-t border-card">
                            <td className="py-2 px-2 font-medium text-text-primary">{row.model}</td>
                            <td className="py-2 px-2 text-right font-mono">{row.count}</td>
                            <td className={`py-2 px-2 text-right font-mono ${row.winRate >= 50 ? 'text-long' : 'text-short'}`}>{row.winRate}%</td>
                            <td className={`py-2 px-2 text-right font-mono ${row.avgPnlPct >= 0 ? 'text-long' : 'text-short'}`}>{row.avgPnlPct}%</td>
                            <td className="py-2 px-2 text-right font-mono text-long">+{row.avgMfe}%</td>
                            <td className="py-2 px-2 text-right font-mono text-short">{row.avgMae}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
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
