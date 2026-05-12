import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { getBreakoutPaperConfig, BreakoutVariant } from '../api/breakoutPaper'

export interface VariantBalance {
  variant: BreakoutVariant
  balance: number
  start: number
  pnl: number
  roiPct: number
}

interface BalanceContextValue {
  balances: VariantBalance[] | null
  refresh: () => void
}

const BalanceContext = createContext<BalanceContextValue>({ balances: null, refresh: () => {} })

const VARIANTS: BreakoutVariant[] = ['A', 'B', 'C']

export function BalanceProvider({ children }: { children: ReactNode }) {
  const [balances, setBalances] = useState<VariantBalance[] | null>(null)

  const refresh = () => {
    Promise.all(
      VARIANTS.map(v =>
        getBreakoutPaperConfig(v)
          .then(cfg => {
            const start = cfg.startingDepositUsd
            const balance = cfg.currentDepositUsd
            const pnl = balance - start
            const roiPct = start > 0 ? (pnl / start) * 100 : 0
            return { variant: v, balance, start, pnl, roiPct } as VariantBalance
          })
          .catch(err => {
            console.error(`[BalanceProvider] Failed to fetch variant ${v}:`, err)
            return null
          }),
      ),
    ).then(results => {
      const ok = results.filter((r): r is VariantBalance => r != null)
      setBalances(ok.length > 0 ? ok : null)
    })
  }

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <BalanceContext.Provider value={{ balances, refresh }}>
      {children}
    </BalanceContext.Provider>
  )
}

export function useBalance() {
  return useContext(BalanceContext)
}
