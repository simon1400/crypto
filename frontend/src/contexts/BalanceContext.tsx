import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { getVirtualBalance, VirtualBalanceInfo } from '../api/client'

export interface BudgetSummary {
  balance: number
  start: number
  pnl: number
  roiPct: number
}

interface BalanceContextValue {
  budget: BudgetSummary | null
  refresh: () => void
}

const BalanceContext = createContext<BalanceContextValue>({ budget: null, refresh: () => {} })

export function BalanceProvider({ children }: { children: ReactNode }) {
  const [budget, setBudget] = useState<BudgetSummary | null>(null)

  const refresh = () => {
    getVirtualBalance()
      .then((info: VirtualBalanceInfo) =>
        setBudget({ balance: info.balance, start: info.start, pnl: info.pnl, roiPct: info.roiPct }),
      )
      .catch(err => console.error('[BalanceProvider] Failed to fetch virtual balance:', err))
  }

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <BalanceContext.Provider value={{ budget, refresh }}>
      {children}
    </BalanceContext.Provider>
  )
}

export function useBalance() {
  return useContext(BalanceContext)
}
