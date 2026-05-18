import { BASE, getHeaders } from './base'

// === Variant C LIVE — Binance Futures real-money copy ===
// Separate API surface from paper-trader endpoints. Paper C lives at
// /api/breakout-paper-c; live C lives at /api/breakout-live-c.

const BP = '/api/breakout-live-c'

export interface BreakoutLiveConfig {
  id: number
  enabled: boolean
  useTestnet: boolean
  killSwitchActive: boolean
  killSwitchReason: string | null
  killSwitchAt: string | null
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feeTakerPct: number
  feeMakerPct: number
  slipTakerPct: number
  autoTrailingSL: boolean
  targetMarginPct: number
  marginGuardEnabled: boolean
  marginGuardAutoClose: boolean
  dailyLossLimitPct: number
  dailyLossLimitR: number
  weeklyLossLimitPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  totalTrades: number
  totalWins: number
  totalLosses: number
  totalPnLUsd: number
  totalFundingUsd: number
  peakDepositUsd: number
  maxDrawdownPct: number
  startedAt: string
  resetAt: string | null
  updatedAt: string
  createdAt: string
}

export interface BreakoutLiveStatusPosition {
  symbol: string
  positionAmt: number
  entryPrice: number
  markPrice: number
  unRealizedProfit: number
  leverage: number
  marginType: string
}

export interface BreakoutLiveStatusOrder {
  orderId: number
  clientOrderId: string
  symbol: string
  side: string
  type: string
  price: number
  stopPrice: number
  origQty: number
  status: string
  reduceOnly: boolean
}

export interface BreakoutLiveStatus {
  connected: boolean
  net?: 'testnet' | 'prod'
  reason?: string
  enabled?: boolean
  killSwitchActive?: boolean
  killSwitchReason?: string | null
  // Live Binance source of truth.
  balanceUsdt?: number          // availableBalance — sizing source
  walletBalanceUsdt?: number    // total wallet including locked margin
  baselineUsd?: number          // startingDepositUsd snapshot
  totalPnlUsd?: number          // available - baseline
  totalPnlPct?: number
  baselineSnapshottedAt?: string | null
  openPositions?: number
  openOrders?: number
  usedWeight1m?: number
  orderCount1m?: number
  positions?: BreakoutLiveStatusPosition[]
  orders?: BreakoutLiveStatusOrder[]
}

export interface BreakoutLiveTrade {
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
  closes: Array<{
    price: number
    percent: number
    pnlR?: number
    pnlUsd?: number
    closedAt: string
    reason?: string
  }>
  realizedR: number
  realizedPnlUsd: number
  feesPaidUsd: number
  fundingPaidUsd: number
  netPnlUsd: number
  limitOrderState: string | null
  limitOrderPrice: number | null
  limitPlacedAt: string | null
  limitFilledAt: string | null
  pairOrderId: number | null
  binanceClientOrderId: string | null
  binanceOrderId: string | null
  binanceSlOrderId: string | null
  binanceTpOrderIds: string[]
  openedAt: string
  closedAt: string | null
  expiresAt: string | null
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${url}`, { ...init, headers: getHeaders() })
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText)
    throw new Error(`${r.status}: ${text}`)
  }
  return r.json()
}

export async function getLiveConfig(): Promise<BreakoutLiveConfig> {
  return req(`${BP}/config`)
}

export async function updateLiveConfig(patch: Partial<BreakoutLiveConfig>): Promise<BreakoutLiveConfig> {
  return req(`${BP}/config`, { method: 'PUT', body: JSON.stringify(patch) })
}

export async function getLiveStatus(): Promise<BreakoutLiveStatus> {
  return req(`${BP}/status`)
}

export async function getLiveTrades(query?: { status?: string; symbol?: string; limit?: number; offset?: number }): Promise<{ data: BreakoutLiveTrade[]; total: number }> {
  const qs = new URLSearchParams()
  if (query?.status) qs.set('status', query.status)
  if (query?.symbol) qs.set('symbol', query.symbol)
  if (query?.limit) qs.set('limit', String(query.limit))
  if (query?.offset) qs.set('offset', String(query.offset))
  const s = qs.toString()
  return req(`${BP}/trades${s ? '?' + s : ''}`)
}

export async function killSwitch(reason?: string): Promise<{ ok: boolean; cancelledOrders?: number; closedPositions?: number; note?: string }> {
  return req(`${BP}/kill-switch`, { method: 'POST', body: JSON.stringify({ reason: reason ?? 'manual' }) })
}

export async function releaseKillSwitch(): Promise<BreakoutLiveConfig> {
  return req(`${BP}/kill-switch/release`, { method: 'POST' })
}

export async function resetBaseline(): Promise<{ ok: boolean; baselineUsd: number; config: BreakoutLiveConfig }> {
  return req(`${BP}/baseline/reset`, { method: 'POST' })
}

export async function testPlaceOrder(p: { symbol: string; side: 'BUY' | 'SELL'; priceOffsetPct?: number; quantity?: number }): Promise<any> {
  return req(`${BP}/test-place-order`, { method: 'POST', body: JSON.stringify(p) })
}

export async function cancelTestOrders(symbol: string): Promise<{ ok: boolean }> {
  return req(`${BP}/test-orders/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
}
