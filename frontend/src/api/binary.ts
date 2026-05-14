import { BASE, getHeaders } from './base'

export type SignalDirection = 'CALL' | 'PUT'
export type SignalOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING'
export type UserOutcome = 'WIN' | 'LOSS' | 'RECOVERY' | 'SKIPPED' | null

export interface ForexSignal {
  id: string
  symbol: string
  direction: SignalDirection
  entryPrice: number
  signalAt: number
  expiresAt: number
  bbUpper: number
  bbLower: number
  bbMiddle: number
  outcome: SignalOutcome
  exitPrice?: number
  userOutcome?: UserOutcome
  userMarkedAt?: number
}

export interface ForexSymbolState {
  symbol: string
  lastPrice: number | null
  lastCandleClose: number | null
  lastCandleTs: number | null
  bbUpper: number | null
  bbLower: number | null
  bbMiddle: number | null
  activeSignal: ForexSignal | null
  hasFreshTrigger: boolean
  lastError?: string
}

export interface ForexUserStats {
  totalMarked: number
  wins: number
  losses: number
  recoveries: number
  winRate: number
  currentLossStreak: number
}

export interface ForexSnapshot {
  serverTime: number
  symbols: ForexSymbolState[]
  active: ForexSignal[]
  history: ForexSignal[]
  stats: {
    total: number
    wins: number
    losses: number
    ties: number
    winRate: number
    payoutEV: number
  }
  userStats: ForexUserStats
}

export async function getForexState(): Promise<ForexSnapshot> {
  const res = await fetch(`${BASE}/api/binary/forex`, { headers: getHeaders() })
  if (!res.ok) throw new Error(`getForexState ${res.status}`)
  return res.json()
}

export async function markForexSignal(id: string, outcome: UserOutcome): Promise<void> {
  const res = await fetch(`${BASE}/api/binary/forex/mark`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ id, outcome }),
  })
  if (!res.ok) throw new Error(`markForexSignal ${res.status}`)
}
