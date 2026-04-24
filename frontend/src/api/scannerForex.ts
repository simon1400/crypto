import { BASE, getHeaders } from './base'

// ===================== Forex Scanner =====================

export type ForexSession = 'ASIA' | 'LONDON' | 'NY' | 'OVERLAP' | 'DEAD'

export interface ForexTakeProfit {
  price: number
  rr: number
}

export interface ForexSignalClose {
  price: number
  percent: number
  pnl: number
  pnlPercent: number
  closedAt: string
  isSL?: boolean
}

export interface ForexSignal {
  id: number
  coin: string // instrument — EURUSD, XAUUSD, US30, ...
  type: 'LONG' | 'SHORT'
  strategy: string
  score: number
  entry: number
  stopLoss: number
  takeProfits: ForexTakeProfit[]
  leverage: number
  positionPct: number
  amount: number // lot size if taken
  indicators: Record<string, any>
  marketContext: {
    session?: ForexSession
    scoreBreakdown?: { trend: number; momentum: number; structure: number }
    reasons?: string[]
    [key: string]: any
  }
  status: 'NEW' | 'TAKEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'SL_HIT' | 'EXPIRED'
  expiresAt: string
  createdAt: string
  takenAt: string | null
  closedAt: string | null
  closes: ForexSignalClose[]
  closedPct: number
  realizedPnl: number
  market: 'CRYPTO' | 'FOREX'
  session: ForexSession | null
}

export interface ForexSignalList {
  data: ForexSignal[]
  total: number
  page: number
  totalPages: number
}

export interface ForexScannerStatus {
  state: {
    isRunning: boolean
    lastRunAt: string | null
    lastRunDurationMs: number | null
    lastError: string | null
    lastSignalsCount: number
  }
  instruments: string[]
  enabled: boolean
  minScore: number
  lastScanAt: string | null
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const err = await res.json()
      if (err?.error) msg = err.error
    } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function getForexScannerStatus(): Promise<ForexScannerStatus> {
  return handle(await fetch(`${BASE}/api/scanner-forex/status`, { headers: getHeaders() }))
}

export async function runForexScannerManual(): Promise<{
  instrumentsScanned: number
  signalsCreated: number
  errors: { instrument: string; message: string }[]
  skipped: boolean
  skipReason?: string
}> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/run`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function updateForexScannerSettings(data: {
  enabled?: boolean
  minScore?: number
}): Promise<{ enabled: boolean; minScore: number }> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/settings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data),
    }),
  )
}

export async function getForexSignals(
  page = 1,
  limit = 20,
  status?: string,
): Promise<ForexSignalList> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (status) params.set('status', status)
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals?${params}`, { headers: getHeaders() }),
  )
}

export async function getForexSignal(id: number): Promise<ForexSignal> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${id}`, { headers: getHeaders() }),
  )
}

export async function takeForexSignal(id: number, lots?: number): Promise<ForexSignal> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${id}/take`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ lots }),
    }),
  )
}

export async function closeForexSignal(
  id: number,
  price: number,
  percent: number,
): Promise<ForexSignal> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${id}/close`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ price, percent }),
    }),
  )
}

export async function slHitForexSignal(id: number): Promise<ForexSignal> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${id}/sl-hit`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function deleteForexSignal(id: number): Promise<{ ok: true }> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${id}`, {
      method: 'DELETE',
      headers: getHeaders(),
    }),
  )
}
