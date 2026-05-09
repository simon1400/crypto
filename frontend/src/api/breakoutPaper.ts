import { BASE, getHeaders } from './base'

export interface BreakoutPaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feesRoundTripPct: number
  autoTrailingSL: boolean
  dailyLossLimitPct: number
  weeklyLossLimitPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  totalTrades: number
  totalWins: number
  totalLosses: number
  totalPnLUsd: number
  peakDepositUsd: number
  maxDrawdownPct: number
  startedAt: string
  resetAt: string | null
  updatedAt: string
  createdAt: string
}

export interface BreakoutClose {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MANUAL' | 'MARGIN'
}

export interface BreakoutTrade {
  id: number
  signalId: number
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  initialStop: number
  currentStop: number
  tpLadder: number[]
  depositAtEntryUsd: number
  riskUsd: number
  positionSizeUsd: number
  positionUnits: number
  leverage: number | null
  marginUsd: number | null
  status: string
  closes: BreakoutClose[]
  realizedR: number
  realizedPnlUsd: number
  feesPaidUsd: number
  netPnlUsd: number
  feesRoundTripPct: number | null
  autoTrailingSL: boolean | null
  lastPriceCheck: number | null
  lastPriceCheckAt: string | null
  expiresAt: string | null
  closedAt: string | null
  openedAt: string
}

export interface BreakoutStats {
  config: BreakoutPaperConfig
  winRate: number
  returnPct: number
  bySymbol: Record<string, { trades: number; wins: number; pnl: number }>
  equityCurve: Array<{ date: string; pnl: number; equity: number }>
}

export interface BreakoutSignal {
  id: number
  symbol: string
  side: 'BUY' | 'SELL'
  rangeHigh: number
  rangeLow: number
  rangeSize: number
  rangeDate: string
  entryPrice: number
  stopLoss: number
  initialStop: number
  currentStop: number
  tpLadder: number[]
  volumeAtBreakout: number
  avgVolume: number
  reason: string
  status: string
  closes: BreakoutClose[]
  realizedR: number
  lastPriceCheck: number | null
  lastPriceCheckAt: string | null
  notifiedTelegram: boolean
  expiresAt: string | null
  closedAt: string | null
  createdAt: string
  paperStatus: string | null    // 'OPENED' | 'SKIPPED' | null
  paperReason: string | null
  paperUpdatedAt: string | null
}

export interface BreakoutConfig {
  id: number
  enabled: boolean
  symbolsEnabled: string[]
  rangeBars: number
  volumeMultiplier: number
  cronIntervalMin: number
  notifyOnNew: boolean
  notifyOnClose: boolean
  lastScanAt: string | null
  lastScanResult: Record<string, number> | null
  updatedAt: string
  createdAt: string
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const e = await res.json(); if (e?.error) msg = e.error } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function getBreakoutPaperConfig(): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}/api/breakout-paper/config`, { headers: getHeaders() }))
}
export async function updateBreakoutPaperConfig(patch: Partial<BreakoutPaperConfig>): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}/api/breakout-paper/config`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}
export async function resetBreakoutPaper(startingDepositUsd?: number): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}/api/breakout-paper/reset`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startingDepositUsd }),
  }))
}
export async function wipeAllBreakoutPaper(startingDepositUsd?: number): Promise<{
  ok: true; deletedTrades: number; deletedSignals: number; config: BreakoutPaperConfig
}> {
  return handle(await fetch(`${BASE}/api/breakout-paper/wipe-all`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startingDepositUsd }),
  }))
}
export async function getBreakoutPaperTrades(opts: { status?: string[]; symbol?: string; limit?: number; offset?: number; orderBy?: 'openedAt' | 'closedAt' } = {}): Promise<{ data: BreakoutTrade[]; total: number }> {
  const p = new URLSearchParams()
  if (opts.status?.length) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  if (opts.orderBy) p.set('orderBy', opts.orderBy)
  return handle(await fetch(`${BASE}/api/breakout-paper/trades?${p}`, { headers: getHeaders() }))
}
export async function getBreakoutPaperStats(): Promise<BreakoutStats> {
  return handle(await fetch(`${BASE}/api/breakout-paper/stats`, { headers: getHeaders() }))
}
export async function runBreakoutPaperCycleNow(): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number }> {
  return handle(await fetch(`${BASE}/api/breakout-paper/cycle-now`, { method: 'POST', headers: getHeaders() }))
}
export async function editBreakoutPaperTrade(id: number, patch: {
  entryPrice?: number; stopLoss?: number; currentStop?: number; initialStop?: number; tpLadder?: number[]
  feesRoundTripPct?: number | null; autoTrailingSL?: boolean | null
  status?: string; closes?: BreakoutClose[]; positionUnits?: number; positionSizeUsd?: number; riskUsd?: number
}): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}/api/breakout-paper/trades/${id}`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}
export interface BreakoutTradeLive {
  id: number; status: string; currentPrice: number | null
  // Полный P&L: реализованное + текущий остаток − все комиссии. Используется для "Депо с открытыми".
  unrealizedPnl: number; unrealizedPnlPct: number
  // Только остаток (в игре сейчас). Реализованная часть отдельно в колонке "Рлз.".
  remainingUnrealizedPnl?: number; remainingUnrealizedPnlPct?: number
}
export async function getBreakoutPaperLivePrices(signal?: AbortSignal): Promise<BreakoutTradeLive[]> {
  const res = await fetch(`${BASE}/api/breakout-paper/trades/live`, { headers: getHeaders(), signal })
  if (!res.ok) return []
  return res.json()
}
export async function deleteBreakoutPaperTrade(id: number): Promise<{ ok: true }> {
  return handle(await fetch(`${BASE}/api/breakout-paper/trades/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  }))
}
export async function closeBreakoutPaperTradeMarket(id: number): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}/api/breakout-paper/trades/${id}/close-market`, {
    method: 'POST', headers: getHeaders(),
  }))
}
export async function closeBreakoutPaperTradeManual(id: number, price: number, percent?: number): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}/api/breakout-paper/trades/${id}/close-manual`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ price, percent }),
  }))
}

// === Signals (read-only API)
export async function getBreakoutSignals(opts: { status?: string[]; symbol?: string; limit?: number; offset?: number } = {}): Promise<{ data: BreakoutSignal[]; total: number }> {
  const p = new URLSearchParams()
  if (opts.status?.length) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  return handle(await fetch(`${BASE}/api/breakout/signals?${p}`, { headers: getHeaders() }))
}
export async function getBreakoutConfig(): Promise<BreakoutConfig> {
  return handle(await fetch(`${BASE}/api/breakout/config`, { headers: getHeaders() }))
}
export async function updateBreakoutConfig(patch: Partial<BreakoutConfig>): Promise<BreakoutConfig> {
  return handle(await fetch(`${BASE}/api/breakout/config`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}
export async function getBreakoutSetups(): Promise<{ setups: string[] }> {
  return handle(await fetch(`${BASE}/api/breakout/setups`, { headers: getHeaders() }))
}
export async function scanBreakoutNow(): Promise<{ ok: true; lastScanAt: string | null; lastScanResult: Record<string, number> | null }> {
  return handle(await fetch(`${BASE}/api/breakout/scan-now`, { method: 'POST', headers: getHeaders() }))
}
export async function trackBreakoutNow(): Promise<{ processed: number }> {
  return handle(await fetch(`${BASE}/api/breakout/track-now`, { method: 'POST', headers: getHeaders() }))
}
export interface ForceOpenResult {
  ok: true
  tradeId: number
  marginUsd: number
  leverage: number
  positionSizeUsd: number
  entryPrice: number
}
export async function forceOpenBreakoutSignal(id: number): Promise<ForceOpenResult> {
  return handle(await fetch(`${BASE}/api/breakout/signals/${id}/force-open`, {
    method: 'POST', headers: getHeaders(),
  }))
}
