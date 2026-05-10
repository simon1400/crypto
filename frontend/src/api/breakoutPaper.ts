import { BASE, getHeaders } from './base'

// === Variant routing ===
// All paper-trader endpoints exist for both variants A (legacy prod) and B (alt
// sizing experiment). Pass variant to API helpers to hit the right URL prefix.
//   A → /api/breakout-paper/*
//   B → /api/breakout-paper-b/*
// Default is A for backwards compatibility with existing call sites.
export type BreakoutVariant = 'A' | 'B'

function basePath(variant: BreakoutVariant = 'A'): string {
  return variant === 'B' ? '/api/breakout-paper-b' : '/api/breakout-paper'
}

export interface BreakoutPaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  // Legacy flat round-trip fee — kept for backwards compatibility
  feesRoundTripPct: number
  // Realistic Binance-style fee model (defaults: 0.05 / 0.02 / 0.03)
  feeTakerPct?: number
  feeMakerPct?: number
  slipTakerPct?: number
  autoTrailingSL: boolean
  // Margin guard (server-side may not always emit these on legacy DBs)
  targetMarginPct?: number
  marginGuardEnabled?: boolean
  marginGuardAutoClose?: boolean
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
  feeTakerPct: number | null
  feeMakerPct: number | null
  slipTakerPct: number | null
  slipPaidUsd: number
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
  // Variant-specific overlays (B): outcome computed from BreakoutPaperTradeB.
  _tradeStatus?: string
  _tradeRealizedR?: number
  _tradeNetPnlUsd?: number
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

export async function getBreakoutPaperConfig(variant: BreakoutVariant = 'A'): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}${basePath(variant)}/config`, { headers: getHeaders() }))
}
export async function updateBreakoutPaperConfig(patch: Partial<BreakoutPaperConfig>, variant: BreakoutVariant = 'A'): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}${basePath(variant)}/config`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}
export async function resetBreakoutPaper(startingDepositUsd?: number, variant: BreakoutVariant = 'A'): Promise<BreakoutPaperConfig> {
  return handle(await fetch(`${BASE}${basePath(variant)}/reset`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startingDepositUsd }),
  }))
}
export async function wipeAllBreakoutPaper(startingDepositUsd?: number, variant: BreakoutVariant = 'A'): Promise<{
  ok: true; deletedTrades: number; deletedSignals: number; config: BreakoutPaperConfig
}> {
  return handle(await fetch(`${BASE}${basePath(variant)}/wipe-all`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startingDepositUsd }),
  }))
}
export async function getBreakoutPaperTrades(opts: { status?: string[]; symbol?: string; limit?: number; offset?: number; orderBy?: 'openedAt' | 'closedAt' } = {}, variant: BreakoutVariant = 'A'): Promise<{ data: BreakoutTrade[]; total: number }> {
  const p = new URLSearchParams()
  if (opts.status?.length) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  if (opts.orderBy) p.set('orderBy', opts.orderBy)
  return handle(await fetch(`${BASE}${basePath(variant)}/trades?${p}`, { headers: getHeaders() }))
}
export async function getBreakoutPaperStats(variant: BreakoutVariant = 'A'): Promise<BreakoutStats> {
  return handle(await fetch(`${BASE}${basePath(variant)}/stats`, { headers: getHeaders() }))
}
export async function editBreakoutPaperTrade(id: number, patch: {
  entryPrice?: number; stopLoss?: number; currentStop?: number; initialStop?: number; tpLadder?: number[]
  feesRoundTripPct?: number | null; autoTrailingSL?: boolean | null
  status?: string; closes?: BreakoutClose[]; positionUnits?: number; positionSizeUsd?: number; riskUsd?: number
}, variant: BreakoutVariant = 'A'): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}${basePath(variant)}/trades/${id}`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}
export interface BreakoutTradeLive {
  id: number; status: string; currentPrice: number | null
  unrealizedPnl: number; unrealizedPnlPct: number
  remainingUnrealizedPnl?: number; remainingUnrealizedPnlPct?: number
}
export async function getBreakoutPaperLivePrices(signal?: AbortSignal, variant: BreakoutVariant = 'A'): Promise<BreakoutTradeLive[]> {
  const res = await fetch(`${BASE}${basePath(variant)}/trades/live`, { headers: getHeaders(), signal })
  if (!res.ok) return []
  return res.json()
}
export async function deleteBreakoutPaperTrade(id: number, variant: BreakoutVariant = 'A'): Promise<{ ok: true }> {
  return handle(await fetch(`${BASE}${basePath(variant)}/trades/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  }))
}
export async function closeBreakoutPaperTradeMarket(id: number, variant: BreakoutVariant = 'A'): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}${basePath(variant)}/trades/${id}/close-market`, {
    method: 'POST', headers: getHeaders(),
  }))
}
export async function closeBreakoutPaperTradeManual(id: number, price: number, percent?: number, variant: BreakoutVariant = 'A'): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}${basePath(variant)}/trades/${id}/close-manual`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ price, percent }),
  }))
}
// Симулирует TP1/TP2/TP3/SL fill точно так же, как это делает движок
// (maker fees/без slip для TP, taker fees+slip для SL, авто-трейлинг SL).
export async function simulateBreakoutPaperFill(id: number, reason: 'TP1' | 'TP2' | 'TP3' | 'SL', variant: BreakoutVariant = 'A'): Promise<BreakoutTrade> {
  return handle(await fetch(`${BASE}${basePath(variant)}/trades/${id}/simulate-fill`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }))
}

// === Signals
// Variant A reads /api/breakout/signals (canonical). Variant B reads
// /api/breakout-paper-b/signals which overlays paperStatus from B's trade table.
export async function getBreakoutSignals(opts: { status?: string[]; symbol?: string; limit?: number; offset?: number } = {}, variant: BreakoutVariant = 'A'): Promise<{ data: BreakoutSignal[]; total: number }> {
  const p = new URLSearchParams()
  if (opts.status?.length) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  const url = variant === 'B'
    ? `${BASE}/api/breakout-paper-b/signals?${p}`
    : `${BASE}/api/breakout/signals?${p}`
  return handle(await fetch(url, { headers: getHeaders() }))
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
// Force-open routes are per-variant: A uses /api/breakout/, B uses /api/breakout-paper-b/.
export async function forceOpenBreakoutSignal(id: number, variant: BreakoutVariant = 'A'): Promise<ForceOpenResult> {
  const url = variant === 'B'
    ? `${BASE}/api/breakout-paper-b/signals/${id}/force-open`
    : `${BASE}/api/breakout/signals/${id}/force-open`
  return handle(await fetch(url, {
    method: 'POST', headers: getHeaders(),
  }))
}
