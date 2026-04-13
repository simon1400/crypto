import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { getBudget, BudgetStatus } from '../api/client'

interface BalanceContextValue {
  budget: BudgetStatus | null
  refresh: () => void
}

const BalanceContext = createContext<BalanceContextValue>({ budget: null, refresh: () => {} })

export function BalanceProvider({ children }: { children: ReactNode }) {
  const [budget, setBudget] = useState<BudgetStatus | null>(null)

  const refresh = () => {
    getBudget().then(setBudget).catch(err => console.error('[BalanceProvider] Failed to fetch budget:', err))
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
