import { useState, useEffect } from 'react'
import CoinSelector from '../components/CoinSelector'
import MarketBadge from '../components/MarketBadge'
import LoadingAnalysis from '../components/LoadingAnalysis'
import AnalysisResult from '../components/AnalysisResult'
import { runAnalysis, getMarketOverview, MarketOverview, AnalysisResponse } from '../api/client'

type State = 'idle' | 'loading' | 'result'

export default function Dashboard() {
  const [state, setState] = useState<State>('idle')
  const [coins, setCoins] = useState<string[]>(['BTC', 'ETH', 'SOL'])
  const [market, setMarket] = useState<MarketOverview | null>(null)
  const [marketLoading, setMarketLoading] = useState(true)
  const [result, setResult] = useState<AnalysisResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMarketOverview()
      .then(setMarket)
      .catch(() => {})
      .finally(() => setMarketLoading(false))
  }, [])

  const handleAnalyze = async () => {
    if (coins.length === 0) return
    setState('loading')
    setError(null)
    try {
      const data = await runAnalysis(coins)
      setResult(data)
      setState('result')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка анализа')
      setState('idle')
    }
  }

  const handleReset = () => {
    setState('idle')
    setResult(null)
    setError(null)
  }

  if (state === 'loading') {
    return <LoadingAnalysis />
  }

  if (state === 'result' && result) {
    return (
      <div className="space-y-6">
        <AnalysisResult data={result} />
        <div className="text-center">
          <button
            onClick={handleReset}
            className="px-6 py-3 bg-accent text-primary font-semibold rounded-lg hover:bg-accent/90 transition-colors"
          >
            Новый анализ
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Crypto Analysis</h1>
      <MarketBadge data={market} loading={marketLoading} />
      <CoinSelector selected={coins} onChange={setCoins} />

      {error && (
        <div className="bg-short/10 border border-short/30 rounded-lg px-4 py-3 text-short text-sm">
          {error}
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={coins.length === 0}
        className="px-8 py-3 bg-accent text-primary font-bold rounded-lg text-lg hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Анализировать
      </button>
    </div>
  )
}
