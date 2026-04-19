import { BASE, getHeaders } from './base'
import type { Trade } from './trades'

// ===================== Scanner (Auto-Signals) =====================

// Mirrors backend CoinIndicators (subset of fields used by frontend)
export interface ScannerCoinIndicators {
  price: number
  ema9: number
  ema20: number
  ema50: number
  ema200: number
  rsi: number
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  trendDetail: string
  marketStructure: string
  support: number
  resistance: number
  volRatio: number
  change24h: number
  macd: number
  macdSignal: number
  macdHistogram: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  stochK: number
  stochD: number
  adx: number
  plusDI: number
  minusDI: number
  fibLevels: { level: string; price: number }[]
  pivot: number
  pivotR1: number
  pivotR2: number
  pivotS1: number
  pivotS2: number
  patterns: string[]
  vwap: number
  atr: number
}

export interface ScannerIndicators {
  tf15m: ScannerCoinIndicators
  tf1h: ScannerCoinIndicators
  tf4h: ScannerCoinIndicators
}

export interface ScannerMarketContext {
  regime: string
  regimeConfidence: number
  btcTrend: string
  fearGreedZone: string
  volatility: string
  funding: Record<string, unknown> | null
  oi: Record<string, unknown> | null
  news: Record<string, unknown> | null
  liquidations: Record<string, unknown> | null
  lsr: Record<string, unknown> | null
  coinRegime: Record<string, unknown> | null
  setup_category: string
  execution_type: string
  setup_score: number
  setup_score_breakdown: Record<string, number>
  entry_trigger_result: Record<string, unknown>
  hard_filter_result: Record<string, unknown>
  signal_context: Record<string, unknown>
  signal_explanation: Record<string, unknown>
  limit_entry_plan: Record<string, unknown> | null
  market_entry_plan: Record<string, unknown> | null
  risk_profile: Record<string, unknown>
  // Entry analyzer variant
  source?: string
  [key: string]: unknown  // allow extra fields from different signal sources
}

export interface SignalClose {
  price: number
  percent: number
  pnl: number
  pnlPercent: number
  closedAt: string
  isSL?: boolean
}

export interface ScannerSignal {
  id: number
  coin: string
  type: string
  strategy: string
  score: number
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number; close_pct?: number }[]
  leverage: number
  positionPct: number
  amount: number
  indicators: ScannerIndicators
  marketContext: ScannerMarketContext
  closes: SignalClose[]
  closedPct: number
  realizedPnl: number
  status: string
  expiresAt: string
  createdAt: string
  takenAt: string | null
  closedAt: string | null
  // New 3-layer scoring fields
  initialStop: number | null
  currentStop: number | null
  setupScore: number | null
  setupCategory: string | null
  executionType: string | null
  entryModel: string | null
  exchange: string | null           // bybit | bingx | binance | mexc
  stopMovedToBe: boolean
  stopMoveReason: string | null
  trailingActivated: boolean
  exitReason: string | null
  tp1HitTimestamp: string | null
  tp2HitTimestamp: string | null
  tp3HitTimestamp: string | null
  timeInTradeMin: number | null
  mfe: number | null
  mae: number | null
  linkedTrade: {
    id: number
    status: string
    realizedPnl: number
    closedPct: number
    fees: number
    fundingPaid: number
  } | null
}

export interface CandidateScoreInfo {
  structural_strength: number
  geometry_bonus: number
  fill_realism: number
  setup_integrity: number
  final_score: number
}

export interface CandidateInfo {
  price: number
  zone_low: number
  zone_high: number
  source: string
  sources_in_cluster: string[]
  confluence_count: number
  distance_atr: number
  candidate_score: CandidateScoreInfo
  fill_category: 'likely' | 'possible' | 'unlikely'
  integrity_estimate: 'strong' | 'moderate' | 'weak'
  rr_improvement: number
}

export interface CandidateSetInfo {
  preferred: CandidateInfo
  secondary: CandidateInfo | null
  deep: CandidateInfo | null
}

export interface EntryModel {
  type: 'aggressive' | 'confirmation' | 'pullback'
  entry: number
  stopLoss: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  slPercent: number
  riskReward: number
  viable: boolean
}

export interface TriggerState {
  triggerType: string
  triggerLevel: number
  triggerTf: string
  invalidIf: string
}

export interface ScanSignal {
  savedId: number | null
  coin: string
  type: string
  strategy: string
  score: number
  category: string
  scoreBand: string    // STRONG | ACTIONABLE | CONDITIONAL | OBSERVATIONAL | LOW_QUALITY
  entryQuality: string // GOOD | FAIR | POOR | CHASING
  triggerState: TriggerState | null
  scoreBreakdown: { trend: number; momentum: number; volatility: number; meanRevStretch: number; levelInteraction: number; volume: number; marketContext: number; mtfMultiplier: number; patternBonus: number }
  entry: number
  stopLoss: number
  slPercent: number
  takeProfits: { price: number; rr: number; close_pct?: number }[]
  tp1Percent: number
  tp2Percent: number
  tp3Percent: number
  leverage: number
  positionPct: number
  riskReward: number
  bestEntryType: string
  entryModels: EntryModel[]
  reasons: string[]
  // === New 3-layer scoring ===
  setup_category?: string
  execution_type?: string
  setup_score?: number
  setup_score_breakdown?: {
    trend: number
    location: number
    momentum: number
    derivatives: number
    geometry: number
    penalties: number
    total: number
    penalties_applied: string[]
  }
  entry_trigger_result?: {
    passed: boolean
    score: number
    conditions: {
      pullback_zone: boolean
      candle_reclaim: boolean
      reversal_volume: boolean
      distance_from_trigger: boolean
    }
    details: string[]
  }
  hard_filter_result?: {
    passed: boolean
    failures: string[]
  }
  signal_context?: Record<string, any>
  limit_entry_plan?: {
    entry_zone_low: number
    entry_zone_high: number
    preferred_limit_price: number
    zone_source: string
    invalidation_price: number
    explanation: string
    candidates?: CandidateSetInfo
  } | null
  candidates?: CandidateSetInfo | null
  market_entry_plan?: {
    market_entry_price: number
    max_chase_price: number
    invalidation_price: number
    explanation: string
  } | null
  risk_profile?: {
    risk_pct: number
    max_sl_pct: number
    entry_model: string
    position_size_multiplier: number
  }
  exchange?: string               // bybit | bingx | binance | mexc
}

export interface ScanFunnel {
  coinsScanned: number
  fetchErrors: number
  strategyCandidates: number
  rejectedByVolume: number
  rejectedByHardFilter: number
  passedScoring: number
  rejectedByRR: number
  passedRisk: number
  byStrategy: Record<string, number>
  byCategory: Record<string, number>
  bySetupCategory: Record<string, number>
  byExecutionType: Record<string, number>
  final: number
}

export interface ScanResponse {
  total: number
  funnel: ScanFunnel
  regime: {
    regime: string
    confidence: number
    btcTrend: string
    fearGreedZone: string
    volatility: string
  } | null
  signals: ScanSignal[]
}

export async function triggerScan(coins?: string[], minScore?: number): Promise<ScanResponse> {
  const res = await fetch(`${BASE}/api/scanner/scan`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins, minScore }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Scan failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function cancelScan(): Promise<void> {
  await fetch(`${BASE}/api/scanner/cancel`, { method: 'POST', headers: getHeaders() })
}

// === Scanner progress (Server-Sent Events) ===
export type ScanPhase =
  | 'idle' | 'starting' | 'market_data' | 'fetching' | 'regime'
  | 'scoring' | 'risk_calc' | 'classifying' | 'saving' | 'done' | 'error'
  // risk_calc kept for backward compat with older backend

export interface ScanProgress {
  phase: ScanPhase
  message: string
  current: number
  total: number
  percent: number
  startedAt: number
  updatedAt: number
  candidates?: number
  passed?: number
  rejected?: number
  error?: string
}

/**
 * Подписаться на live-прогресс сканера через fetch+ReadableStream.
 * Используем fetch+ReadableStream чтобы отправлять X-Api-Secret header.
 * Возвращает функцию для отписки.
 */
export function subscribeScanProgress(onUpdate: (p: ScanProgress) => void): () => void {
  const controller = new AbortController()
  let cancelled = false

  async function connect() {
    while (!cancelled) {
      try {
        const res = await fetch(`${BASE}/api/scanner/progress-stream`, {
          headers: getHeaders(),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6)) as ScanProgress
                onUpdate(data)
              } catch {}
            }
          }
        }
      } catch (err: any) {
        if (cancelled || err.name === 'AbortError') return
        console.warn('[SSE] Connection lost, reconnecting in 3s...')
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  connect()

  return () => {
    cancelled = true
    controller.abort()
  }
}

export async function getScannerSignals(page = 1, status?: string, dateFrom?: string, dateTo?: string): Promise<{ data: ScannerSignal[]; total: number; page: number; totalPages: number }> {
  const q = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) q.set('status', status)
  if (dateFrom) q.set('dateFrom', dateFrom)
  if (dateTo) q.set('dateTo', dateTo)
  const res = await fetch(`${BASE}/api/scanner/signals?${q}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch scanner signals')
  return res.json()
}

export async function takeSignal(id: number, amount: number): Promise<ScannerSignal> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/take`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ amount }),
  })
  if (!res.ok) throw new Error('Failed to take signal')
  return res.json()
}

export async function takeSignalAsTrade(id: number, amount: number, modelType?: string, leverage?: number, orderType: 'market' | 'limit' = 'market'): Promise<{ trade: Trade; signal: { id: number; status: string } }> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/take-trade`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ amount, modelType, leverage, orderType }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface RealPlacedTp {
  price: string
  qty: string
  orderId: string | null
  percent: number
  error?: string
}

export interface RealOrderInfo {
  positionId: number
  symbol: string
  qty: string
  orderType: 'Market' | 'Limit'
  entryPrice: string | null
  stopLoss: string
  takeProfits: RealPlacedTp[]
}

export interface TakeRealResponse {
  trade: Trade | null
  signal: { id: number; status: string }
  real: RealOrderInfo | null
  realError: string | null
  demoSkippedReason?: string | null
}

export async function takeSignalAsRealTrade(
  id: number,
  amount: number,
  modelType?: string,
  leverage?: number,
  orderType: 'market' | 'limit' = 'market',
): Promise<TakeRealResponse> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/take-trade-real`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ amount, modelType, leverage, orderType }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function closeSignal(id: number, price: number, percent: number): Promise<ScannerSignal> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/close`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ price, percent }),
  })
  if (!res.ok) throw new Error('Failed to close signal')
  return res.json()
}

export async function slHitSignal(id: number): Promise<ScannerSignal> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/sl-hit`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to record SL hit')
  return res.json()
}

export async function skipSignal(id: number): Promise<ScannerSignal> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/status`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ status: 'EXPIRED' }),
  })
  if (!res.ok) throw new Error('Failed to skip signal')
  return res.json()
}

export async function deleteSignal(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete signal')
}

export async function deleteAllSignals(): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/api/scanner/signals/all`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete signals')
  return res.json()
}

export async function deleteUnusedSignals(): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/api/scanner/signals/unused`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete unused signals')
  return res.json()
}

// === Scanner Analytics ===
function analyticsQuery(days: number, minScore: number): string {
  const q = new URLSearchParams({ days: String(days), minScore: String(minScore) })
  return q.toString()
}

export async function getPostTp1Analytics(days = 30, minScore = 70): Promise<any> {
  const res = await fetch(`${BASE}/api/scanner/analytics/post-tp1?${analyticsQuery(days, minScore)}`, { headers: getHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function getSetupPerformance(days = 30, minScore = 70): Promise<any[]> {
  const res = await fetch(`${BASE}/api/scanner/analytics/setup-performance?${analyticsQuery(days, minScore)}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getEntryModelComparison(days = 30, minScore = 70): Promise<any[]> {
  const res = await fetch(`${BASE}/api/scanner/analytics/entry-models?${analyticsQuery(days, minScore)}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getScannerCoins(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/scanner/coins`, { headers: getHeaders() })
  if (!res.ok) return []
  const data = await res.json()
  return data.coins
}

export async function getScannerCoinList(): Promise<{ available: string[]; selected: string[]; bingxOnly?: string[] }> {
  const res = await fetch(`${BASE}/api/scanner/coin-list`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch coin list')
  return res.json()
}

export async function saveScannerCoinList(coins: string[]): Promise<{ saved: number }> {
  const res = await fetch(`${BASE}/api/scanner/coin-list`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ coins }),
  })
  if (!res.ok) throw new Error('Failed to save coin list')
  return res.json()
}

export async function getScannerStatus(): Promise<{ running: boolean }> {
  const res = await fetch(`${BASE}/api/scanner/status`, { headers: getHeaders() })
  if (!res.ok) return { running: false }
  return res.json()
}

// ===================== Entry Analyzer =====================

export interface EntryPointData {
  price: number
  positionPercent: number
  label: string
  sources: string[]
  totalWeight: number
  distancePercent: number
  fillProbability: number
}

export interface EntryAnalysisSignal {
  coin: string
  type: string
  strategy: string
  score: number
  currentPrice: number
  entry1: EntryPointData
  entry2: EntryPointData
  avgEntry: number
  stopLoss: number
  slPercent: number
  takeProfits: { price: number; rr: number }[]
  leverage: number
  positionPct: number
  riskReward: number
  reasons: string[]
  regime: { regime: string; confidence: number; btcTrend: string; fearGreedZone: string; volatility: string }
  funding: { rate: number } | null
  oi: { value: number } | null
}

export interface EntryAnalysisResponse {
  total: number
  errors: string[]
  results: EntryAnalysisSignal[]
}

export async function analyzeEntry(coins: string[]): Promise<EntryAnalysisResponse> {
  const res = await fetch(`${BASE}/api/scanner/analyze-entry`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Entry analysis failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function takeEntry(data: {
  coin: string
  type: string
  amount: number
  leverage: number
  entry1: number
  entry2: number
  stopLoss: number
  score?: number
  signalId?: number
  takeProfits: { price: number; percent: number }[]
  orderType?: 'market' | 'limit'
}): Promise<{ trade1: Trade; trade2: Trade; groupId: string }> {
  const res = await fetch(`${BASE}/api/scanner/take-entry`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to take entry' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getSavedEntrySignals(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/scanner/entry-signals`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function deleteEntrySignal(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/scanner/entry-signals/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete')
}

export async function mergeEntryTrades(trade1Id: number, trade2Id: number): Promise<Trade> {
  const res = await fetch(`${BASE}/api/scanner/merge-entry`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ trade1Id, trade2Id }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to merge trades' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
