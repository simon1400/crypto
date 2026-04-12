import { useState } from 'react'
import { ScanSignal } from '../../api/client'
import { QUALITY_COLORS } from '../../lib/constants'
import { fmt2 } from '../../lib/formatters'
import { ScoreBadge, StrategyBadge } from '../StatusBadge'
import { CATEGORY_STYLES, SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES, BAND_STYLES, ENTRY_Q_STYLES, MODEL_LABELS } from './constants'

function CategoryBadge({ category }: { category: string }) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.REJECTED
  return <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.bg} ${style.text}`}>{style.label}</span>
}

export default function ScanResultCard({ result, onTake, onSkip, onDelete, balance, riskPct }: {
  result: ScanSignal
  onTake: (id: number, amount: number, modelType?: string, leverage?: number) => void
  onSkip: (id: number) => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
}) {
  const [selectedModel, setSelectedModel] = useState(0)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [takeAmount, setTakeAmount] = useState('')
  const [takeLeverage, setTakeLeverage] = useState('')
  const isLong = result.type === 'LONG'
  const isRejected = result.category === 'REJECTED'
  const models = result.entryModels?.filter(m => m.viable) || []
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || result.takeProfits

  function calcRiskAmount(lev?: number) {
    if (!balance || !riskPct) return ''
    const sl = active?.slPercent || result.slPercent
    const leverage = lev || active?.leverage || result.leverage
    if (!sl || !leverage) return ''
    const amount = (balance * riskPct / 100) / (sl / 100 * leverage)
    return String(Math.floor(amount))
  }

  function openTakeForm() {
    const calc = calcRiskAmount()
    setTakeAmount(calc)
    setTakeLeverage('')
    setShowTakeForm(true)
  }

  return (
    <div className={`bg-card rounded-xl p-4 border ${isRejected ? 'border-short/20 opacity-60' : 'border-card hover:border-accent/30'} transition-colors`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-lg text-text-primary">{result.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {result.type}
          </span>
          <StrategyBadge strategy={result.strategy} />
          {/* Setup category badge (new pipeline) — fallback to legacy */}
          {(() => {
            if (result.setup_category) {
              const sc = SETUP_CATEGORY_STYLES[result.setup_category] || SETUP_CATEGORY_STYLES.IGNORE
              return <span className={`px-2 py-0.5 rounded text-xs font-bold ${sc.bg} ${sc.text}`}>{sc.label}</span>
            }
            const cs = CATEGORY_STYLES[result.category] || CATEGORY_STYLES.REJECTED
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${cs.bg} ${cs.text}`}>{cs.label}</span>
          })()}
          {/* Execution type badge */}
          {result.execution_type && (() => {
            const et = EXECUTION_TYPE_STYLES[result.execution_type] || EXECUTION_TYPE_STYLES.IGNORE
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${et.bg} ${et.text}`}>{et.label}</span>
          })()}
          <span className={`font-mono font-bold text-sm ${QUALITY_COLORS[result.setupQuality] || 'text-neutral'}`}>
            {result.setupQuality}
          </span>
        </div>
        <ScoreBadge score={result.setup_score ?? result.score} />
      </div>

      {/* Trigger state */}
      {result.triggerState && (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-blue-400 font-bold mb-1">Trigger:</div>
          <div className="text-text-primary">
            {result.triggerState.triggerType.replace(/_/g, ' ')} ${result.triggerState.triggerLevel} на {result.triggerState.triggerTf}
          </div>
          <div className="text-short/80 mt-1">Отмена: {result.triggerState.invalidIf}</div>
        </div>
      )}

      {/* Score breakdown — new 6-component when available, legacy fallback */}
      {result.setup_score_breakdown ? (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {result.setup_score_breakdown.trend}/25</span>
          <span>Loc: {result.setup_score_breakdown.location}/25</span>
          <span>Mom: {result.setup_score_breakdown.momentum}/20</span>
          <span>Deriv: {result.setup_score_breakdown.derivatives}/15</span>
          <span>Geom: {result.setup_score_breakdown.geometry}/15</span>
          {result.setup_score_breakdown.penalties < 0 && (
            <span className="text-short">Pen: {result.setup_score_breakdown.penalties}</span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {result.scoreBreakdown.trend}/15</span>
          <span>Mom: {result.scoreBreakdown.momentum}/15</span>
          <span>Vol$: {result.scoreBreakdown.volatility}/10</span>
          <span>MR: {result.scoreBreakdown.meanRevStretch}/10</span>
          <span>Lvl: {result.scoreBreakdown.levelInteraction}/15</span>
          <span>Vol: {result.scoreBreakdown.volume}/15</span>
          <span>Mkt: {result.scoreBreakdown.marketContext}/15</span>
        </div>
      )}

      {/* Entry trigger conditions */}
      {result.entry_trigger_result && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className={result.entry_trigger_result.passed ? 'text-long' : 'text-short'}>
            Trigger: {result.entry_trigger_result.score}/4
          </span>
          <span className={result.entry_trigger_result.conditions.pullback_zone ? 'text-long' : 'text-neutral'}>PB</span>
          <span className={result.entry_trigger_result.conditions.candle_reclaim ? 'text-long' : 'text-neutral'}>Reclaim</span>
          <span className={result.entry_trigger_result.conditions.reversal_volume ? 'text-long' : 'text-neutral'}>Vol</span>
          <span className={result.entry_trigger_result.conditions.distance_from_trigger ? 'text-long' : 'text-neutral'}>Dist</span>
        </div>
      )}

      {/* Limit entry plan */}
      {result.limit_entry_plan && (
        <div className="bg-accent/5 border border-accent/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-accent font-bold mb-1">Лимитный вход: {result.limit_entry_plan.zone_source.replace(/_/g, ' ')}</div>
          <div className="text-text-primary">
            Зона: ${fmt2(result.limit_entry_plan.entry_zone_low)} – ${fmt2(result.limit_entry_plan.entry_zone_high)}
          </div>
          <div className="text-text-secondary mt-0.5">{result.limit_entry_plan.explanation}</div>
        </div>
      )}

      {/* Market entry plan */}
      {result.market_entry_plan && (
        <div className="bg-long/5 border border-long/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-long font-bold mb-1">Рыночный вход</div>
          <div className="text-text-primary">
            Макс. цена: ${fmt2(result.market_entry_plan.max_chase_price)}
          </div>
          <div className="text-text-secondary mt-0.5">{result.market_entry_plan.explanation}</div>
        </div>
      )}

      {/* Entry model selector */}
      {models.length > 1 && (
        <div className="flex gap-1 mb-3">
          {models.map((model, idx) => (
            <button
              key={model.type}
              onClick={() => setSelectedModel(idx)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                selectedModel === idx
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-input text-text-secondary border border-transparent hover:text-text-primary'
              }`}
            >
              {MODEL_LABELS[model.type] || model.type}
              {idx === 0 && ' ★'}
            </button>
          ))}
        </div>
      )}

      {/* Levels grid */}
      {active && (
        <div className={`grid grid-cols-2 gap-2 mb-3`}>
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">Вход ({MODEL_LABELS[active.type] || active.type})</div>
            <div className="font-mono font-bold text-accent">${active.entry}</div>
          </div>
          <div className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">SL ({active.slPercent}%)</div>
            <div className="font-mono font-bold text-short">${active.stopLoss}</div>
          </div>
          {tps.map((tp, i) => (
            <div key={i} className="bg-input rounded-lg p-2">
              <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
              <div className="font-mono font-bold text-long">${tp.price}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mb-2 text-sm">
        {active && (
          <>
            <span className="text-text-secondary">Leverage: <span className="font-mono text-text-primary">{active.leverage}x</span></span>
            <span className="text-text-secondary">Позиция: <span className="font-mono text-text-primary">{active.positionPct}%</span></span>
            <span className="text-text-secondary">R:R: <span className="font-mono text-text-primary">1:{active.riskReward}</span></span>
          </>
        )}
      </div>

      {/* Reasons */}
      <div className="mb-2">
        <div className="text-xs text-text-secondary mb-1">Причины:</div>
        <ul className="text-xs text-text-primary space-y-0.5">
          {result.reasons.map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
      </div>

      {/* AI annotation */}
      {result.aiCommentary && (
        <div className="bg-input rounded-lg p-3 text-sm text-text-secondary">
          <div className="text-xs text-accent mb-1 font-medium">AI Annotation [{result.setupQuality}]:</div>
          <div>{result.aiCommentary}</div>
          {result.aiConflicts.length > 0 && (
            <div className="mt-1 text-xs text-orange-400">
              Конфликты: {result.aiConflicts.join(' · ')}
            </div>
          )}
          {result.aiRisks.length > 0 && (
            <div className="mt-1 text-xs text-short">
              Риски: {result.aiRisks.join(' · ')}
            </div>
          )}
          {result.waitForConfirmation && (
            <div className="mt-1 text-xs text-blue-400">
              ⏳ Ждать: {result.waitForConfirmation}
            </div>
          )}
        </div>
      )}

      {/* Take form */}
      {showTakeForm && result.savedId && (
        <div className="bg-input rounded-lg p-3 mt-3 space-y-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
              <input
                type="number"
                value={takeAmount}
                onChange={e => setTakeAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-24">
              <div className="text-xs text-text-secondary mb-1">Leverage</div>
              <input
                type="number"
                value={takeLeverage || (active?.leverage || result.leverage)}
                onChange={e => {
                  setTakeLeverage(e.target.value)
                  const calc = calcRiskAmount(Number(e.target.value) || undefined)
                  if (calc) setTakeAmount(calc)
                }}
                min={1} max={125}
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          {takeAmount && (() => {
            const lev = Number(takeLeverage) || active?.leverage || result.leverage
            const sl = active?.slPercent || result.slPercent
            const position = Number(takeAmount) * lev
            const riskUsd = Number(takeAmount) * (sl / 100) * lev
            return (
              <div className="text-xs text-text-secondary space-y-0.5">
                <div>Позиция: <span className="text-text-primary font-mono">${position}</span></div>
                <div>Риск: <span className="text-short font-mono">${fmt2(riskUsd)}</span>
                  {balance > 0 && <span className="ml-1">({(riskUsd / balance * 100).toFixed(2)}% депо)</span>}
                </div>
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!takeAmount) return
                const lev = takeLeverage ? Number(takeLeverage) : undefined
                onTake(result.savedId!, Number(takeAmount), active?.type, lev)
                setShowTakeForm(false)
              }}
              disabled={!takeAmount}
              className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50"
            >
              Подтвердить
            </button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {result.savedId && (
        <div className="flex items-center justify-end gap-1 border-t border-card pt-2 mt-3">
          {(result as any)._taken ? (
            <span className="text-xs text-long font-medium">Взят — сделка создана</span>
          ) : (result as any)._skipped ? (
            <span className="text-xs text-neutral font-medium">Пропущен</span>
          ) : !showTakeForm ? (
            <>
              <button
                onClick={openTakeForm}
                className="px-3 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20 transition-colors"
              >
                Взять
              </button>
              <button
                onClick={() => onSkip(result.savedId!)}
                className="px-3 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20 transition-colors"
              >
                Пропустить
              </button>
              <button
                onClick={() => onDelete(result.savedId!)}
                className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
                title="Удалить"
              >
                ✕
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
