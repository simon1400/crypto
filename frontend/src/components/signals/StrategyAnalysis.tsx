interface StrategyStats {
  avgWin: number
  avgLoss: number
  winrate: number
  tp2plus: number
  tp: number
  sl: number
  closedCount: number
  leverageStats: Record<string, { wins: number; losses: number }>
  directionStats: { longWins: number; longLosses: number; shortWins: number; shortLosses: number }
}

export default function StrategyAnalysis({ stats }: { stats: StrategyStats }) {
  const rr = stats.avgLoss !== 0 ? Math.abs(stats.avgWin / stats.avgLoss) : 0
  const tp2pct = stats.tp > 0 ? (stats.tp2plus / stats.tp) * 100 : 0

  // Leverage verdicts
  const levVerdicts: { lev: string; wr: number; total: number; verdict: string; color: string }[] = []
  for (const [lev, s] of Object.entries(stats.leverageStats).sort(([a], [b]) => a.localeCompare(b))) {
    const total = s.wins + s.losses
    const wr = total > 0 ? (s.wins / total) * 100 : 0
    let verdict = 'нормальные'
    let color = 'text-accent'
    if (wr >= 60) { verdict = 'лучшие'; color = 'text-long' }
    else if (wr < 55) { verdict = 'рискованные'; color = 'text-short' }
    levVerdicts.push({ lev, wr, total, verdict, color })
  }

  // Build recommendations
  const recs: string[] = []

  // Leverage advice
  const worstLev = levVerdicts.find(l => l.wr < 55 && l.total >= 3)
  const bestLev = levVerdicts.find(l => l.wr >= 60 && l.total >= 3)
  if (worstLev) recs.push(`Избегать сигналы ${worstLev.lev} — винрейт ${worstLev.wr.toFixed(0)}%, высокий риск ликвидации`)
  if (bestLev) recs.push(`Приоритет: сигналы ${bestLev.lev} — винрейт ${bestLev.wr.toFixed(0)}%`)

  // TP strategy
  if (tp2pct >= 50) {
    recs.push(`${tp2pct.toFixed(0)}% побед дошли до TP2+ — закрывать 50% на TP1, остальное держать до TP2-TP3`)
  } else {
    recs.push('Большинство побед на TP1 — закрывать 70-80% на TP1, остальное на TP2')
  }

  // Long vs Short advice
  const longTotal = stats.directionStats.longWins + stats.directionStats.longLosses
  const shortTotal = stats.directionStats.shortWins + stats.directionStats.shortLosses
  const longWr = longTotal > 0 ? (stats.directionStats.longWins / longTotal) * 100 : 0
  const shortWr = shortTotal > 0 ? (stats.directionStats.shortWins / shortTotal) * 100 : 0
  if (longTotal >= 5 && shortTotal >= 5) {
    if (Math.abs(longWr - shortWr) >= 15) {
      const better = longWr > shortWr ? 'LONG' : 'SHORT'
      const worse = longWr > shortWr ? 'SHORT' : 'LONG'
      const betterPct = Math.max(longWr, shortWr)
      const worsePct = Math.min(longWr, shortWr)
      recs.push(`Канал значительно лучше в ${better} (${betterPct.toFixed(0)}%) чем в ${worse} (${worsePct.toFixed(0)}%) — можно фильтровать`)
    } else {
      recs.push(`LONG (${longWr.toFixed(0)}%) и SHORT (${shortWr.toFixed(0)}%) примерно одинаковы — торговать оба направления`)
    }
  }

  // Position sizing
  recs.push('Фиксированный размер позиции на каждый сигнал — без исключений')

  // Risk/Reward
  const mathPositive = stats.winrate * stats.avgWin + (100 - stats.winrate) * stats.avgLoss
  if (mathPositive > 0) {
    recs.push('Математическое ожидание положительное — стратегия прибыльна на дистанции')
  }

  return (
    <div className="bg-card rounded-xl p-5 border border-accent/20">
      <h3 className="text-lg font-semibold mb-4">Стратегический анализ</h3>

      {/* R:R and Math */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="bg-input rounded-lg p-4">
          <div className="text-xs text-text-secondary mb-2">Математика Risk/Reward</div>
          <div className="text-sm text-text-primary">
            Средний выигрыш <span className="font-mono font-bold text-long">+{stats.avgWin.toFixed(2)}%</span> vs
            средний проигрыш <span className="font-mono font-bold text-short">{stats.avgLoss.toFixed(2)}%</span> —
            соотношение <span className="font-mono font-bold text-accent">~{rr.toFixed(2)}:1</span>
          </div>
          <div className="text-xs text-text-secondary mt-2">
            {rr >= 2 ? 'Отличная асимметрия. ' : rr >= 1.5 ? 'Хорошая асимметрия. ' : 'Слабая асимметрия. '}
            {stats.winrate >= 55
              ? `При ${stats.winrate.toFixed(0)}% win rate итоговая математика сильно положительная.`
              : `Win rate ${stats.winrate.toFixed(0)}% — на грани, требуется осторожность.`
            }
          </div>
        </div>

        <div className="bg-input rounded-lg p-4">
          <div className="text-xs text-text-secondary mb-2">Глубина побед</div>
          <div className="text-sm text-text-primary">
            <span className="font-mono font-bold text-accent">{stats.tp2plus}</span> из{' '}
            <span className="font-mono font-bold">{stats.tp}</span> победителей дошли до TP2+ ({tp2pct.toFixed(0)}%)
          </div>
          <div className="text-xs text-text-secondary mt-2">
            {tp2pct >= 50
              ? 'Хороший показатель — не стоит закрывать всё на TP1.'
              : 'Большинство побед на TP1 — лучше фиксировать основную часть сразу.'
            }
          </div>
        </div>
      </div>

      {/* Leverage table */}
      <div className="mb-5">
        <div className="text-xs text-text-secondary mb-2">Находка по плечам</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs border-b border-card">
                <th className="text-left py-2 px-3">Плечо</th>
                <th className="text-left py-2 px-3">Win rate</th>
                <th className="text-left py-2 px-3">Сделок</th>
                <th className="text-left py-2 px-3">Вывод</th>
              </tr>
            </thead>
            <tbody>
              {levVerdicts.map(l => (
                <tr key={l.lev} className="border-b border-card/30">
                  <td className="py-2 px-3 font-mono font-bold">{l.lev}</td>
                  <td className="py-2 px-3 font-mono">{l.wr.toFixed(0)}%</td>
                  <td className="py-2 px-3 font-mono text-text-secondary">{l.total}</td>
                  <td className={`py-2 px-3 font-semibold ${l.color}`}>{l.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recommendations */}
      <div>
        <div className="text-xs text-text-secondary mb-2">Практическая стратегия на основе данных</div>
        <ol className="space-y-1.5">
          {recs.map((r, i) => (
            <li key={i} className="text-sm text-text-primary flex gap-2">
              <span className="text-accent font-bold">{i + 1}.</span> {r}
            </li>
          ))}
        </ol>
        <div className="mt-3 text-xs text-text-secondary border-t border-card pt-3">
          Data-driven стратегия на основе {stats.closedCount} реальных сделок. Рекомендуется тестировать на небольших суммах.
        </div>
      </div>
    </div>
  )
}
