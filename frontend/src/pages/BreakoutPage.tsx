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

// LIVE = the variant C twin running on real Binance. Same UI shell as paper
// variants A/B/C — BreakoutPaper component just routes to /api/breakout-live-c
// when variant === 'LIVE' and hides destructive paper-only controls.
type TabKey = BreakoutVariant

const STORAGE_KEY = 'breakout_active_variant'

export default function BreakoutPage() {
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window === 'undefined') return 'A'
    const saved = localStorage.getItem(STORAGE_KEY)
    // Accept legacy 'C_LIVE' value from before we collapsed LIVE into BreakoutPaper.
    if (saved === 'C_LIVE') return 'LIVE'
    if (saved === 'B' || saved === 'C' || saved === 'LIVE') return saved
    return 'A'
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, tab) } catch {}
  }, [tab])

  return (
    <div>
      {/* Mobile: sticky tabs */}
      <div className="sm:hidden sticky top-0 z-30 -mx-4 bg-primary border-b border-input py-2">
        <div className="flex items-stretch gap-0">
          <TabButton active={tab === 'A'} onClick={() => setTab('A')}>
            A <span className="opacity-70">· 10·10%</span>
          </TabButton>
          <TabButton active={tab === 'B'} onClick={() => setTab('B')}>
            B <span className="opacity-70">· 20·5%</span>
          </TabButton>
          <TabButton active={tab === 'C'} onClick={() => setTab('C')}>
            C <span className="opacity-70">· limit</span>
          </TabButton>
          <TabButton active={tab === 'LIVE'} onClick={() => setTab('LIVE')} accent="live">
            LIVE
          </TabButton>
        </div>
      </div>
      <p className="sm:hidden text-xs text-text-secondary mt-3 mb-4">
        Три копии параллельно на одних сигналах. A/B — market, C — limit на rangeEdge (maker, без slip).
        LIVE — реальная Binance.
      </p>

      {/* Desktop: inline tabs + caption */}
      <div className="hidden sm:flex flex-wrap items-center gap-2 mb-4 border-b border-input pb-3">
        <div className="flex items-center gap-1.5">
          <TabButton active={tab === 'A'} onClick={() => setTab('A')}>
            A <span className="opacity-70">· 10·10%</span>
          </TabButton>
          <TabButton active={tab === 'B'} onClick={() => setTab('B')}>
            B <span className="opacity-70">· 20·5%</span>
          </TabButton>
          <TabButton active={tab === 'C'} onClick={() => setTab('C')}>
            C <span className="opacity-70">· limit edge</span>
          </TabButton>
          <TabButton active={tab === 'LIVE'} onClick={() => setTab('LIVE')} accent="live">
            LIVE
          </TabButton>
        </div>
        <span className="text-xs text-text-secondary ml-2">
          A/B/C — paper. LIVE — реальная торговля на Binance Futures (копия C).
        </span>
      </div>
      {/* `key` forces a fresh component per tab so all internal state stays separate. */}
      <BreakoutPaper key={tab} variant={tab} />
    </div>
  )
}

function TabButton({ active, onClick, children, accent }: { active: boolean; onClick: () => void; children: React.ReactNode; accent?: 'live' }) {
  const liveActive = accent === 'live' && active
  const liveInactive = accent === 'live' && !active
  return (
    <button
      onClick={onClick}
      className={`flex-1 sm:flex-none px-3 sm:px-4 py-2.5 sm:py-2 sm:rounded-t font-medium text-xs sm:text-sm whitespace-nowrap transition-colors ${
        liveActive
          ? 'bg-short text-white'
          : liveInactive
            ? 'bg-card text-short hover:bg-short/10 sm:border sm:border-short/40'
            : active
              ? 'bg-accent text-bg-primary'
              : 'bg-card text-text-secondary hover:text-text-primary hover:bg-input sm:border sm:border-input'
      }`}
    >
      {children}
    </button>
  )
}
