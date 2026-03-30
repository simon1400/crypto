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

export interface MarketOverview {
  fearGreed: number
  fearGreedLabel: string
  btcDominance: number
}

export interface CoinIndicators {
  price: number
  ema9: number
  ema20: number
  ema50: number
  rsi: number
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
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
  atr: number
  vwap: number
  fibLevels: { level: string; price: number }[]
  pivot: number
  pivotR1: number
  pivotR2: number
  pivotS1: number
  pivotS2: number
  patterns: string[]
}

export interface MultiTFIndicators {
  tf15m: CoinIndicators
  tf1h: CoinIndicators
  tf4h: CoinIndicators
}

export interface AnalysisResponse {
  id: number
  result: string
  coinsData: Record<string, MultiTFIndicators>
  marketData: MarketOverview
  createdAt: string
}

export interface Analysis {
  id: number
  createdAt: string
  coins: string
  marketData: MarketOverview
  coinsData: Record<string, MultiTFIndicators>
  result: string
}

export interface HistoryResponse {
  data: Analysis[]
  total: number
  page: number
  totalPages: number
}

export async function runAnalysis(coins: string[]): Promise<AnalysisResponse> {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ coins }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getMarketOverview(): Promise<MarketOverview> {
  const res = await fetch(`${BASE}/api/market`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch market data')
  return res.json()
}

export async function getHistory(page = 1): Promise<HistoryResponse> {
  const res = await fetch(`${BASE}/api/history?page=${page}&limit=10`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch history')
  return res.json()
}

export async function getAnalysis(id: number): Promise<Analysis> {
  const res = await fetch(`${BASE}/api/history/${id}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch analysis')
  return res.json()
}

// Whale tracking
export interface TokenTransfer {
  hash: string
  from: string
  to: string
  tokenName: string
  tokenSymbol: string
  valueFormatted: number
  timestamp: number
  direction: 'IN' | 'OUT'
}

export interface WhaleData {
  address: string
  name: string
  description: string
  ethBalance: number
  transfers: TokenTransfer[]
  summary: {
    totalBuys: number
    totalSells: number
    topTokens: { symbol: string; name: string; netAmount: number; direction: 'BUY' | 'SELL' }[]
  }
}

export interface WhaleScanResponse {
  data: WhaleData[]
  scannedAt: string
}

export async function scanWhales(): Promise<WhaleScanResponse> {
  const res = await fetch(`${BASE}/api/whales/scan`, {
    method: 'POST',
    headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
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
  amount: number; stopLoss: number; takeProfits: TradeTP[]; notes?: string
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
  amount?: number; stopLoss?: number; takeProfits?: TradeTP[]; notes?: string
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
  indicators: any
  marketContext: any
  aiAnalysis: string | null
  status: string
  expiresAt: string
  createdAt: string
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

export async function updateSignalStatus(id: number, status: string): Promise<ScannerSignal> {
  const res = await fetch(`${BASE}/api/scanner/signals/${id}/status`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error('Failed to update signal status')
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
