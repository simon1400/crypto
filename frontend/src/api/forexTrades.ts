import { BASE, getHeaders } from './base'

export interface ForexTradeTP {
  price: number
  percent: number
  rr?: number
}

export interface ForexTradeClose {
  price: number
  percent: number
  pipsPnl: number
  usdPnl: number
  closedAt: string
  isSL?: boolean
}

export type ForexTradeStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'SL_HIT' | 'CANCELLED'

export interface ForexTrade {
  id: number
  instrument: string
  type: 'LONG' | 'SHORT'
  lots: number
  entryPrice: number
  stopLoss: number
  initialStop: number | null
  currentStop: number | null
  takeProfits: ForexTradeTP[]
  closes: ForexTradeClose[]
  closedPct: number
  realizedPipsPnl: number
  realizedUsdPnl: number
  status: ForexTradeStatus
  source: 'MANUAL' | 'SCANNER'
  signalId: number | null
  session: string | null
  notes: string | null
  openedAt: string | null
  closedAt: string | null
  createdAt: string
  stopMovedToBe: boolean
  stopMoveReason: string | null
  tp1HitTimestamp: string | null
  tp2HitTimestamp: string | null
  tp3HitTimestamp: string | null
  exitReason: string | null
  timeInTradeMin: number | null
}

export interface ForexTradeList {
  data: ForexTrade[]
  total: number
  page: number
  totalPages: number
}

export interface ForexTradeStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalUsdPnl: number
  totalPipsPnl: number
  byInstrument: Record<string, { count: number; usdPnl: number; pipsPnl: number }>
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

export async function getForexTrades(
  page = 1,
  limit = 20,
  opts: { status?: string; instrument?: string; dateFrom?: string; dateTo?: string } = {},
): Promise<ForexTradeList> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (opts.status) params.set('status', opts.status)
  if (opts.instrument) params.set('instrument', opts.instrument)
  if (opts.dateFrom) params.set('dateFrom', opts.dateFrom)
  if (opts.dateTo) params.set('dateTo', opts.dateTo)
  return handle(await fetch(`${BASE}/api/forex-trades?${params}`, { headers: getHeaders() }))
}

export async function getForexTradesStats(
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<ForexTradeStats> {
  const params = new URLSearchParams()
  if (opts.dateFrom) params.set('dateFrom', opts.dateFrom)
  if (opts.dateTo) params.set('dateTo', opts.dateTo)
  const q = params.toString() ? `?${params}` : ''
  return handle(await fetch(`${BASE}/api/forex-trades/stats${q}`, { headers: getHeaders() }))
}

export async function getForexTrade(id: number): Promise<ForexTrade> {
  return handle(await fetch(`${BASE}/api/forex-trades/${id}`, { headers: getHeaders() }))
}

export async function createForexTrade(data: {
  instrument: string
  type: 'LONG' | 'SHORT'
  lots: number
  entryPrice: number
  stopLoss: number
  takeProfits?: ForexTradeTP[]
  notes?: string
}): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data),
    }),
  )
}

export async function closeForexTrade(id: number, price: number, percent: number): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}/close`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ price, percent }),
    }),
  )
}

export async function slHitForexTrade(id: number): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}/sl-hit`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function moveForexStop(id: number, newStop: number, reason?: string): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}/move-stop`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ newStop, reason }),
    }),
  )
}

export async function cancelForexTrade(id: number): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}/cancel`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function updateForexTrade(
  id: number,
  data: { notes?: string; takeProfits?: ForexTradeTP[] },
): Promise<ForexTrade> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(data),
    }),
  )
}

export async function deleteForexTrade(id: number): Promise<{ ok: true }> {
  return handle(
    await fetch(`${BASE}/api/forex-trades/${id}`, {
      method: 'DELETE',
      headers: getHeaders(),
    }),
  )
}

// Take signal as a ForexTrade (in scannerForex.ts routes)
export async function takeForexSignalAsTrade(
  signalId: number,
  data: {
    lots: number
    entryPrice?: number
    stopLoss?: number
    takeProfits?: ForexTradeTP[]
    notes?: string
  },
): Promise<{ trade: ForexTrade; signal: { id: number; status: string } }> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${signalId}/take-trade`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data),
    }),
  )
}

// Take signal as N independent ForexTrades — одна на каждый TP (1:1 как в MT5).
// Backend применяет fallback: если lotsPerLeg < 0.01 → создаётся ОДНА сделка 0.01 с ближайшим TP.
export async function takeForexSignalAsMultiTrade(
  signalId: number,
  data: {
    lotsPerLeg: number       // RAW значение из калькулятора (может быть < 0.01 — backend сам решит)
    entryPrice?: number
    stopLoss?: number
    notes?: string
  },
): Promise<{
  trades: ForexTrade[]
  signal: { id: number; status: string }
  fallback: { reason: string; chosenTpIdx: number } | null
}> {
  return handle(
    await fetch(`${BASE}/api/scanner-forex/signals/${signalId}/take-trade-multi`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data),
    }),
  )
}
