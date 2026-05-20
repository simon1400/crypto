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

export interface BreakoutLiveAlgoOrder {
  algoId: number
  clientAlgoId: string
  symbol: string
  side: 'BUY' | 'SELL'
  type: string                // STOP_MARKET | TAKE_PROFIT_MARKET
  tpIdx: number | null        // 1/2/3 for TP orders; null otherwise
  triggerPrice: number
  quantity: number
  reduceOnly: boolean
  createdAt: number | null    // ms epoch (from Binance bookTime/createTime)
}

export interface BreakoutLiveStatus {
  connected: boolean
  net?: 'testnet' | 'prod'
  reason?: string
  enabled?: boolean
  killSwitchActive?: boolean
  killSwitchReason?: string | null
  // Live Binance source of truth.
  balanceUsdt?: number             // availableBalance — sizing source
  walletBalanceUsdt?: number       // total wallet (sum of all realized PnL, excl. unrealized)
  marginBalanceUsdt?: number       // wallet + unrealized — current equity
  unrealizedPnlUsdt?: number       // sum across all open positions
  baselineUsd?: number             // startingDepositUsd snapshot taken at first enable
  totalPnlUsd?: number             // marginBalance - baseline (true PnL incl. open positions)
  totalPnlPct?: number
  baselineSnapshottedAt?: string | null
  openPositions?: number
  openOrders?: number
  usedWeight1m?: number
  orderCount1m?: number
  positions?: BreakoutLiveStatusPosition[]
  orders?: BreakoutLiveStatusOrder[]
  algoOrders?: BreakoutLiveAlgoOrder[]
  algoOrdersAge?: number    // ms since last refresh
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

export async function getLiveStatus(forceRefresh = false): Promise<BreakoutLiveStatus> {
  return req(`${BP}/status${forceRefresh ? '?refresh=1' : ''}`)
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

export interface WipeAllResponse {
  ok: boolean
  deletedTrades: number
  deletedFunding: number
  deletedAttempts: number
  config: BreakoutLiveConfig
}

export async function wipeAllLive(confirmation?: string): Promise<WipeAllResponse> {
  return req(`${BP}/wipe-all`, {
    method: 'POST',
    body: JSON.stringify(confirmation ? { confirmation } : {}),
  })
}

export interface SwitchNetworkResponse {
  ok: boolean
  target: 'testnet' | 'real'
  deletedTrades: number
  deletedFunding: number
  deletedAttempts: number
  config: BreakoutLiveConfig
}

export async function switchNetwork(
  target: 'testnet' | 'real',
  confirmation?: string,
): Promise<SwitchNetworkResponse> {
  return req(`${BP}/switch-network`, {
    method: 'POST',
    body: JSON.stringify({ target, ...(confirmation ? { confirmation } : {}) }),
  })
}

export async function testPlaceOrder(p: { symbol: string; side: 'BUY' | 'SELL'; priceOffsetPct?: number; quantity?: number }): Promise<any> {
  return req(`${BP}/test-place-order`, { method: 'POST', body: JSON.stringify(p) })
}

export async function cancelTestOrders(symbol: string): Promise<{ ok: boolean }> {
  return req(`${BP}/test-orders/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
}

// === Placement attempts audit (powers 'Отклонённые' tab) ===

export interface BreakoutLiveAttempt {
  id: number
  symbol: string
  side: 'BUY' | 'SELL'
  rangeDate: string
  // PLACED | REJECTED_EXCHANGE | SKIPPED_GATE | SKIPPED_FILTER
  status: string
  reasonCode: string | null
  reasonText: string | null
  limitPrice: number | null
  markPrice: number | null
  rangeHigh: number | null
  rangeLow: number | null
  attemptedAt: string
}

export interface BreakoutLiveAttemptsResponse {
  data: BreakoutLiveAttempt[]
  rangeDate: string
  shown: number               // rows.length — visible in the table
  total: number               // real count across the whole rangeDate
  counts: {
    placed: number
    rejected: number
    gated: number
    filtered: number
  }
}

export async function getLiveAttempts(rangeDate?: string): Promise<BreakoutLiveAttemptsResponse> {
  const q = rangeDate ? `?rangeDate=${encodeURIComponent(rangeDate)}` : ''
  return req(`${BP}/attempts${q}`)
}

export async function clearLiveAttempts(rangeDate?: string): Promise<{ deleted: number; rangeDate: string }> {
  const q = rangeDate ? `?rangeDate=${encodeURIComponent(rangeDate)}` : ''
  return req(`${BP}/attempts${q}`, { method: 'DELETE' })
}
