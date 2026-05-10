/**
 * Top-level Breakout page wrapping three paper-trader variants in tabs.
 *
 *   - Tab A: legacy prod (10 conc, 10% target margin, $500, taker market entry)
 *   - Tab B: parallel sizing experiment (20 conc, 5% margin, $320, taker market)
 *   - Tab C: limit-on-rangeEdge experiment (20 conc, 5% margin, $320, maker limit)
 *
 * All tabs render the same BreakoutPaper component with a different `variant`
 * prop. UI changes apply to all tabs simultaneously by virtue of being the
 * same component. Backend isolation is via /api/breakout-paper{,-b,-c} —
 * see breakoutVariant.ts on the backend.
 */

import { useState, useEffect } from 'react'
import BreakoutPaper from './BreakoutPaper'
import type { BreakoutVariant } from '../api/breakoutPaper'

const STORAGE_KEY = 'breakout_active_variant'

export default function BreakoutPage() {
  const [variant, setVariant] = useState<BreakoutVariant>(() => {
    if (typeof window === 'undefined') return 'A'
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'B' || saved === 'C') return saved
    return 'A'
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, variant) } catch {}
  }, [variant])

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4 border-b border-input pb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <TabButton active={variant === 'A'} onClick={() => setVariant('A')}>
            A <span className="opacity-70">· 10·10%</span>
          </TabButton>
          <TabButton active={variant === 'B'} onClick={() => setVariant('B')}>
            B <span className="opacity-70">· 20·5%</span>
          </TabButton>
          <TabButton active={variant === 'C'} onClick={() => setVariant('C')}>
            C <span className="opacity-70">· limit edge</span>
          </TabButton>
        </div>
        <span className="text-xs text-text-secondary basis-full sm:basis-auto sm:ml-2">
          Три копии параллельно на одних сигналах. A/B — market, C — limit на rangeEdge (maker, без slip).
        </span>
      </div>
      {/* `key` forces a fresh BreakoutPaper instance per variant so all internal
          state (selected trade, expanded panels, pagination, etc.) stays separate
          between variants — flipping the tab feels like opening a different page. */}
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
