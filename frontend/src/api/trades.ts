import { BASE, getHeaders } from './base'

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

export interface TradeLive {
  id: number
  status: string
  closedPct?: number
  currentPrice: number | null
  unrealizedPnl: number
  unrealizedPnlPct: number
}

export async function searchSymbols(q = ''): Promise<string[]> {
  const res = await fetch(`${BASE}/api/trades/symbols?q=${encodeURIComponent(q)}`, { headers: getHeaders() })
  if (!res.ok) return []
  return res.json()
}

export async function getTradeLivePrices(signal?: AbortSignal): Promise<TradeLive[]> {
  const res = await fetch(`${BASE}/api/trades/live`, { headers: getHeaders(), signal })
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

export async function fillTradeMarket(id: number): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades/${id}/fill-market`, {
    method: 'POST', headers: getHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || 'Failed to fill trade')
  }
  return res.json()
}

export async function cancelTrade(id: number, reason: string): Promise<Trade> {
  const res = await fetch(`${BASE}/api/trades/${id}/cancel`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
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
