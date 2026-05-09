/**
 * Top-level Breakout page wrapping two paper-trader variants in tabs.
 *
 *   - Tab A: legacy prod (10 conc, 10% target margin, $500 starting deposit)
 *   - Tab B: parallel experiment (20 conc, 5% target margin, $320 starting deposit)
 *
 * Both tabs render the same BreakoutPaper component with a different `variant`
 * prop. UI changes apply to both tabs simultaneously by virtue of being the
 * same component. Backend isolation is via /api/breakout-paper vs
 * /api/breakout-paper-b — see breakoutVariant.ts on the backend.
 */

import { useState, useEffect } from 'react'
import BreakoutPaper from './BreakoutPaper'
import type { BreakoutVariant } from '../api/breakoutPaper'

const STORAGE_KEY = 'breakout_active_variant'

export default function BreakoutPage() {
  const [variant, setVariant] = useState<BreakoutVariant>(() => {
    if (typeof window === 'undefined') return 'A'
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'B' ? 'B' : 'A'
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, variant) } catch {}
  }, [variant])

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4 border-b border-input pb-3">
        <div className="flex items-center gap-2">
          <TabButton active={variant === 'A'} onClick={() => setVariant('A')}>
            A · 10 conc · 10% margin
          </TabButton>
          <TabButton active={variant === 'B'} onClick={() => setVariant('B')}>
            B · 20 conc · 5% margin
          </TabButton>
        </div>
        <span className="sm:ml-3 text-xs text-text-secondary">
          Обе копии работают параллельно на одних и тех же сигналах. Sizing независимый.
        </span>
      </div>
      {/* `key` forces a fresh BreakoutPaper instance per variant so all internal
          state (selected trade, expanded panels, pagination, etc.) stays separate
          between A and B — flipping the tab feels like opening a different page. */}
      <BreakoutPaper key={variant} variant={variant} />
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 sm:px-4 py-2 rounded-t font-medium text-xs sm:text-sm whitespace-nowrap transition-colors ${
        active
          ? 'bg-accent text-bg-primary'
          : 'bg-card border border-input text-text-secondary hover:text-text-primary hover:bg-input'
      }`}
    >
      {children}
    </button>
  )
}
