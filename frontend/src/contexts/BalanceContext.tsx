import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { getLiveStatus } from '../api/breakoutLiveC'

export interface LiveBalance {
  balance: number
  start: number
  pnl: number
  roiPct: number
}

interface BalanceContextValue {
  balance: LiveBalance | null
  refresh: () => void
}

const BalanceContext = createContext<BalanceContextValue>({ balance: null, refresh: () => {} })

export function BalanceProvider({ children }: { children: ReactNode }) {
  const [balance, setBalance] = useState<LiveBalance | null>(null)

  const refresh = () => {
    getLiveStatus()
      .then(st => {
        const start = st.baselineUsd ?? 0
        const balance = st.marginBalanceUsdt ?? st.walletBalanceUsdt ?? 0
        const pnl = st.totalPnlUsd ?? (start > 0 ? balance - start : 0)
        const roiPct = st.totalPnlPct ?? (start > 0 ? (pnl / start) * 100 : 0)
        setBalance({ balance, start, pnl, roiPct })
      })
      .catch(err => {
        console.error('[BalanceProvider] Failed to fetch LIVE status:', err)
        setBalance(null)
      })
  }

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <BalanceContext.Provider value={{ balance, refresh }}>
      {children}
    </BalanceContext.Provider>
  )
}

export function useBalance() {
  return useContext(BalanceContext)
}
