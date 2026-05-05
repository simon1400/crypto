import { BASE, getHeaders } from './base'

export interface PaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feesRoundTripPct: number
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

export interface PaperClose {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

export interface PaperTrade {
  id: number
  signalId: number
  symbol: string
  market: 'FOREX' | 'CRYPTO'
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
  status: string
  closes: PaperClose[]
  realizedR: number
  realizedPnlUsd: number
  feesPaidUsd: number
  netPnlUsd: number
  lastPriceCheck: number | null
  lastPriceCheckAt: string | null
  expiresAt: string | null
  closedAt: string | null
  openedAt: string
}

export interface PaperStats {
  config: PaperConfig
  winRate: number
  returnPct: number
  bySymbol: Record<string, { trades: number; wins: number; pnl: number }>
  equityCurve: Array<{ date: string; pnl: number; equity: number }>
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const e = await res.json(); if (e?.error) msg = e.error } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function getPaperConfig(): Promise<PaperConfig> {
  return handle(await fetch(`${BASE}/api/levels-paper/config`, { headers: getHeaders() }))
}

export async function updatePaperConfig(patch: Partial<PaperConfig>): Promise<PaperConfig> {
  return handle(await fetch(`${BASE}/api/levels-paper/config`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}

export async function resetPaper(startingDepositUsd?: number): Promise<PaperConfig> {
  return handle(await fetch(`${BASE}/api/levels-paper/reset`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startingDepositUsd }),
  }))
}

export async function getPaperTrades(opts: { status?: string[]; symbol?: string; limit?: number; offset?: number } = {}): Promise<{ data: PaperTrade[]; total: number }> {
  const p = new URLSearchParams()
  if (opts.status?.length) p.set('status', opts.status.join(','))
  if (opts.symbol) p.set('symbol', opts.symbol)
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  return handle(await fetch(`${BASE}/api/levels-paper/trades?${p}`, { headers: getHeaders() }))
}

export async function getPaperStats(): Promise<PaperStats> {
  return handle(await fetch(`${BASE}/api/levels-paper/stats`, { headers: getHeaders() }))
}

export async function runPaperCycleNow(): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number }> {
  return handle(await fetch(`${BASE}/api/levels-paper/cycle-now`, { method: 'POST', headers: getHeaders() }))
}

export async function editPaperTrade(id: number, patch: {
  entryPrice?: number
  stopLoss?: number
  currentStop?: number
  tpLadder?: number[]
}): Promise<PaperTrade> {
  return handle(await fetch(`${BASE}/api/levels-paper/trades/${id}`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}

export async function closePaperTradeMarket(id: number): Promise<PaperTrade> {
  return handle(await fetch(`${BASE}/api/levels-paper/trades/${id}/close-market`, {
    method: 'POST',
    headers: getHeaders(),
  }))
}

export async function closePaperTradeManual(id: number, price: number, percent?: number): Promise<PaperTrade> {
  return handle(await fetch(`${BASE}/api/levels-paper/trades/${id}/close-manual`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ price, percent }),
  }))
}
