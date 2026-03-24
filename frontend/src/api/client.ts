const BASE = import.meta.env.VITE_API_URL || ''
const SECRET = import.meta.env.VITE_API_SECRET || ''

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Api-Secret': SECRET,
}

export interface MarketOverview {
  fearGreed: number
  fearGreedLabel: string
  btcDominance: number
}

export interface CoinIndicators {
  price: number
  ema20: number
  ema50: number
  rsi: number
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'
  support: number
  resistance: number
  volRatio: number
  change24h: number
}

export interface AnalysisResponse {
  id: number
  result: string
  coinsData: Record<string, CoinIndicators>
  marketData: MarketOverview
  createdAt: string
}

export interface Analysis {
  id: number
  createdAt: string
  coins: string
  marketData: MarketOverview
  coinsData: Record<string, CoinIndicators>
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
    headers,
    body: JSON.stringify({ coins }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getMarketOverview(): Promise<MarketOverview> {
  const res = await fetch(`${BASE}/api/market`, { headers })
  if (!res.ok) throw new Error('Failed to fetch market data')
  return res.json()
}

export async function getHistory(page = 1): Promise<HistoryResponse> {
  const res = await fetch(`${BASE}/api/history?page=${page}&limit=10`, { headers })
  if (!res.ok) throw new Error('Failed to fetch history')
  return res.json()
}

export async function getAnalysis(id: number): Promise<Analysis> {
  const res = await fetch(`${BASE}/api/history/${id}`, { headers })
  if (!res.ok) throw new Error('Failed to fetch analysis')
  return res.json()
}
