import { useState, useEffect } from 'react'
import { getPostTp1Analytics, getSetupPerformance, getEntryModelComparison } from '../../api/scanner'

const SCORE_OPTIONS = [0, 60, 70, 80]

export default function ScannerAnalyticsTab() {
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsDays, setAnalyticsDays] = useState(30)
  const [minScore, setMinScore] = useState(70)

  async function loadAnalytics(days?: number, score?: number) {
    setAnalyticsLoading(true)
    try {
      const d = days ?? analyticsDays
      const s = score ?? minScore
      const [postTp1, setupPerf, entryModels] = await Promise.all([
        getPostTp1Analytics(d, s),
        getSetupPerformance(d, s),
        getEntryModelComparison(d, s),
      ])
      setAnalyticsData({ postTp1, setupPerf, entryModels })
    } catch (err) { console.error('[Scanner] Failed to load analytics:', err) } finally {
      setAnalyticsLoading(false)
    }
  }

  useEffect(() => {
    loadAnalytics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-sm text-text-secondary">Период:</span>
        {[7, 14, 30, 90].map(d => (
          <button key={d} onClick={() => { setAnalyticsDays(d); loadAnalytics(d, minScore) }}
            className={`px-3 py-1 text-xs rounded ${analyticsDays === d ? 'bg-accent/15 text-accent' : 'bg-card text-text-secondary hover:text-text-primary'}`}>
            {d}д
          </button>
        ))}
        <span className="text-sm text-text-secondary ml-2 pl-2 border-l border-input">Score≥</span>
        {SCORE_OPTIONS.map(s => (
          <button key={s} onClick={() => { setMinScore(s); loadAnalytics(analyticsDays, s) }}
            className={`px-3 py-1 text-xs rounded ${minScore === s ? 'bg-accent/15 text-accent' : 'bg-card text-text-secondary hover:text-text-primary'}`}
            title={s === 0 ? 'Без фильтра по Score' : `Только сделки с Setup Score ≥ ${s}`}
          >
            {s === 0 ? 'все' : s}
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
  )
}
