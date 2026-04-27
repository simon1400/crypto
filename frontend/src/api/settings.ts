import { BASE, getHeaders } from './base'

// ===================== Settings =====================

export interface SettingsResponse {
  id: number
  bybitApiKey: string | null
  bybitApiSecret: string | null
  apiKeyMasked: string | null
  apiSecretMasked: string | null
  useTestnet: boolean
  tradingMode: string
  positionSizePct: number
  dailyLossLimitPct: number
  orderTtlMinutes: number
  eveningTraderCategories: string[]
  telegramBotToken: string | null
  telegramChatId: string | null
  telegramEnabled: boolean
  autoScanEnabled: boolean
  autoScanIntervalMin: number
  autoScanMinScore: number
  hasKeys: boolean
  balance: number | null
  isConnected: boolean
  virtualBalance: number
  virtualBalanceStart: number
  virtualStartedAt: string
  takerFeeRate: number
  makerFeeRate: number
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch settings')
  return res.json()
}

export async function saveSettings(data: Partial<SettingsResponse>): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getBalance(): Promise<{ balance: number | null; error?: string }> {
  const res = await fetch(`${BASE}/api/settings/balance`, { headers: getHeaders() })
  if (!res.ok) return { balance: null, error: 'Failed to fetch balance' }
  return res.json()
}

export interface BudgetStatus {
  balance: number       // virtual balance
  used: number          // занятая маржа
  available: number     // balance - used
  start: number         // стартовый депозит
  pnl: number           // общий P&L относительно старта
  roiPct: number
}

export async function getBudget(): Promise<BudgetStatus> {
  const res = await fetch(`${BASE}/api/trades/budget`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch budget')
  return res.json()
}

export interface VirtualBalanceInfo {
  balance: number
  start: number
  startedAt: string
  pnl: number
  roiPct: number
}

export async function getVirtualBalance(): Promise<VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/virtual-balance`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch virtual balance')
  return res.json()
}

export async function setVirtualBalance(balance: number, resetStart = true): Promise<VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/virtual-balance`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ balance, resetStart }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function resetSimulation(balance: number): Promise<{ deletedTrades: number } & VirtualBalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/reset-simulation`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ balance }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ===================== MT5 Balance (forex/gold calculator) =====================

export interface Mt5BalanceInfo {
  balance: number | null
  riskPct: number
  commissionPerLot: number
}

export async function getMt5Balance(): Promise<Mt5BalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/mt5-balance`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch MT5 balance')
  return res.json()
}

export async function setMt5Balance(data: { balance?: number | null; riskPct?: number; commissionPerLot?: number }): Promise<Mt5BalanceInfo> {
  const res = await fetch(`${BASE}/api/settings/mt5-balance`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function testNotification(data?: { telegramBotToken?: string, telegramChatId?: string }): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${BASE}/api/settings/test-notification`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data || {}),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ===================== Ticker Mappings =====================

export interface TickerMapping {
  id: number
  fromTicker: string
  toSymbol: string
  priceMultiplier: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export async function getTickerMappings(): Promise<TickerMapping[]> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch ticker mappings')
  return res.json()
}

export async function createTickerMapping(data: { fromTicker: string, toSymbol: string, priceMultiplier: number, notes?: string }): Promise<TickerMapping> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function updateTickerMapping(id: number, data: Partial<{ fromTicker: string, toSymbol: string, priceMultiplier: number, notes: string }>): Promise<TickerMapping> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function deleteTickerMapping(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/settings/ticker-mappings/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete ticker mapping')
}

export async function executeSignal(signalId: number): Promise<{ success: boolean; positionId?: number; error?: string }> {
  const res = await fetch(`${BASE}/api/trading/execute`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ signalId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
