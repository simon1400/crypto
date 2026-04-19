import { useState, useEffect } from 'react'
import {
  analyzeEntry, getSavedEntrySignals, deleteEntrySignal,
  EntryAnalysisResponse, EntryAnalysisSignal,
} from '../../api/client'
import CoinSearchSelector from './CoinSearchSelector'
import EntryResultCard from './EntryResultCard'
import { ENTRY_MESSAGES } from './constants'

interface ScannerEntryTabProps {
  balance: number
  riskPct: number
  entryLoading: boolean
  loadingMsg: string
  onEntryLoadingChange: (loading: boolean) => void
  onLoadingMsgChange: (msg: string) => void
}

export default function ScannerEntryTab({
  balance,
  riskPct,
  entryLoading,
  loadingMsg,
  onEntryLoadingChange,
  onLoadingMsgChange,
}: ScannerEntryTabProps) {
  const [entryResults, setEntryResults] = useState<EntryAnalysisResponse | null>(null)
  const [entryCoins, setEntryCoins] = useState<string[]>([])
  const [savedEntries, setSavedEntries] = useState<any[]>([])

  useEffect(() => {
    loadSavedEntries()
  }, [])

  async function loadSavedEntries() {
    try {
      const data = await getSavedEntrySignals()
      setSavedEntries(data)
    } catch (err) { console.error('[Scanner] Failed to load saved entries:', err) }
  }

  async function handleEntryAnalyze() {
    if (entryCoins.length === 0) return
    onEntryLoadingChange(true)
    setEntryResults(null)

    let msgIdx = 0
    onLoadingMsgChange(ENTRY_MESSAGES[0])
    const interval = setInterval(() => {
      msgIdx = (msgIdx + 1) % ENTRY_MESSAGES.length
      onLoadingMsgChange(ENTRY_MESSAGES[msgIdx])
    }, 2500)

    try {
      const res = await analyzeEntry(entryCoins)
      setEntryResults(res)
      loadSavedEntries()
    } catch (err: any) {
      console.error('[Scanner] Entry analysis failed:', err)
    } finally {
      clearInterval(interval)
      onEntryLoadingChange(false)
    }
  }

  return (
    <>
      <div className="bg-card rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <CoinSearchSelector
            selected={entryCoins}
            onChange={setEntryCoins}
            max={5}
          />
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
                    } catch (err) { console.error('[Scanner] Failed to delete entry signal:', err) }
                  }}
                  onTaken={loadSavedEntries}
                />
              )
            })}
          </div>
        </>
      )}
    </>
  )
}
