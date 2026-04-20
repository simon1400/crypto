import { BASE, getHeaders } from './base'

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
  // Author-reported (ETG reply updates)
  authorStatus?: string | null
  authorPnlPct?: number | null
  authorPeriod?: string | null
  authorClosedAt?: string | null
  averageEntryPrice?: number | null
  allEntriesFilled?: boolean
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
