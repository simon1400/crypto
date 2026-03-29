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

export async function getSignals(channel = 'EveningTrader'): Promise<SignalsResponse> {
  const res = await fetch(`${BASE}/api/signals?channel=${channel}`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch signals')
  return res.json()
}

export async function syncSignals(channel = 'EveningTrader'): Promise<SignalsResponse> {
  const res = await fetch(`${BASE}/api/signals/sync`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ channel }),
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
