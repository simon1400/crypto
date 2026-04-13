import { ScannerSignal, ScanSignal, SignalClose, CandidateSetInfo } from '../../api/client'

export interface EntryModelData {
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

export interface ScoreBreakdown {
  trend: number
  location: number
  momentum: number
  derivatives: number
  geometry: number
  penalties: number
  total?: number
  penalties_applied?: string[]
}

export interface LegacyScoreBreakdown {
  trend: number
  momentum: number
  volatility: number
  meanRevStretch: number
  levelInteraction: number
  volume: number
  marketContext: number
}

export interface TriggerConditions {
  pullback_zone: boolean
  candle_reclaim: boolean
  reversal_volume: boolean
  distance_from_trigger: boolean
}

export interface EntryTriggerResult {
  passed: boolean
  score: number
  conditions: TriggerConditions
}

// Normalized data shape used for rendering
export interface CardData {
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
  candidates: CandidateSetInfo | null

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

export type CardMode = 'saved' | 'scan'

export function normalizeFromSaved(s: ScannerSignal): CardData {
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
    candidates: mc.limit_entry_plan?.candidates || null,
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

export function normalizeFromScan(s: ScanSignal): CardData {
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
    candidates: s.candidates || s.limit_entry_plan?.candidates || null,
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
export interface SavedProps {
  mode: 'saved'
  signal: ScannerSignal
  onStatusChange: () => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
  onShowChart?: (signal: ScannerSignal) => void
}

// === Scan result props ===
export interface ScanProps {
  mode: 'scan'
  signal: ScanSignal
  onTake: (id: number, amount: number, modelType?: string, leverage?: number, orderType?: 'market' | 'limit') => void
  onSkip: (id: number) => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
}

export type Props = SavedProps | ScanProps
