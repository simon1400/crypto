import { useState } from 'react'
import { CandidateInfo } from '../../api/client'
import { fmtPrice, fmt2Signed, formatDate } from '../../lib/formatters'
import AiAnalysisBlock from './AiAnalysisBlock'
import { CardData, EntryModelData } from './types'

function CandidateRow({ candidate, role }: { candidate: CandidateInfo; role: 'preferred' | 'secondary' | 'deep' }) {
  const styles = {
    preferred: {
      border: 'border-accent/40',
      bg: 'bg-accent/10',
      label: 'Preferred',
      labelColor: 'text-accent',
      textColor: 'text-text-primary',
    },
    secondary: {
      border: 'border-text-secondary/20',
      bg: 'bg-card',
      label: 'Secondary',
      labelColor: 'text-text-secondary',
      textColor: 'text-text-secondary',
    },
    deep: {
      border: 'border-short/30',
      bg: 'bg-short/5',
      label: 'Deep',
      labelColor: 'text-short',
      textColor: 'text-text-secondary',
    },
  }
  const s = styles[role]
  const score = candidate.candidate_score

  const fillColors: Record<string, string> = {
    likely: 'text-long',
    possible: 'text-accent',
    unlikely: 'text-short',
  }
  const fillLabels: Record<string, string> = {
    likely: 'Likely',
    possible: 'Possible',
    unlikely: 'Unlikely',
  }

  return (
    <div className={`${s.bg} border ${s.border} rounded-lg px-3 py-2 text-xs`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`${s.labelColor} font-bold`}>{s.label}</span>
          <span className={`${s.textColor} font-mono`}>${fmtPrice(candidate.price)}</span>
          <span className="text-text-secondary">({candidate.source.replace(/_/g, ' ')})</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`font-mono ${fillColors[candidate.fill_category] || 'text-neutral'}`}>
            {fillLabels[candidate.fill_category] || candidate.fill_category}
          </span>
          <span className="text-text-secondary font-mono">{candidate.distance_atr} ATR</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-text-secondary">
        <span>Score: <span className="text-text-primary font-mono">{score.final_score.toFixed(1)}</span></span>
        <span>Str: <span className="font-mono">{score.structural_strength.toFixed(0)}</span></span>
        <span>Geo: <span className="font-mono">{score.geometry_bonus.toFixed(0)}</span></span>
        <span>Fill: <span className="font-mono">{score.fill_realism.toFixed(0)}</span></span>
        <span>Int: <span className="font-mono">{score.setup_integrity.toFixed(0)}</span></span>
        {candidate.rr_improvement > 0 && (
          <span className="text-long">R:R +{candidate.rr_improvement.toFixed(1)}</span>
        )}
      </div>
      {role === 'deep' && (
        <div className="text-short mt-1 text-[10px]">Aggressive — далеко от текущей цены</div>
      )}
      {candidate.confluence_count > 1 && (
        <div className="text-accent/70 mt-0.5 text-[10px]">
          Confluence: {candidate.sources_in_cluster.join(' + ')}
        </div>
      )}
    </div>
  )
}

interface SignalCardContextProps {
  data: CardData
  active: EntryModelData | undefined
  expanded: boolean
  onToggleExpanded: () => void
}

export default function SignalCardContext({ data, active, expanded, onToggleExpanded }: SignalCardContextProps) {
  return (
    <>
      {/* === Trigger state (scan) === */}
      {data.triggerState && (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-blue-400 font-bold mb-1">Trigger:</div>
          <div className="text-text-primary">
            {data.triggerState.triggerType.replace(/_/g, ' ')} ${fmtPrice(data.triggerState.triggerLevel)} на {data.triggerState.triggerTf}
          </div>
          <div className="text-short/80 mt-1">Отмена: {data.triggerState.invalidIf}</div>
        </div>
      )}

      {/* === Entry candidates (preferred / secondary / deep) === */}
      {data.candidates ? (
        <div className="mb-3 space-y-1.5">
          <CandidateRow candidate={data.candidates.preferred} role="preferred" />
          {data.candidates.secondary && (
            <CandidateRow candidate={data.candidates.secondary} role="secondary" />
          )}
          {data.candidates.deep && (
            <CandidateRow candidate={data.candidates.deep} role="deep" />
          )}
        </div>
      ) : data.limitEntryPlan ? (
        <div className="bg-accent/5 border border-accent/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-accent font-bold mb-1">Лимитный вход: {data.limitEntryPlan.zone_source.replace(/_/g, ' ')}</div>
          <div className="text-text-primary">
            Зона: ${fmtPrice(data.limitEntryPlan.entry_zone_low)} – ${fmtPrice(data.limitEntryPlan.entry_zone_high)}
          </div>
          <div className="text-text-secondary mt-0.5">{data.limitEntryPlan.explanation}</div>
        </div>
      ) : null}

      {/* === Market entry plan === */}
      {data.marketEntryPlan && (
        <div className="bg-long/5 border border-long/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-long font-bold mb-1">Рыночный вход</div>
          <div className="text-text-primary">
            Макс. цена: ${fmtPrice(data.marketEntryPlan.max_chase_price)}
          </div>
          <div className="text-text-secondary mt-0.5">{data.marketEntryPlan.explanation}</div>
        </div>
      )}

      {/* === Info row === */}
      <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
        <span className="text-text-secondary">Leverage: <span className="text-text-primary font-mono">{active?.leverage ?? data.leverage}x</span></span>
        {(active?.positionPct || data.positionPct > 0) && (
          <span className="text-text-secondary">Позиция: <span className="text-text-primary font-mono">{active?.positionPct ?? data.positionPct}%</span></span>
        )}
        {(active?.riskReward || data.riskReward > 0) && (
          <span className="text-text-secondary">R:R: <span className="text-text-primary font-mono">1:{active?.riskReward ?? data.riskReward}</span></span>
        )}
        {data.amount > 0 && (
          <span className="text-text-secondary">Размер: <span className="text-text-primary font-mono">${data.amount}</span></span>
        )}
        {data.closedPct > 0 && (
          <span className="text-text-secondary">Закрыто: <span className="text-text-primary font-mono">{data.closedPct}%</span></span>
        )}
        {data.regime && (
          <span className="text-text-secondary">Режим: <span className="text-text-primary">{data.regime}</span></span>
        )}
      </div>

      {/* === Market context badges (funding / OI / liq / L:S) === */}
      {(() => {
        const { funding, oi, liquidations: liq, lsr } = data
        if (!funding && !oi && !liq && !lsr) return null
        const fundingPct = funding?.fundingRate ? funding.fundingRate * 100 : 0
        const fundingHot = Math.abs(fundingPct) > 0.05
        const longShare = lsr?.buyRatio ? lsr.buyRatio * 100 : null
        const lsrExtreme = longShare != null && (longShare > 70 || longShare < 30)
        const oiDelta = oi?.oiChangePct1h ?? 0
        const oiSig = Math.abs(oiDelta) > 1
        const liqUsd = liq?.totalUsd ?? 0
        const liqK = Math.round(liqUsd / 1000)
        if (!fundingPct && !oi && !liq && !lsr) return null

        return (
          <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
            {funding && (
              <span
                title={`Funding rate за 8h. ${fundingPct > 0 ? 'Лонги платят шортам' : 'Шорты платят лонгам'}`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  fundingHot
                    ? fundingPct > 0
                      ? 'bg-short/10 text-short border-short/30'
                      : 'bg-long/10 text-long border-long/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                Fund {fundingPct > 0 ? '+' : ''}{fundingPct.toFixed(3)}%
              </span>
            )}
            {oi && (
              <span
                title={`Open Interest 1h: ${oiDelta.toFixed(2)}%, 4h: ${(oi.oiChangePct4h ?? 0).toFixed(2)}%`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  oiSig
                    ? oiDelta > 0
                      ? 'bg-long/10 text-long border-long/30'
                      : 'bg-short/10 text-short border-short/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                OI {oiDelta > 0 ? '+' : ''}{oiDelta.toFixed(2)}%
              </span>
            )}
            {liq && liqUsd > 0 && (
              <span
                title={`Ликвидации за ${liq.windowMinutes}m: лонги $${(liq.longsLiqUsd / 1000).toFixed(0)}k, шорты $${(liq.shortsLiqUsd / 1000).toFixed(0)}k`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  liqUsd > 500_000
                    ? 'bg-accent/15 text-accent border-accent/40'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                🔥 ${liqK}k liq
                {liq.longsLiqUsd > liq.shortsLiqUsd ? ' L↓' : ' S↓'}
              </span>
            )}
            {lsr && longShare != null && (
              <span
                title={`Long/Short account ratio (1h)`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  lsrExtreme
                    ? longShare > 70
                      ? 'bg-long/10 text-long border-long/30'
                      : 'bg-short/10 text-short border-short/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                L:S {longShare.toFixed(0)}/{(100 - longShare).toFixed(0)}
              </span>
            )}
          </div>
        )
      })()}

      {/* === Reasons === */}
      {data.reasons.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-text-secondary mb-1">Причины:</div>
          <ul className="text-xs text-text-primary space-y-0.5">
            {data.reasons.map((r, i) => <li key={i}>• {r}</li>)}
          </ul>
        </div>
      )}

      {/* === Closes history (saved) === */}
      {data.closes.length > 0 && (
        <div className="mb-3 space-y-1">
          <div className="text-xs text-text-secondary mb-1">Закрытия:</div>
          {data.closes.map((c, i) => (
            <div key={i} className="flex items-center gap-3 text-xs bg-input rounded-lg px-3 py-1.5">
              <span className="font-mono text-text-primary">${fmtPrice(c.price)}</span>
              <span className="text-text-secondary">{c.percent}%</span>
              <span className={`font-mono font-bold ${c.pnl > 0 ? 'text-long' : c.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                {fmt2Signed(c.pnl)}$ ({fmt2Signed(c.pnlPercent)}%)
              </span>
              {c.isSL && <span className="text-short">SL</span>}
              <span className="text-text-secondary ml-auto">{formatDate(c.closedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {/* === AI Analysis (saved — expandable text) === */}
      {data.aiAnalysis && data.aiAnalysis !== 'GPT фільтр отключен\n\nРиски: \nУровні: ' && (
        <>
          <button onClick={onToggleExpanded} className="text-xs text-text-secondary hover:text-accent transition-colors mb-2">
            {expanded ? '▾ Скрыть GPT анализ' : '▸ GPT-5.4 анализ'}
          </button>
          {expanded && <AiAnalysisBlock text={data.aiAnalysis} />}
        </>
      )}

      {/* === AI Annotation (scan — structured) === */}
      {data.aiCommentary && (
        <div className="bg-input rounded-lg p-3 mb-3 text-sm text-text-secondary">
          <div className="text-xs text-accent mb-1 font-medium">AI Annotation{data.setupQuality ? ` [${data.setupQuality}]` : ''}:</div>
          <div>{data.aiCommentary}</div>
          {data.aiConflicts.length > 0 && (
            <div className="mt-1 text-xs text-orange-400">
              Конфликты: {data.aiConflicts.join(' · ')}
            </div>
          )}
          {data.aiRisks.length > 0 && (
            <div className="mt-1 text-xs text-short">
              Риски: {data.aiRisks.join(' · ')}
            </div>
          )}
          {data.waitForConfirmation && (
            <div className="mt-1 text-xs text-blue-400">
              ⏳ Ждать: {data.waitForConfirmation}
            </div>
          )}
        </div>
      )}
    </>
  )
}
