const BASE = import.meta.env.VITE_API_URL || ''

let authToken = localStorage.getItem('auth_token') || ''

export function setAuthToken(token: string) {
  authToken = token
}

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Secret': authToken,
  }
}

// Signals
export interface Signal {
  id: number
  channel: string
  messageId: number
  publishedAt: string
  type: 'LONG' | 'SHORT'
  coin: string
  leverage: number
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: number[]
  status: string
  entryFilledAt: string | null
  statusUpdatedAt: string | null
  priceHistory: { time: number; price: number }[]
  createdAt: string
}

export interface SignalsResponse {
  data: Signal[]
  channel: string
  imported?: number
  skipped?: number
}

export async function getSignals(channel = 'EveningTrader', days = 7): Promise<SignalsResponse> {
  const res = await fetch(`${BASE}/api/signals?channel=${channel}&days=${days}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch signals')
  return res.json()
}

export async function syncSignals(channel = 'EveningTrader', days = 7): Promise<SignalsResponse> {
  const res = await fetch(`${BASE}/api/signals/sync`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ channel, days }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function clearSignals(channel: string, days: number): Promise<{ deleted: number }> {
  const params = new URLSearchParams()
  if (channel) params.set('channel', channel)
  if (days > 0) params.set('days', String(days))
  const res = await fetch(`${BASE}/api/signals/clear?${params}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to clear signals')
  return res.json()
}

export async function getSignal(id: number): Promise<Signal> {
  const res = await fetch(`${BASE}/api/signals/${id}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch signal')
  return res.json()
}

// Trades
export interface TradeClose {
  price: number
  percent: number
  pnl: number
  pnlPercent: number
  closedAt: string
  isSL?: boolean
}

export interface TradeTP {
  price: number
  percent: number // % позиции для закрытия на этом уровне
}

export interface Trade {
  id: number
  coin: string
  type: 'LONG' | 'SHORT'
  leverage: number
  entryPrice: number
  amount: number
  stopLoss: number
  takeProfits: TradeTP[]
  closes: TradeClose[]
  closedPct: number
  realizedPnl: number
  fees: number
  fundingPaid: number
  entryOrderType: 'market' | 'limit'
  status: string
  source: string
  notes: string | null
  openedAt: string
  closedAt: string | null
  createdAt: string
  // Lifecycle tracking
  initialStop: number | null
  currentStop: number | null
  stopMovedToBe: boolean
  stopMoveReason: string | null
  trailingActivated: boolean
  trailingActivationTime: string | null
  tp1HitTimestamp: string | null
  tp2HitTimestamp: string | null
  tp3HitTimestamp: string | null
  exitReason: string | null
  timeInTradeMin: number | null
  mfe: number | null
  mae: number | null
}

export interface TradesResponse {
  data: Trade[]
  total: number
  page: number
  totalPages: number
}

export interface TradeStats {
  total: number
  open: number
  closed: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgWin: number
  avgLoss: number
  longStats: { count: number; pnl: number }
  shortStats: { count: number; pnl: number }
  byCoin: Record<string, { trades: number; pnl: number; wins: number }>
}

export async function searchSymbols(q = ''): Promise<string[]> {
  const res = await fetch(`${BASE}/api/trades/symbols?q=${encodeURIComponent(q)}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export interface TradeLive {
  id: number
  status: string
  currentPrice: number | null
  unrealizedPnl: number
  unrealizedPnlPct: number
}

export async function getTradeLivePrices(): Promise<TradeLive[]> {
  const res = await fetch(`${BASE}/api/trades/live`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getTrades(params: { status?: string; coin?: string; source?: string; page?: number } = {}): Promise<TradesResponse> {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.coin) q.set('coin', params.coin)
  if (params.source) q.set('source', params.source)
  if (params.page) q.set('page', String(params.page))
  const res = await fetch(`${BASE}/api/trades?${q}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch trades')
  return res.json()
}

export async function getTradeStats(): Promise<TradeStats> {
  const res = await fetch(`${BASE}/api/trades/stats`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch trade stats')
  return res.json()
}

export async function createTrade(data: {
  coin: string; type: string; leverage: number; entryPrice: number;
  amount: number; stopLoss: number; takeProfits: TradeTP[]; fees?: number; notes?: string; source?: string;
  orderType?: 'market' | 'limit'
}): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function closeTrade(id: number, price: number, percent: number): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades/${id}/close`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ price, percent }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function hitStopLoss(id: number): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades/${id}/sl-hit`, {
    method: 'POST', headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function updateTrade(id: number, data: {
  coin?: string; type?: string; leverage?: number; entryPrice?: number;
  amount?: number; stopLoss?: number; takeProfits?: TradeTP[]; fees?: number; notes?: string
}): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update trade')
  return res.json()
}

export async function deleteTrade(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/trades/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete trade')
}

export async function closeAllTrades(): Promise<{ closed: number }> {
  const res = await fetch(`${BASE}/api/trades/close-all`, {
    method: 'POST', headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function deleteAllTrades(): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/api/trades/all`, {
    method: 'DELETE', headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getSignalPrices(coins: string[]): Promise<Record<string, number | null>> {
  const res = await fetch(`${BASE}/api/signals/prices`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins }),
  })
  if (!res.ok) return {}
  const data = await res.json()
  return data.prices
}

// ===================== Scanner (Auto-Signals) =====================

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
  indicators: any
  marketContext: any
  aiAnalysis: string | null
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
  setupQuality: string
  aiCommentary: string
  aiRisks: string[]
  aiConflicts: string[]
  aiKeyLevels: string[]
  recommendedEntryType: string
  waitForConfirmation: string | null
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
  } | null
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

export async function triggerScan(coins?: string[], minScore?: number, useGPT?: boolean): Promise<ScanResponse> {
  const res = await fetch(`${BASE}/api/scanner/scan`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins, minScore, useGPT }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Scan failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// === Scanner progress (Server-Sent Events) ===
export type ScanPhase =
  | 'idle' | 'starting' | 'market_data' | 'fetching' | 'regime'
  | 'scoring' | 'risk_calc' | 'gpt' | 'saving' | 'done' | 'error'
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
 * Подписаться на live-прогресс сканера через SSE.
 * EventSource не поддерживает custom headers, поэтому передаём токен в query.
 * Возвращает функцию для отписки.
 */
export function subscribeScanProgress(onUpdate: (p: ScanProgress) => void): () => void {
  const url = `${BASE}/api/scanner/progress-stream?token=${encodeURIComponent(authToken)}`
  const es = new EventSource(url)
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as ScanProgress
      onUpdate(data)
    } catch {}
  }
  es.onerror = () => {
    // EventSource будет автоматически реконнектиться
  }
  return () => es.close()
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
export async function getPostTp1Analytics(days = 30): Promise<any> {
  const res = await fetch(`${BASE}/api/scanner/analytics/post-tp1?days=${days}`, { headers: getHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function getSetupPerformance(days = 30): Promise<any[]> {
  const res = await fetch(`${BASE}/api/scanner/analytics/setup-performance?days=${days}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getEntryModelComparison(days = 30): Promise<any[]> {
  const res = await fetch(`${BASE}/api/scanner/analytics/entry-models?days=${days}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getScannerCoins(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/scanner/coins`, { headers: getHeaders() })
  if (!res.ok) return []
  const data = await res.json()
  return data.coins
}

export async function getScannerCoinList(): Promise<{ available: string[]; selected: string[] }> {
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

export interface EntryGPT {
  setupQuality: string
  commentary: string
  entry1Quality: string
  entry1Comment: string
  entry2Quality: string
  entry2Comment: string
  risks: string[]
  suggestedEntry1: number | null
  suggestedEntry2: number | null
  suggestedSL: number | null
  keyLevels: string[]
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
  gpt: EntryGPT | null
  funding: { rate: number } | null
  oi: { value: number } | null
}

export interface EntryAnalysisResponse {
  total: number
  errors: string[]
  results: EntryAnalysisSignal[]
}

export async function analyzeEntry(coins: string[], useGPT = true): Promise<EntryAnalysisResponse> {
  const res = await fetch(`${BASE}/api/scanner/analyze-entry`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins, useGPT }),
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

// ===================== Settings =====================

export interface SettingsResponse {
  id: number
  bybitApiKey: string | null
  bybitApiSecret: string | null
  apiKeyMasked: string | null
  apiSecretMasked: string | null
  useTestnet: boolean
  tradingMode: string
  positionSizePct: number
  dailyLossLimitPct: number
  orderTtlMinutes: number
  near512Topics: string[]
  eveningTraderCategories: string[]
  telegramBotToken: string | null
  telegramChatId: string | null
  telegramEnabled: boolean
  hasKeys: boolean
  balance: number | null
  isConnected: boolean
  virtualBalance: number
  virtualBalanceStart: number
  virtualStartedAt: string
  takerFeeRate: number
  makerFeeRate: number
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch settings')
  return res.json()
}

export async function saveSettings(data: Partial<SettingsResponse>): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getBalance(): Promise<{ balance: number | null; error?: string }> {
  const res = await fetch(`${BASE}/api/settings/balance`, { headers: getHeaders() })
  if (!res.ok) return { balance: null, error: 'Failed to fetch balance' }
  return res.json()
}

export interface BudgetStatus {
  balance: number       // virtual balance
  used: number          // занятая маржа
  available: number     // balance - used
  start: number         // стартовый депозит
  pnl: number           // общий P&L относительно старта
  roiPct: number
}

export async function getBudget(): Promise<BudgetStatus> {
  const res = await fetch(`${BASE}/api/trades/budget`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch budget')
  return res.json()
}

export interface VirtualBalanceInfo {
  balance: number
  start: number
  startedAt: string
  pnl: number
  roiPct: number
}

export async function getVirtualBalance(): Promise<VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/virtual-balance`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch virtual balance')
  return res.json()
}

export async function setVirtualBalance(balance: number, resetStart = true): Promise<VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/virtual-balance`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ balance, resetStart }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function resetSimulation(balance: number): Promise<{ deletedTrades: number } & VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/reset-simulation`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ balance }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function testNotification(data?: { telegramBotToken?: string, telegramChatId?: string }): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${BASE}/api/settings/test-notification`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data || {}),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ===================== Ticker Mappings =====================

export interface TickerMapping {
  id: number
  fromTicker: string
  toSymbol: string
  priceMultiplier: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export async function getTickerMappings(): Promise<TickerMapping[]> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch ticker mappings')
  return res.json()
}

export async function createTickerMapping(data: { fromTicker: string, toSymbol: string, priceMultiplier: number, notes?: string }): Promise<TickerMapping> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function updateTickerMapping(id: number, data: Partial<{ fromTicker: string, toSymbol: string, priceMultiplier: number, notes: string }>): Promise<TickerMapping> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function deleteTickerMapping(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete ticker mapping')
}

export async function executeSignal(signalId: number): Promise<{ success: boolean; positionId?: number; error?: string }> {
  const res = await fetch(`${BASE}/api/trading/execute`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ signalId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ===================== Trading (Bybit Positions) =====================

export interface BybitPosition {
  id: number
  symbol: string
  type: 'LONG' | 'SHORT'
  leverage: number
  entryPrice: number | null
  qty: number
  margin: number | null
  stopLoss: number
  takeProfits: number[]
  tpOrderIds: string[]
  closedPct: number
  realizedPnl: number
  fees: number
  status: string
  signalId: number | null
  signal: Signal | null
  createdAt: string
  filledAt: string | null
  closedAt: string | null
  unrealisedPnl: number
  markPrice: number | null
  origin: 'Auto' | 'Bybit' | 'Auto (Modified)'
}

export interface PnlStats {
  totalPnl: number
  tradesCount: number
  wins: number
  winRate: number
  byChannel: Record<string, { count: number; pnl: number }>
  dailySeries: { date: string; cumulativePnl: number }[]
}

export interface OrderLogEntry {
  id: number
  positionId: number | null
  signalId: number | null
  action: string
  details: any
  createdAt: string
}

export interface KillSwitchResponse {
  success: boolean
  cancelledOrders: number
  modeSet: string
}

export async function getLivePositions(): Promise<{ data: BybitPosition[] }> {
  const res = await fetch(`${BASE}/api/trading/positions/live`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch positions')
  return res.json()
}

export async function closePosition(id: number): Promise<{ success: boolean }> {
  const res = await fetch(`${BASE}/api/trading/positions/${id}/close`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function marketEntry(id: number): Promise<{ success: boolean }> {
  const res = await fetch(`${BASE}/api/trading/positions/${id}/market-entry`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function cancelOrder(id: number): Promise<{ success: boolean }> {
  const res = await fetch(`${BASE}/api/trading/positions/${id}/cancel`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getPnlStats(period: 'day' | 'week' | 'month'): Promise<PnlStats> {
  const res = await fetch(`${BASE}/api/trading/stats?period=${period}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch P&L stats')
  return res.json()
}

export async function getOrderLogs(
  page: number,
  filters: { action?: string; signalId?: number; dateFrom?: string; dateTo?: string } = {}
): Promise<{ data: OrderLogEntry[]; total: number; page: number; totalPages: number }> {
  const q = new URLSearchParams({ page: String(page), limit: '20' })
  if (filters.action) q.set('action', filters.action)
  if (filters.signalId) q.set('signalId', String(filters.signalId))
  if (filters.dateFrom) q.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) q.set('dateTo', filters.dateTo)
  const res = await fetch(`${BASE}/api/trading/logs?${q}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch order logs')
  return res.json()
}

export async function activateKillSwitch(): Promise<KillSwitchResponse> {
  const res = await fetch(`${BASE}/api/trading/kill-switch`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface CoinStat {
  coin: string
  trades: number
  wins: number
  winRate: number
  avgPnl: number
  totalPnl: number
}

export async function getCoinStats(): Promise<{ data: CoinStat[] }> {
  const res = await fetch(`${BASE}/api/trading/stats/coins`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch coin stats')
  return res.json()
}

// Klines (Backtester)
export interface KlineData {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface KlinesResponse {
  symbol: string
  interval: string
  count: number
  data: KlineData[]
}

export async function getKlines(symbol: string, interval: string, count = 500): Promise<KlinesResponse> {
  const res = await fetch(
    `${BASE}/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&count=${count}`,
    { headers: getHeaders() }
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Failed to fetch klines' }))
    throw new Error(body.error || 'Failed to fetch klines')
  }
  return res.json()
}
