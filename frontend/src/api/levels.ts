import { BASE, getHeaders } from './base'

// ===================== Levels strategy live signals =====================

export type LevelsMarket = 'CRYPTO'
export type LevelsSide = 'BUY' | 'SELL'
export type LevelsEvent = 'REACTION' | 'BREAKOUT_RETEST'
export type LevelsStatus =
  | 'NEW' | 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'CLOSED' | 'SL_HIT' | 'EXPIRED'
  | 'PENDING' | 'AWAITING_CONFIRM' | 'CANCELLED'

export type LevelsEntryMode = 'MARKET' | 'LIMIT'

export interface LevelsClose {
  price: number
  percent: number
  pnlR: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

export interface LevelsFiboImpulse {
  fromPrice: number
  toPrice: number
  direction: 'BULL' | 'BEAR'
  sizeAtr: number
}

export interface LevelsSignal {
  id: number
  symbol: string
  market: LevelsMarket
  side: LevelsSide
  event: LevelsEvent
  source: string
  level: number
  entryPrice: number
  stopLoss: number
  initialStop: number
  currentStop: number
  tpLadder: number[]
  isFiboConfluence: boolean
  fiboImpulse: LevelsFiboImpulse | null
  reason: string
  status: LevelsStatus
  closes: LevelsClose[]
  realizedR: number
  // LIMIT-mode lifecycle
  entryMode: LevelsEntryMode
  entryFilledAt: string | null
  pendingExpiresAt: string | null
  lastPriceCheck: number | null
  lastPriceCheckAt: string | null
  notifiedTelegram: boolean
  expiresAt: string | null
  closedAt: string | null
  createdAt: string
}

export interface LevelsListResponse {
  data: LevelsSignal[]
  total: number
}

export interface LevelsStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalR: number
  expectancyR: number
  bySymbol: Record<string, { trades: number; wins: number; totalR: number }>
}

export interface LevelsSetup {
  symbol: string
  market: LevelsMarket
  side: 'BUY' | 'SELL' | 'BOTH'
  fractalLR: 3 | 5
  tpMinAtr?: number
  entryMode?: LevelsEntryMode
}

export interface LevelsConfig {
  id: number
  enabled: boolean
  symbolsEnabled: string[]
  cronIntervalMin: number
  expiryHours: number
  notifyOnNew: boolean
  notifyOnClose: boolean
  lastScanAt: string | null
  lastScanResult: Record<string, number> | null
  updatedAt: string
  createdAt: string
}

export interface LevelsConfigResponse {
  config: LevelsConfig
  defaultSetups: LevelsSetup[]
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

export async function getLevelsSignals(opts: {
  market?: LevelsMarket
  status?: LevelsStatus[]
  symbol?: string
  side?: LevelsSide
  limit?: number
  offset?: number
} = {}): Promise<LevelsListResponse> {
  const p = new URLSearchParams()
  if (opts.market) p.set('market', opts.market)
  if (opts.status && opts.status.length > 0) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.side) p.set('side', opts.side)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  return handle(await fetch(`${BASE}/api/levels?${p}`, { headers: getHeaders() }))
}

export async function getLevelsSignal(id: number): Promise<LevelsSignal> {
  return handle(await fetch(`${BASE}/api/levels/${id}`, { headers: getHeaders() }))
}

export async function getLevelsStats(): Promise<LevelsStats> {
  return handle(await fetch(`${BASE}/api/levels/stats`, { headers: getHeaders() }))
}

export async function getLevelsConfig(): Promise<LevelsConfigResponse> {
  return handle(await fetch(`${BASE}/api/levels/config`, { headers: getHeaders() }))
}

export async function updateLevelsConfig(patch: Partial<LevelsConfig>): Promise<LevelsConfig> {
  return handle(
    await fetch(`${BASE}/api/levels/config`, {
      method: 'PUT',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function scanLevelsNow(): Promise<{ totalFired: number; perSymbol: Record<string, number> }> {
  return handle(
    await fetch(`${BASE}/api/levels/scan-now`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function trackLevelsNow(): Promise<{ processed: number }> {
  return handle(
    await fetch(`${BASE}/api/levels/track-now`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function cancelLevelsSignal(id: number): Promise<LevelsSignal> {
  return handle(
    await fetch(`${BASE}/api/levels/${id}/cancel`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function editLevelsSignal(id: number, patch: {
  entryPrice?: number
  stopLoss?: number
  currentStop?: number
  tpLadder?: number[]
  reason?: string
}): Promise<LevelsSignal> {
  return handle(
    await fetch(`${BASE}/api/levels/${id}`, {
      method: 'PUT',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function closeLevelsSignalMarket(id: number): Promise<LevelsSignal> {
  return handle(
    await fetch(`${BASE}/api/levels/${id}/close-market`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export interface KeyLevelDto {
  price: number
  label: string
  kind: 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'FRACTAL_H1' | 'FRACTAL_M15' | 'FRACTAL_5M' | 'OTHER'
}

export async function getKeyLevels(symbol: string, entryPrice?: number): Promise<{ levels: KeyLevelDto[] }> {
  const p = new URLSearchParams()
  if (entryPrice !== undefined) p.set('entryPrice', String(entryPrice))
  return handle(await fetch(`${BASE}/api/levels/key-levels/${encodeURIComponent(symbol)}?${p}`, { headers: getHeaders() }))
}

export async function cancelPendingLevelsSignal(id: number): Promise<LevelsSignal> {
  return handle(
    await fetch(`${BASE}/api/levels/${id}/cancel-pending`, {
      method: 'POST',
      headers: getHeaders(),
    }),
  )
}

export async function closeLevelsSignalManual(id: number, price: number, percent?: number): Promise<LevelsSignal> {
  return handle(
    await fetch(`${BASE}/api/levels/${id}/close-manual`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ price, percent }),
    }),
  )
}
