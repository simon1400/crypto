import { useState } from 'react'
import { takeSignalAsTrade, takeSignal, skipSignal, ScannerSignal, ScanSignal, SignalClose } from '../../api/client'
import { QUALITY_COLORS } from '../../lib/constants'
import { formatDate, fmt2, fmt2Signed } from '../../lib/formatters'
import { ScoreBadge, StrategyBadge, ScannerStatusBadge as StatusBadge } from '../StatusBadge'
import AiAnalysisBlock from './AiAnalysisBlock'
import { MODEL_LABELS, SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES, CATEGORY_STYLES } from './constants'

interface EntryModelData {
  type: string
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  riskReward: number
  viable: boolean
}

interface ScoreBreakdown {
  trend: number
  location: number
  momentum: number
  derivatives: number
  geometry: number
  penalties: number
  total?: number
  penalties_applied?: string[]
}

interface LegacyScoreBreakdown {
  trend: number
  momentum: number
  volatility: number
  meanRevStretch: number
  levelInteraction: number
  volume: number
  marketContext: number
}

interface TriggerConditions {
  pullback_zone: boolean
  candle_reclaim: boolean
  reversal_volume: boolean
  distance_from_trigger: boolean
}

interface EntryTriggerResult {
  passed: boolean
  score: number
  conditions: TriggerConditions
}

// Normalized data shape used for rendering
interface CardData {
  // identity
  id: number | null
  coin: string
  type: string
  strategy: string
  status: string | null
  isLong: boolean

  // scores
  score: number
  setupScore: number | null
  setupCategory: string | null
  executionType: string | null
  setupQuality: string | null
  legacyCategory: string | null

  // levels
  entry: number
  stopLoss: number
  slPercent: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  riskReward: number

  // models
  entryModels: EntryModelData[]

  // breakdowns
  scoreBreakdown: ScoreBreakdown | null
  legacyScoreBreakdown: LegacyScoreBreakdown | null
  entryTriggerResult: EntryTriggerResult | null

  // market context
  regime: string | null
  funding: any
  oi: any
  liquidations: any
  lsr: any

  // plans
  triggerState: { triggerType: string; triggerLevel: number; triggerTf: string; invalidIf: string } | null
  limitEntryPlan: { entry_zone_low: number; entry_zone_high: number; zone_source: string; explanation: string } | null
  marketEntryPlan: { max_chase_price: number; explanation: string } | null

  // reasons & AI
  reasons: string[]
  aiAnalysis: string | null
  aiCommentary: string | null
  aiRisks: string[]
  aiConflicts: string[]
  waitForConfirmation: string | null

  // saved signal specifics
  amount: number
  closedPct: number
  realizedPnl: number
  closes: SignalClose[]
  createdAt: string | null
  takenAt: string | null

  // scan result specifics
  _taken: boolean
  _skipped: boolean
}

type CardMode = 'saved' | 'scan'

function normalizeFromSaved(s: ScannerSignal): CardData {
  const mc = (s.marketContext as any) || {}
  const models = (mc.entryModels as EntryModelData[] || []).filter(m => m.viable)

  return {
    id: s.id,
    coin: s.coin,
    type: s.type,
    strategy: s.strategy,
    status: s.status,
    isLong: s.type === 'LONG',
    score: s.score,
    setupScore: s.setupScore ?? mc.setup_score ?? null,
    setupCategory: s.setupCategory ?? mc.setup_category ?? null,
    executionType: s.executionType ?? mc.execution_type ?? null,
    setupQuality: null,
    legacyCategory: null,
    entry: s.entry,
    stopLoss: s.stopLoss,
    slPercent: models[0]?.slPercent || (Math.abs((s.stopLoss - s.entry) / s.entry) * 100),
    takeProfits: (s.takeProfits as { price: number; rr: number }[]) || [],
    leverage: s.leverage,
    positionPct: s.positionPct,
    riskReward: models[0]?.riskReward || 0,
    entryModels: models,
    scoreBreakdown: mc.setup_score_breakdown || null,
    legacyScoreBreakdown: null,
    entryTriggerResult: mc.entry_trigger_result || null,
    regime: typeof mc.regime === 'string' ? mc.regime : mc.regime?.regime || null,
    funding: mc.funding || null,
    oi: mc.oi || null,
    liquidations: mc.liquidations || null,
    lsr: mc.lsr || null,
    triggerState: null,
    limitEntryPlan: mc.limit_entry_plan || null,
    marketEntryPlan: mc.market_entry_plan || null,
    reasons: mc.reasons || [],
    aiAnalysis: s.aiAnalysis,
    aiCommentary: null,
    aiRisks: [],
    aiConflicts: [],
    waitForConfirmation: null,
    amount: s.amount,
    closedPct: s.closedPct,
    realizedPnl: s.realizedPnl,
    closes: (s.closes as SignalClose[]) || [],
    createdAt: s.createdAt,
    takenAt: s.takenAt,
    _taken: false,
    _skipped: false,
  }
}

function normalizeFromScan(s: ScanSignal): CardData {
  const models = (s.entryModels || []).filter(m => m.viable)

  return {
    id: s.savedId,
    coin: s.coin,
    type: s.type,
    strategy: s.strategy,
    status: null,
    isLong: s.type === 'LONG',
    score: s.score,
    setupScore: s.setup_score ?? null,
    setupCategory: s.setup_category ?? null,
    executionType: s.execution_type ?? null,
    setupQuality: s.setupQuality || null,
    legacyCategory: s.category || null,
    entry: s.entry,
    stopLoss: s.stopLoss,
    slPercent: s.slPercent,
    takeProfits: s.takeProfits || [],
    leverage: s.leverage,
    positionPct: s.positionPct,
    riskReward: s.riskReward,
    entryModels: models,
    scoreBreakdown: s.setup_score_breakdown || null,
    legacyScoreBreakdown: !s.setup_score_breakdown ? s.scoreBreakdown as unknown as LegacyScoreBreakdown : null,
    entryTriggerResult: s.entry_trigger_result || null,
    regime: null,
    funding: null,
    oi: null,
    liquidations: null,
    lsr: null,
    triggerState: s.triggerState || null,
    limitEntryPlan: s.limit_entry_plan || null,
    marketEntryPlan: s.market_entry_plan || null,
    reasons: s.reasons || [],
    aiAnalysis: null,
    aiCommentary: s.aiCommentary || null,
    aiRisks: s.aiRisks || [],
    aiConflicts: s.aiConflicts || [],
    waitForConfirmation: s.waitForConfirmation || null,
    amount: 0,
    closedPct: 0,
    realizedPnl: 0,
    closes: [],
    createdAt: null,
    takenAt: null,
    _taken: !!(s as any)._taken,
    _skipped: !!(s as any)._skipped,
  }
}

// === Saved signal props ===
interface SavedProps {
  mode: 'saved'
  signal: ScannerSignal
  onStatusChange: () => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
  onShowChart?: (signal: ScannerSignal) => void
}

// === Scan result props ===
interface ScanProps {
  mode: 'scan'
  signal: ScanSignal
  onTake: (id: number, amount: number, modelType?: string, leverage?: number, orderType?: 'market' | 'limit') => void
  onSkip: (id: number) => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
}

type Props = SavedProps | ScanProps

export default function UnifiedSignalCard(props: Props) {
  const { mode, balance, riskPct } = props
  const data = mode === 'saved'
    ? normalizeFromSaved((props as SavedProps).signal)
    : normalizeFromScan((props as ScanProps).signal)

  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [loading, setLoading] = useState(false)

  const models = data.entryModels
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || data.takeProfits

  const isRejected = mode === 'scan' && data.legacyCategory === 'REJECTED'

  function calcRiskAmount(lev?: number) {
    if (!balance || !riskPct) return ''
    const sl = active?.slPercent || data.slPercent
    const leverage = lev || active?.leverage || data.leverage
    if (!sl || !leverage) return ''
    return String(Math.floor((balance * riskPct / 100) / (sl / 100 * leverage)))
  }

  function openTakeForm() {
    setAmount(calcRiskAmount())
    setCustomLeverage('')
    setShowTakeForm(true)
  }

  async function handleTakeSaved() {
    if (!amount || mode !== 'saved') return
    setLoading(true)
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      await takeSignalAsTrade(data.id!, Number(amount), active?.type, lev, orderType)
      setShowTakeForm(false)
      ;(props as SavedProps).onStatusChange()
    } catch (err: any) {
      alert(err.message || 'Failed to take signal')
    } finally { setLoading(false) }
  }

  async function handleSkipSaved() {
    if (mode !== 'saved') return
    try {
      await skipSignal(data.id!)
      ;(props as SavedProps).onStatusChange()
    } catch {}
  }

  function handleTakeScan() {
    if (!amount || mode !== 'scan' || !data.id) return
    const lev = customLeverage ? Number(customLeverage) : undefined
    ;(props as ScanProps).onTake(data.id, Number(amount), active?.type, lev, orderType)
    setShowTakeForm(false)
  }

  return (
    <div className={`bg-card rounded-xl p-4 border ${isRejected ? 'border-short/20 opacity-60' : 'border-card hover:border-accent/30'} transition-colors`}>
      {/* === Header === */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-lg text-text-primary">{data.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${data.isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {data.type}
          </span>
          <StrategyBadge strategy={data.strategy} />
          {mode === 'saved' && data.status && <StatusBadge status={data.status} />}
          {/* Setup category badge */}
          {(() => {
            if (data.setupCategory) {
              const sc = SETUP_CATEGORY_STYLES[data.setupCategory] || SETUP_CATEGORY_STYLES.IGNORE
              return <span className={`px-2 py-0.5 rounded text-xs font-bold ${sc.bg} ${sc.text}`}>{sc.label}</span>
            }
            if (data.legacyCategory) {
              const cs = CATEGORY_STYLES[data.legacyCategory] || CATEGORY_STYLES.REJECTED
              return <span className={`px-2 py-0.5 rounded text-xs font-bold ${cs.bg} ${cs.text}`}>{cs.label}</span>
            }
            return null
          })()}
          {/* Execution type badge */}
          {data.executionType && (() => {
            const et = EXECUTION_TYPE_STYLES[data.executionType] || EXECUTION_TYPE_STYLES.IGNORE
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${et.bg} ${et.text}`}>{et.label}</span>
          })()}
          {/* Setup quality grade */}
          {data.setupQuality && (
            <span className={`font-mono font-bold text-sm ${QUALITY_COLORS[data.setupQuality] || 'text-neutral'}`}>
              {data.setupQuality}
            </span>
          )}
          {/* Chart icon (saved only) */}
          {mode === 'saved' && (props as SavedProps).onShowChart && (
            <button
              onClick={() => (props as SavedProps).onShowChart!((props as SavedProps).signal)}
              className="text-text-secondary hover:text-accent transition-colors ml-1"
              title="График позиции"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.realizedPnl !== 0 && (
            <span className={`font-mono font-bold text-sm ${data.realizedPnl > 0 ? 'text-long' : 'text-short'}`}>
              {fmt2Signed(data.realizedPnl)}$
            </span>
          )}
          <ScoreBadge score={data.setupScore ?? data.score} />
        </div>
      </div>

      {/* === Trigger state (scan) === */}
      {data.triggerState && (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-blue-400 font-bold mb-1">Trigger:</div>
          <div className="text-text-primary">
            {data.triggerState.triggerType.replace(/_/g, ' ')} ${data.triggerState.triggerLevel} на {data.triggerState.triggerTf}
          </div>
          <div className="text-short/80 mt-1">Отмена: {data.triggerState.invalidIf}</div>
        </div>
      )}

      {/* === Entry model selector === */}
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

      {/* === Key levels grid === */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход{active ? ` (${MODEL_LABELS[active.type] || active.type})` : ''}</div>
          <div className="font-mono font-bold text-accent">${active?.entry ?? data.entry}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Stop Loss{active ? ` (${active.slPercent}%)` : ''}</div>
          <div className="font-mono font-bold text-short">${active?.stopLoss ?? data.stopLoss}</div>
        </div>
        {tps.map((tp, i) => (
          <div key={i} className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
            <div className="font-mono font-bold text-long">${tp.price}</div>
          </div>
        ))}
      </div>

      {/* === Score breakdown === */}
      {data.scoreBreakdown ? (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {data.scoreBreakdown.trend}/25</span>
          <span>Loc: {data.scoreBreakdown.location}/25</span>
          <span>Mom: {data.scoreBreakdown.momentum}/20</span>
          <span>Deriv: {data.scoreBreakdown.derivatives}/15</span>
          <span>Geom: {data.scoreBreakdown.geometry}/15</span>
          {data.scoreBreakdown.penalties < 0 && (
            <span className="text-short">Pen: {data.scoreBreakdown.penalties}</span>
          )}
        </div>
      ) : data.legacyScoreBreakdown ? (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {data.legacyScoreBreakdown.trend}/15</span>
          <span>Mom: {data.legacyScoreBreakdown.momentum}/15</span>
          <span>Vol$: {data.legacyScoreBreakdown.volatility}/10</span>
          <span>MR: {data.legacyScoreBreakdown.meanRevStretch}/10</span>
          <span>Lvl: {data.legacyScoreBreakdown.levelInteraction}/15</span>
          <span>Vol: {data.legacyScoreBreakdown.volume}/15</span>
          <span>Mkt: {data.legacyScoreBreakdown.marketContext}/15</span>
        </div>
      ) : null}

      {/* === Entry trigger conditions === */}
      {data.entryTriggerResult && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className={data.entryTriggerResult.passed ? 'text-long' : 'text-short'}>
            Trigger: {data.entryTriggerResult.score}/4
          </span>
          <span className={data.entryTriggerResult.conditions?.pullback_zone ? 'text-long' : 'text-neutral'}>PB</span>
          <span className={data.entryTriggerResult.conditions?.candle_reclaim ? 'text-long' : 'text-neutral'}>Reclaim</span>
          <span className={data.entryTriggerResult.conditions?.reversal_volume ? 'text-long' : 'text-neutral'}>Vol</span>
          <span className={data.entryTriggerResult.conditions?.distance_from_trigger ? 'text-long' : 'text-neutral'}>Dist</span>
        </div>
      )}

      {/* === Limit entry plan === */}
      {data.limitEntryPlan && (
        <div className="bg-accent/5 border border-accent/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-accent font-bold mb-1">Лимитный вход: {data.limitEntryPlan.zone_source.replace(/_/g, ' ')}</div>
          <div className="text-text-primary">
            Зона: ${fmt2(data.limitEntryPlan.entry_zone_low)} – ${fmt2(data.limitEntryPlan.entry_zone_high)}
          </div>
          <div className="text-text-secondary mt-0.5">{data.limitEntryPlan.explanation}</div>
        </div>
      )}

      {/* === Market entry plan === */}
      {data.marketEntryPlan && (
        <div className="bg-long/5 border border-long/20 rounded-lg px-3 py-2 mb-3 text-xs">
          <div className="text-long font-bold mb-1">Рыночный вход</div>
          <div className="text-text-primary">
            Макс. цена: ${fmt2(data.marketEntryPlan.max_chase_price)}
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
              <span className="font-mono text-text-primary">${c.price}</span>
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
      {data.aiAnalysis && data.aiAnalysis !== 'GPT фільтр отключен\n\nРиски: \nУровни: ' && (
        <>
          <button onClick={() => setExpanded(!expanded)} className="text-xs text-text-secondary hover:text-accent transition-colors mb-2">
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

      {/* === Take Form === */}
      {showTakeForm && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-24">
              <div className="text-xs text-text-secondary mb-1">Leverage</div>
              <input
                type="number"
                value={customLeverage || (active?.leverage ?? data.leverage)}
                onChange={e => {
                  setCustomLeverage(e.target.value)
                  const calc = calcRiskAmount(Number(e.target.value) || undefined)
                  if (calc) setAmount(calc)
                }}
                min={1} max={125}
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          {/* Order type toggle */}
          {(
            <div>
              <div className="text-xs text-text-secondary mb-1">Тип входа</div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOrderType('market')}
                  className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'market' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
                  Market <span className="opacity-70">(taker)</span>
                </button>
                <button type="button" onClick={() => setOrderType('limit')}
                  className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'limit' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
                  Limit <span className="opacity-70">(maker)</span>
                </button>
              </div>
            </div>
          )}
          {amount && (() => {
            const lev = Number(customLeverage) || active?.leverage || data.leverage
            const sl = active?.slPercent || data.slPercent
            const position = Number(amount) * lev
            const riskUsd = Number(amount) * (sl / 100) * lev
            const feeRate = orderType === 'limit' ? 0.0002 : 0.00055
            const entryFee = position * feeRate
            return (
              <div className="text-xs text-text-secondary space-y-0.5">
                <div>Позиция: <span className="text-text-primary font-mono">${position}</span></div>
                <div>Риск: <span className="text-short font-mono">${fmt2(riskUsd)}</span>
                  {balance > 0 && <span className="ml-1">({(riskUsd / balance * 100).toFixed(2)}% депо)</span>}
                </div>
                <div>Entry fee: <span className="text-text-primary font-mono">${fmt2(entryFee)}</span> ({orderType})</div>
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button
              onClick={mode === 'saved' ? handleTakeSaved : handleTakeScan}
              disabled={loading || !amount}
              className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50"
            >
              {loading ? '...' : 'Подтвердить'}
            </button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* === Footer === */}
      <div className="flex items-center justify-between border-t border-card pt-2">
        <span className="text-xs text-text-secondary">
          {data.createdAt && formatDate(data.createdAt)}
          {data.takenAt && <span> · взят {formatDate(data.takenAt)}</span>}
        </span>

        <div className="flex gap-1">
          {/* Saved signal actions */}
          {mode === 'saved' && data.status === 'NEW' && !showTakeForm && (
            <>
              <button onClick={openTakeForm} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20" title="Создать сделку в системе">Взять</button>
              <button
                onClick={async () => { try { await takeSignal(data.id!, 0); (props as SavedProps).onStatusChange() } catch {} }}
                className="px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20"
                title="Пометить как взятый (торгую на бирже вручную)"
              >Отметить</button>
              <button onClick={handleSkipSaved} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20" title="Пропустить (EXPIRED)">Пропустить</button>
            </>
          )}

          {/* Scan result actions */}
          {mode === 'scan' && data.id && (
            <>
              {data._taken ? (
                <span className="text-xs text-long font-medium">Взят — сделка создана</span>
              ) : data._skipped ? (
                <span className="text-xs text-neutral font-medium">Пропущен</span>
              ) : !showTakeForm ? (
                <>
                  <button onClick={openTakeForm} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20">Взять</button>
                  <button onClick={() => (props as ScanProps).onSkip(data.id!)} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20">Пропустить</button>
                </>
              ) : null}
            </>
          )}

          {/* Delete button (both modes) */}
          <button
            onClick={() => props.onDelete(data.id!)}
            className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
            title="Удалить"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
