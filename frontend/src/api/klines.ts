import { BASE, getHeaders } from './base'

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
