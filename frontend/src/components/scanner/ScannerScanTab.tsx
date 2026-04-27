import { ScanResponse, ScanSignal } from '../../api/scanner'
import UnifiedSignalCard from './UnifiedSignalCard'
import { SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES } from './constants'
import type { RealOrderModalState } from './types'

interface ScannerScanTabProps {
  scanResults: ScanResponse | null
  balance: number
  riskPct: number
  realBalance: number | null
  onTake: (id: number, amount: number, modelType?: string, leverage?: number, orderType?: 'market' | 'limit') => void
  onSkip: (id: number) => void
  onDelete: (id: number) => void
  onRealOrderSuccess?: (modal: RealOrderModalState) => void
}

export default function ScannerScanTab({ scanResults, balance, riskPct, realBalance, onTake, onSkip, onDelete, onRealOrderSuccess }: ScannerScanTabProps) {
  if (!scanResults) return null

  return (
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
          {scanResults.signals.map((s: ScanSignal, i: number) => (
            <UnifiedSignalCard key={i} mode="scan" signal={s} onTake={onTake} onSkip={onSkip} onDelete={onDelete} balance={balance} riskPct={riskPct} realBalance={realBalance} onRealOrderSuccess={onRealOrderSuccess} />
          ))}
        </div>
      )}
    </>
  )
}
