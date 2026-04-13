import { ScoreBreakdown, LegacyScoreBreakdown, EntryTriggerResult } from './types'

interface SignalCardScoresProps {
  scoreBreakdown: ScoreBreakdown | null
  legacyScoreBreakdown: LegacyScoreBreakdown | null
  entryTriggerResult: EntryTriggerResult | null
}

export default function SignalCardScores({ scoreBreakdown, legacyScoreBreakdown, entryTriggerResult }: SignalCardScoresProps) {
  return (
    <>
      {/* === Score breakdown === */}
      {scoreBreakdown ? (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {scoreBreakdown.trend}/25</span>
          <span>Loc: {scoreBreakdown.location}/25</span>
          <span>Mom: {scoreBreakdown.momentum}/20</span>
          <span>Deriv: {scoreBreakdown.derivatives}/15</span>
          <span>Geom: {scoreBreakdown.geometry}/15</span>
          {scoreBreakdown.penalties < 0 && (
            <span className="text-short">Pen: {scoreBreakdown.penalties}</span>
          )}
        </div>
      ) : legacyScoreBreakdown ? (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {legacyScoreBreakdown.trend}/15</span>
          <span>Mom: {legacyScoreBreakdown.momentum}/15</span>
          <span>Vol$: {legacyScoreBreakdown.volatility}/10</span>
          <span>MR: {legacyScoreBreakdown.meanRevStretch}/10</span>
          <span>Lvl: {legacyScoreBreakdown.levelInteraction}/15</span>
          <span>Vol: {legacyScoreBreakdown.volume}/15</span>
          <span>Mkt: {legacyScoreBreakdown.marketContext}/15</span>
        </div>
      ) : null}

      {/* === Entry trigger conditions === */}
      {entryTriggerResult && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className={entryTriggerResult.passed ? 'text-long' : 'text-short'}>
            Trigger: {entryTriggerResult.score}/4
          </span>
          <span className={entryTriggerResult.conditions?.pullback_zone ? 'text-long' : 'text-neutral'}>PB</span>
          <span className={entryTriggerResult.conditions?.candle_reclaim ? 'text-long' : 'text-neutral'}>Reclaim</span>
          <span className={entryTriggerResult.conditions?.reversal_volume ? 'text-long' : 'text-neutral'}>Vol</span>
          <span className={entryTriggerResult.conditions?.distance_from_trigger ? 'text-long' : 'text-neutral'}>Dist</span>
        </div>
      )}
    </>
  )
}
