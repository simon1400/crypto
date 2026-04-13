import { useState, useEffect } from 'react'
import { sanitizeCsvField } from '../utils/sanitizeCsv'
import {
  getScannerSignals, triggerScan, takeSignalAsTrade, skipSignal, deleteSignal,
  deleteAllSignals, deleteUnusedSignals, getScannerCoins, getBudget,
  analyzeEntry, getSavedEntrySignals, deleteEntrySignal,
  getScannerCoinList, saveScannerCoinList,
  subscribeScanProgress, ScanProgress,
  ScannerSignal, ScanResponse, EntryAnalysisResponse, EntryAnalysisSignal,
  getPostTp1Analytics, getSetupPerformance, getEntryModelComparison,
} from '../api/client'
import UnifiedSignalCard from '../components/scanner/UnifiedSignalCard'
import CoinSearchSelector from '../components/scanner/CoinSearchSelector'
import EntryResultCard from '../components/scanner/EntryResultCard'
import { SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES, LOADING_MESSAGES, ENTRY_MESSAGES } from '../components/scanner/constants'
import PositionChartModal, { PositionChartPosition } from '../components/PositionChartModal'

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
  const [signals, setSignals] = useState<ScannerSignal[]>([])
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'saved' | 'scan' | 'entry' | 'calc' | 'coins' | 'analytics'>('saved')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [useGPT, setUseGPT] = useState(true)
  const [minScore, setMinScore] = useState(50)
  const [showAll, setShowAll] = useState(false)
  const [sortBy, setSortBy] = useState<'score' | 'date'>('score')
  const [chartSignal, setChartSignal] = useState<ScannerSignal | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [confirmDeleteUnused, setConfirmDeleteUnused] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [coinCount, setCoinCount] = useState(0)
  const [balance, setBalance] = useState(0)
  const [manualBalance, setManualBalance] = useState('')
  const [riskPct, setRiskPct] = useState(2)

  // Entry Analyzer state
  const [entryResults, setEntryResults] = useState<EntryAnalysisResponse | null>(null)
  const [entryLoading, setEntryLoading] = useState(false)
  const [entryCoins, setEntryCoins] = useState<string[]>([])
  const [entryUseGPT, setEntryUseGPT] = useState(true)
  const [savedEntries, setSavedEntries] = useState<any[]>([])

  // Coin List state
  const [allCoins, setAllCoins] = useState<string[]>([])
  const [selectedCoins, setSelectedCoins] = useState<string[]>([])
  const [coinSearch, setCoinSearch] = useState('')
  const [coinListLoading, setCoinListLoading] = useState(false)
  const [coinListSaving, setCoinListSaving] = useState(false)

  // Risk Calculator state
  const [calcEntry, setCalcEntry] = useState('')
  const [calcSL, setCalcSL] = useState('')
  const [calcLeverage, setCalcLeverage] = useState('10')
  const [calcEntry2, setCalcEntry2] = useState('')
  const [calcShowEntry2, setCalcShowEntry2] = useState(false)

  const [csvExporting, setCsvExporting] = useState(false)

  // Analytics state
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsDays, setAnalyticsDays] = useState(30)

  async function exportTakenCSV() {
    setCsvExporting(true)
    try {
      const allSignals: ScannerSignal[] = []
      let p = 1
      while (true) {
        const res = await getScannerSignals(p)
        allSignals.push(...res.data)
        if (p >= res.totalPages) break
        p++
      }
      const taken = allSignals.filter(s => s.takenAt)

      const esc = (v: string) => `"${sanitizeCsvField(v).replace(/"/g, '""')}"`

      const header = [
        'Signal ID', 'Монета', 'Тип', 'Стратегия', 'Score', 'Setup Score', 'Setup Category', 'Execution Type', 'Entry Model', 'Плечо',
        'Цена входа', 'Initial Stop', 'Current Stop', 'SL %',
        'TP1 цена', 'TP1 R:R', 'TP2 цена', 'TP2 R:R', 'TP3 цена', 'TP3 R:R',
        'Размер (маржа)', 'Размер (с плечом)', '% от депозита',
        'Реализовано P&L', 'Закрыто %', 'Статус', 'Exit Reason',
        'Создан', 'Взят', 'Закрыт', 'Время в сделке (мин)',
        'Закрытие 1 цена', 'Закрытие 1 %', 'Закрытие 1 P&L', 'Закрытие 1 дата', 'Закрытие 1 SL?',
        'Закрытие 2 цена', 'Закрытие 2 %', 'Закрытие 2 P&L', 'Закрытие 2 дата', 'Закрытие 2 SL?',
        'Закрытие 3 цена', 'Закрытие 3 %', 'Закрытие 3 P&L', 'Закрытие 3 дата', 'Закрытие 3 SL?',
        'Fear & Greed', 'Режим рынка', 'Категория', 'Фандинг', 'OI изм.',
        'Stop → BE', 'Trailing', 'MFE %', 'MAE %', 'TP1 Hit', 'TP2 Hit', 'TP3 Hit',
        // New context fields
        'RSI 1h', 'ADX 1h', 'Volume Ratio', 'Funding Rate', 'OI Δ 1h', 'OI Δ 4h',
        'Distance to EMA20', 'Distance to VWAP', 'Impulse Extension',
        'Data Completeness',
        'GPT анализ',
      ]

      const fmt2 = (n: number) => Number(n).toFixed(2)

      const rows = taken.map(s => {
        const tps = s.takeProfits || []
        const closes = s.closes || []
        const mc = s.marketContext || {} as any
        const sc = mc.signal_context || {} as any
        const dir = s.type === 'LONG' ? 1 : -1
        const initialStop = s.initialStop ?? mc.initial_stop ?? s.stopLoss
        const currentStop = s.currentStop ?? mc.current_stop ?? s.stopLoss
        const slPct = ((initialStop - s.entry) / s.entry) * 100 * dir * s.leverage

        const closeData = (i: number) => {
          const c = closes[i]
          if (!c) return ['', '', '', '', '']
          return [c.price, c.percent + '%', fmt2(c.pnl) + '$', c.closedAt, c.isSL ? 'Да' : 'Нет']
        }

        return [
          s.id,
          s.coin,
          s.type,
          s.strategy,
          s.score,
          s.setupScore ?? mc.setup_score ?? '',
          s.setupCategory ?? mc.setup_category ?? '',
          s.executionType ?? mc.execution_type ?? '',
          s.entryModel ?? mc.entry_model ?? mc.bestEntryType ?? '',
          s.leverage,
          s.entry,
          initialStop,
          currentStop,
          fmt2(slPct) + '%',
          tps[0]?.price ?? '', tps[0]?.rr ?? '',
          tps[1]?.price ?? '', tps[1]?.rr ?? '',
          tps[2]?.price ?? '', tps[2]?.rr ?? '',
          fmt2(s.amount),
          fmt2(s.amount * s.leverage),
          s.positionPct + '%',
          fmt2(s.realizedPnl),
          s.closedPct + '%',
          s.status,
          s.exitReason ?? '',
          s.createdAt,
          s.takenAt || '',
          s.closedAt || '',
          s.timeInTradeMin ?? '',
          ...closeData(0),
          ...closeData(1),
          ...closeData(2),
          mc.fearGreed ?? mc.fearGreedZone ?? '',
          mc.regime ?? '',
          mc.category ?? '',
          mc.funding != null ? (typeof mc.funding === 'object' ? fmt2(mc.funding.fundingRate * 100) + '%' : fmt2(mc.funding)) : '',
          mc.oi != null ? (typeof mc.oi === 'object' ? fmt2(mc.oi.oiChangePct1h) + '%' : fmt2(mc.oiChange) + '%') : '',
          s.stopMovedToBe ? 'Да' : 'Нет',
          s.trailingActivated ? 'Да' : 'Нет',
          s.mfe != null ? fmt2(s.mfe) + '%' : '',
          s.mae != null ? fmt2(s.mae) + '%' : '',
          s.tp1HitTimestamp ? 'Да' : 'Нет',
          s.tp2HitTimestamp ? 'Да' : 'Нет',
          s.tp3HitTimestamp ? 'Да' : 'Нет',
          // Context fields from signal_context
          sc.rsi_1h ?? '',
          sc.adx_1h ?? '',
          sc.volume_ratio ?? '',
          sc.funding_rate != null ? fmt2(sc.funding_rate * 100) + '%' : '',
          sc.oi_change_1h != null ? fmt2(sc.oi_change_1h) + '%' : '',
          sc.oi_change_4h != null ? fmt2(sc.oi_change_4h) + '%' : '',
          sc.distance_to_ema20 != null ? fmt2(sc.distance_to_ema20) + '%' : '',
          sc.distance_to_vwap != null ? fmt2(sc.distance_to_vwap) + '%' : '',
          sc.impulse_extension_at_entry_atr_1h ?? '',
          sc.data_completeness != null ? fmt2(sc.data_completeness * 100) + '%' : '',
          esc(s.aiAnalysis || ''),
        ].map(v => typeof v === 'string' && v.startsWith('"') ? v : esc(String(v)))
      })

      const bom = '\uFEFF'
      const csv = bom + [header.map(h => esc(h)).join(';'), ...rows.map(r => r.join(';'))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `signals_taken_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[Scanner] CSV export error:', err)
    } finally {
      setCsvExporting(false)
    }
  }

  // Load saved entry analyses
  useEffect(() => {
    loadSavedEntries()
  }, [])

  async function loadSavedEntries() {
    try {
      const data = await getSavedEntrySignals()
      setSavedEntries(data)
    } catch {}
  }

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
    } catch {} finally {
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
    } catch {} finally {
      setCoinListLoading(false)
    }
  }

  async function handleSaveCoinList() {
    setCoinListSaving(true)
    try {
      await saveScannerCoinList(selectedCoins)
      setCoinCount(selectedCoins.length)
    } catch {} finally {
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

  // Load saved signals
  useEffect(() => {
    loadSignals()
  }, [page, statusFilter, dateFrom, dateTo])

  async function loadSignals() {
    try {
      const res = await getScannerSignals(page, statusFilter || undefined, dateFrom || undefined, dateTo || undefined)
      setSignals(res.data.filter((s: any) => s.strategy !== 'entry_analysis'))
      setTotalPages(res.totalPages)
    } catch {}
  }

  async function handleDelete(id: number) {
    try {
      await deleteSignal(id)
      setSignals(prev => prev.filter(s => s.id !== id))
    } catch {}
  }

  async function handleScanTake(id: number, amount: number, modelType?: string, leverage?: number, orderType?: 'market' | 'limit') {
    try {
      await takeSignalAsTrade(id, amount, modelType, leverage, orderType || 'market')
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
    setProgress(null)

    // Подписка на live-прогресс через SSE
    const unsubscribe = subscribeScanProgress((p) => {
      setProgress(p)
    })

    try {
      const res = await triggerScan(undefined, minScore, useGPT)
      setScanResults(res)
      loadSignals()
    } catch (err: any) {
      setError(err.message || 'Scan failed')
    } finally {
      unsubscribe()
      setLoading(false)
      setProgress(null)
    }
  }

  // Entry analyzer
  async function handleEntryAnalyze() {
    if (entryCoins.length === 0) return
    setEntryLoading(true)
    setError('')
    setEntryResults(null)
    setTab('entry')

    let msgIdx = 0
    setLoadingMsg(ENTRY_MESSAGES[0])
    const interval = setInterval(() => {
      msgIdx = (msgIdx + 1) % ENTRY_MESSAGES.length
      setLoadingMsg(ENTRY_MESSAGES[msgIdx])
    }, 2500)

    try {
      const res = await analyzeEntry(entryCoins, entryUseGPT)
      setEntryResults(res)
      loadSavedEntries()
    } catch (err: any) {
      setError(err.message || 'Entry analysis failed')
    } finally {
      clearInterval(interval)
      setEntryLoading(false)
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
            Анализ входа {entryResults ? `(${entryResults.total})` : ''}
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
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {['', 'NEW'].map(s => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setPage(1); setShowAll(false) }}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${statusFilter === s ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {s || 'Все'}
                </button>
              ))}
            </div>

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

              <button onClick={exportTakenCSV} disabled={csvExporting}
                className="px-2.5 py-1 bg-card text-text-secondary rounded-lg text-xs font-medium hover:text-text-primary hover:bg-input transition disabled:opacity-50 flex items-center gap-1.5 ml-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {csvExporting ? '...' : 'CSV взятых'}
              </button>

              <div className="flex items-center gap-2">
                {confirmDeleteUnused ? (
                  <>
                    <span className="text-xs text-text-secondary">Удалить невзятые?</span>
                    <button disabled={bulkLoading} onClick={async () => { setBulkLoading(true); try { await deleteUnusedSignals(); loadSignals() } catch {} finally { setBulkLoading(false); setConfirmDeleteUnused(false) } }}
                      className="px-2 py-0.5 bg-accent text-black rounded text-xs font-medium disabled:opacity-50">{bulkLoading ? '...' : 'Да'}</button>
                    <button onClick={() => setConfirmDeleteUnused(false)} className="px-2 py-0.5 bg-input text-text-secondary rounded text-xs">Нет</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeleteUnused(true)}
                    className="px-2.5 py-1 bg-accent/10 text-accent rounded-lg text-xs font-medium hover:bg-accent/20 transition">
                    Удалить невзятые
                  </button>
                )}
                {confirmDeleteAll ? (
                  <>
                    <span className="text-xs text-short">Удалить ВСЕ?</span>
                    <button disabled={bulkLoading} onClick={async () => { setBulkLoading(true); try { await deleteAllSignals(); loadSignals() } catch {} finally { setBulkLoading(false); setConfirmDeleteAll(false) } }}
                      className="px-2 py-0.5 bg-short text-white rounded text-xs font-medium disabled:opacity-50">{bulkLoading ? '...' : 'Да'}</button>
                    <button onClick={() => setConfirmDeleteAll(false)} className="px-2 py-0.5 bg-input text-text-secondary rounded text-xs">Нет</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeleteAll(true)}
                    className="px-2.5 py-1 bg-short/10 text-short rounded-lg text-xs font-medium hover:bg-short/20 transition">
                    Очистить всё
                  </button>
                )}
              </div>
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
                  <UnifiedSignalCard key={s.id} mode="saved" signal={s} onStatusChange={loadSignals} onDelete={handleDelete} balance={balance} riskPct={riskPct} onShowChart={setChartSignal} />
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
              <div className="ml-auto flex gap-2 text-xs flex-wrap">
                {scanResults.funnel?.bySetupCategory && Object.entries(scanResults.funnel.bySetupCategory).filter(([, v]) => v > 0).map(([cat, count]) => {
                  const style = SETUP_CATEGORY_STYLES[cat]
                  return <span key={cat} className={style?.text || 'text-neutral'}>{count} {style?.label || cat}</span>
                })}
                {scanResults.funnel?.byExecutionType && Object.entries(scanResults.funnel.byExecutionType).filter(([, v]) => v > 0).map(([et, count]) => {
                  const style = EXECUTION_TYPE_STYLES[et]
                  return <span key={et} className={`${style?.text || 'text-neutral'} opacity-70`}>{count} {style?.label || et}</span>
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
                <UnifiedSignalCard key={i} mode="scan" signal={s} onTake={handleScanTake} onSkip={handleScanSkip} onDelete={handleScanDelete} balance={balance} riskPct={riskPct} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Entry Analyzer tab */}
      {tab === 'entry' && !loading && !entryLoading && (
        <>
          <div className="bg-card rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <CoinSearchSelector
                selected={entryCoins}
                onChange={setEntryCoins}
                max={5}
              />
              <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={entryUseGPT}
                  onChange={e => setEntryUseGPT(e.target.checked)}
                  className="accent-accent"
                />
                GPT-5.4 анализ
              </label>
              <button
                onClick={handleEntryAnalyze}
                disabled={entryLoading || entryCoins.length === 0}
                className="px-4 py-2 rounded-lg font-medium text-sm disabled:opacity-50 transition-colors bg-accent text-[#0b0e11] hover:bg-accent/90"
              >
                Анализировать входы
              </button>
            </div>
            {entryCoins.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {entryCoins.map(c => (
                  <span key={c} className="px-2 py-0.5 rounded bg-accent/15 text-accent text-xs font-medium flex items-center gap-1">
                    {c}
                    <button onClick={() => setEntryCoins(prev => prev.filter(x => x !== c))} className="hover:text-short">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {entryResults && (
            <>
              {entryResults.errors.length > 0 && (
                <div className="text-xs text-short">Ошибки: {entryResults.errors.join(', ')}</div>
              )}
              {entryResults.results.length === 0 ? (
                <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
                  Не удалось найти оптимальные точки входа для выбранных монет.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {entryResults.results.map((r, i) => (
                    <EntryResultCard key={i} result={r} balance={balance} riskPct={riskPct} />
                  ))}
                </div>
              )}
            </>
          )}

          {!entryResults && savedEntries.length === 0 && (
            <div className="bg-card rounded-xl p-8 text-center text-text-secondary">
              Выберите монеты и нажмите «Анализировать входы» для поиска оптимальных лимитных ордеров.
            </div>
          )}

          {savedEntries.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-text-secondary">Сохранённые анализы ({savedEntries.length})</h3>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {savedEntries.map(s => {
                  const mc = s.marketContext as any
                  if (!mc?.entry1 || !mc?.entry2) return null
                  const mapped: EntryAnalysisSignal = {
                    coin: s.coin,
                    type: s.type,
                    strategy: s.strategy,
                    score: s.score,
                    currentPrice: mc.currentPrice || s.entry,
                    entry1: mc.entry1,
                    entry2: mc.entry2,
                    avgEntry: mc.avgEntry || s.entry,
                    stopLoss: s.stopLoss,
                    slPercent: mc.slPercent || 0,
                    takeProfits: s.takeProfits as any[],
                    leverage: s.leverage,
                    positionPct: s.positionPct,
                    riskReward: mc.riskReward || 0,
                    reasons: mc.reasons || [],
                    regime: mc.regime || { regime: '', confidence: 0, btcTrend: '', fearGreedZone: '', volatility: '' },
                    gpt: mc.gpt || null,
                    funding: mc.funding || null,
                    oi: mc.oi || null,
                  }
                  return (
                    <EntryResultCard
                      key={s.id}
                      result={mapped}
                      balance={balance}
                      riskPct={riskPct}
                      savedId={s.id}
                      savedStatus={s.status}
                      savedDate={s.createdAt}
                      onDelete={async (id) => {
                        try {
                          await deleteEntrySignal(id)
                          setSavedEntries(prev => prev.filter(x => x.id !== id))
                        } catch {}
                      }}
                      onTaken={loadSavedEntries}
                    />
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Risk Calculator tab */}
      {tab === 'calc' && (
        <div className="max-w-lg space-y-4">
          <p className="text-text-secondary text-sm">
            Депо: <span className="text-text-primary font-mono">${balance || '—'}</span> | Риск: <span className="text-text-primary font-mono">{riskPct}%</span> = <span className="text-accent font-mono">${balance && riskPct ? Math.floor(balance * riskPct / 100) : '—'}</span>
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-text-secondary block mb-1">Вход 1</label>
              <input
                type="number"
                value={calcEntry}
                onChange={e => setCalcEntry(e.target.value)}
                placeholder="0.00"
                className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Stop Loss</label>
              <input
                type="number"
                value={calcSL}
                onChange={e => setCalcSL(e.target.value)}
                placeholder="0.00"
                className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">Leverage</label>
              <input
                type="number"
                value={calcLeverage}
                onChange={e => setCalcLeverage(e.target.value)}
                placeholder="10"
                min={1}
                className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <button
            onClick={() => { setCalcShowEntry2(!calcShowEntry2); if (calcShowEntry2) setCalcEntry2('') }}
            className={`text-xs px-3 py-1 rounded transition-colors ${calcShowEntry2 ? 'bg-accent/20 text-accent' : 'bg-input text-text-secondary hover:text-text-primary'}`}
          >
            {calcShowEntry2 ? '— Убрать докупку' : '+ Докупка (вход 2)'}
          </button>

          {calcShowEntry2 && (
            <div className="max-w-[calc(33.333%-0.5rem)]">
              <label className="text-xs text-text-secondary block mb-1">Вход 2 (докупка)</label>
              <input
                type="number"
                value={calcEntry2}
                onChange={e => setCalcEntry2(e.target.value)}
                placeholder="0.00"
                className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          )}

          {(() => {
            const entry = Number(calcEntry)
            const sl = Number(calcSL)
            const lev = Number(calcLeverage)
            if (!entry || !sl || !lev || !balance || !riskPct) return null

            const slPct = Math.abs((entry - sl) / entry) * 100
            const riskAmount = balance * riskPct / 100
            const margin = Math.floor(riskAmount / (slPct / 100 * lev))
            const direction = sl < entry ? 'LONG' : 'SHORT'

            const entry2 = Number(calcEntry2)
            const hasEntry2 = calcShowEntry2 && entry2 > 0

            let margin1 = margin
            let margin2 = 0
            if (hasEntry2) {
              margin1 = Math.floor(margin / 2)
              margin2 = margin - margin1
            }

            return (
              <div className="bg-card rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction === 'LONG' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
                    {direction}
                  </span>
                  <span className="text-text-secondary text-xs">SL: {slPct.toFixed(2)}%</span>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="text-text-secondary">Риск (потеря при SL)</div>
                  <div className="font-mono text-short">${riskAmount.toFixed(2)}</div>

                  <div className="text-text-secondary">Маржа на вход</div>
                  <div className="font-mono text-accent text-lg">${margin}</div>

                  <div className="text-text-secondary">Размер позиции</div>
                  <div className="font-mono text-text-primary">${margin * lev}</div>
                </div>

                {hasEntry2 && (
                  <>
                    <div className="border-t border-input pt-3 mt-2">
                      <p className="text-xs text-text-secondary mb-2">Разделение маржи (50/50):</p>
                      <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                        <div className="text-text-secondary"></div>
                        <div className="text-text-secondary text-xs">Маржа</div>
                        <div className="text-text-secondary text-xs">Позиция</div>

                        <div className="text-text-secondary">Вход 1 — ${entry}</div>
                        <div className="font-mono text-accent">${margin1}</div>
                        <div className="font-mono text-text-primary">${margin1 * lev}</div>

                        <div className="text-text-secondary">Вход 2 — ${entry2}</div>
                        <div className="font-mono text-accent">${margin2}</div>
                        <div className="font-mono text-text-primary">${margin2 * lev}</div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })()}
        </div>
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
