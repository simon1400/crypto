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
  status: string
  notes: string | null
  openedAt: string
  closedAt: string | null
  createdAt: string
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

export async function getTrades(params: { status?: string; coin?: string; page?: number } = {}): Promise<TradesResponse> {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.coin) q.set('coin', params.coin)
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
  amount: number; stopLoss: number; takeProfits: TradeTP[]; fees?: number; notes?: string
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
  takeProfits: { price: number; rr: number }[]
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
}

export interface ScanResponse {
  total: number
  confirmed: number
  rejected: number
  regime: {
    regime: string
    confidence: number
    btcTrend: string
    fearGreedZone: string
    volatility: string
  } | null
  signals: {
    coin: string
    type: string
    strategy: string
    score: number
    scoreBreakdown: { technical: number; multiTF: number; volume: number; marketContext: number; patterns: number }
    entry: number
    stopLoss: number
    slPercent: number
    takeProfits: { price: number; rr: number }[]
    tp1Percent: number
    tp2Percent: number
    tp3Percent: number
    leverage: number
    positionPct: number
    riskReward: number
    reasons: string[]
    gptVerdict: string
    gptConfidence: number
    gptReasoning: string
    gptRisks: string[]
    gptKeyLevels: string[]
  }[]
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

export async function getScannerSignals(page = 1, status?: string): Promise<{ data: ScannerSignal[]; total: number; page: number; totalPages: number }> {
  const q = new URLSearchParams({ page: String(page), limit: '20' })
  if (status) q.set('status', status)
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

export async function getScannerCoins(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/scanner/coins`, { headers: getHeaders() })
  if (!res.ok) return []
  const data = await res.json()
  return data.coins
}

export async function getScannerStatus(): Promise<{ running: boolean }> {
  const res = await fetch(`${BASE}/api/scanner/status`, { headers: getHeaders() })
  if (!res.ok) return { running: false }
  return res.json()
}

// ===================== Settings =====================

export interface SettingsResponse {
  apiKeyMasked: string | null
  apiSecretMasked: string | null
  hasKeys: boolean
  useTestnet: boolean
  positionSizePct: number
  dailyLossLimitPct: number
  orderTtlMinutes: number
  tradingMode: 'manual' | 'auto'
  near512Topics: string[]
  eveningTraderCategories: string[]
  balance?: string
  keyValidationFailed?: boolean
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch settings')
  return res.json()
}

export async function saveSettings(data: {
  apiKey?: string | null; apiSecret?: string | null; useTestnet?: boolean;
  positionSizePct?: number; dailyLossLimitPct?: number; orderTtlMinutes?: number;
  tradingMode?: 'manual' | 'auto'; near512Topics?: string[]; eveningTraderCategories?: string[]
}): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Save failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getBalance(): Promise<{ balance: string }> {
  const res = await fetch(`${BASE}/api/settings/balance`, { headers: getHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch balance' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ===================== Trading (Bybit) =====================

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
  // Enriched from Bybit live data
  unrealisedPnl: number
  markPrice: number | null
}

export interface PnlStats {
  totalPnl: number
  tradesCount: number
  wins: number
  winRate: number
  byChannel: Record<string, { count: number; pnl: number }>
  dailySeries: { date: string; cumulativePnl: number }[]
}

export interface KillSwitchResponse {
  success: boolean
  tradingMode: string
}

export interface OrderLogEntry {
  id: number
  positionId: number | null
  signalId: number | null
  action: string
  details: any
  createdAt: string
}

export async function getLivePositions(): Promise<{ data: BybitPosition[] }> {
  const res = await fetch(`${BASE}/api/trading/positions/live`, { headers: getHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch live positions' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function closePosition(id: number): Promise<{ success: boolean }> {
  const res = await fetch(`${BASE}/api/trading/positions/${id}/close`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to close position' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function activateKillSwitch(): Promise<KillSwitchResponse> {
  const res = await fetch(`${BASE}/api/trading/kill-switch`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Kill switch failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getPnlStats(period: 'day' | 'week' | 'month'): Promise<PnlStats> {
  const res = await fetch(`${BASE}/api/trading/stats?period=${period}`, { headers: getHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch stats' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function executeSignal(signalId: number): Promise<BybitPosition> {
  const res = await fetch(`${BASE}/api/trading/execute`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ signalId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Execution failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch order logs' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
