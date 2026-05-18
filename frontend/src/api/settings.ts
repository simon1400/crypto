import { BASE, getHeaders } from './base'

// ===================== Settings =====================

export interface SettingsResponse {
  apiKeyMasked: string | null
  apiSecretMasked: string | null
  hasKeys: boolean
  useTestnet: boolean
  balance: number | null
  // Binance Futures keys (Variant C live)
  binanceTestnetKeyMasked: string | null
  binanceTestnetSecretMasked: string | null
  binanceTestnetConfigured: boolean
  binanceLiveKeyMasked: string | null
  binanceLiveSecretMasked: string | null
  binanceLiveConfigured: boolean
  telegramBotToken: string | null
  telegramChatId: string | null
  telegramEnabled: boolean
  takerFeeRate: number
  makerFeeRate: number
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings`, { headers: getHeaders() })
  if (!res.ok) throw new Error('Failed to fetch settings')
  return res.json()
}

export async function saveSettings(data: Partial<SettingsResponse> & { apiKey?: string | null; apiSecret?: string | null }): Promise<SettingsResponse> {
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

// ===================== Binance Futures keys (Variant C live) =====================

export async function saveBinanceKeys(net: 'testnet' | 'live', apiKey: string, apiSecret: string): Promise<SettingsResponse & { binanceBalance?: string; binanceNet?: string }> {
  const res = await fetch(`${BASE}/api/settings/binance-keys`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ net, apiKey, apiSecret }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function deleteBinanceKeys(net: 'testnet' | 'live'): Promise<SettingsResponse> {
  const res = await fetch(`${BASE}/api/settings/binance-keys?net=${net}`, {
    method: 'DELETE',
    headers: getHeaders(),
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
