import { BASE, getHeaders } from './base'
import type { Signal } from './signals'

// ===================== Trading (Bybit Positions) =====================

export interface OrderLogDetails {
  symbol?: string
  side?: string
  qty?: number
  price?: number
  orderId?: string
  [key: string]: unknown
}

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
  details: OrderLogDetails
  createdAt: string
}

export interface KillSwitchResponse {
  success: boolean
  cancelledOrders: number
  modeSet: string
}

export interface CoinStat {
  coin: string
  trades: number
  wins: number
  winRate: number
  avgPnl: number
  totalPnl: number
}

export async function getLivePositions(signal?: AbortSignal): Promise<{ data: BybitPosition[] }> {
  const res = await fetch(`${BASE}/api/trading/positions/live`, { headers: getHeaders(), signal })
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

export async function getCoinStats(): Promise<{ data: CoinStat[] }> {
  const res = await fetch(`${BASE}/api/trading/stats/coins`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch coin stats')
  return res.json()
}
