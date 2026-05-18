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
import BreakoutLiveCPanel from './BreakoutLiveCPanel'
import type { BreakoutVariant } from '../api/breakoutPaper'

// LIVE = variant C running on real Binance. Stored as separate tab key — does NOT
// share state with paper C.
type TabKey = BreakoutVariant | 'C_LIVE'

const STORAGE_KEY = 'breakout_active_variant'

export default function BreakoutPage() {
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window === 'undefined') return 'A'
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'B' || saved === 'C' || saved === 'C_LIVE') return saved
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
          <TabButton active={tab === 'C_LIVE'} onClick={() => setTab('C_LIVE')} accent="live">
            C·LIVE
          </TabButton>
        </div>
      </div>
      <p className="sm:hidden text-xs text-text-secondary mt-3 mb-4">
        Три копии параллельно на одних сигналах. A/B — market, C — limit на rangeEdge (maker, без slip).
        C·LIVE — реальная Binance.
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
          <TabButton active={tab === 'C_LIVE'} onClick={() => setTab('C_LIVE')} accent="live">
            C · LIVE
          </TabButton>
        </div>
        <span className="text-xs text-text-secondary ml-2">
          A/B/C — paper. C·LIVE — реальная торговля на Binance Futures.
        </span>
      </div>
      {/* `key` forces a fresh component per tab so all internal state stays separate. */}
      {tab === 'C_LIVE'
        ? <BreakoutLiveCPanel key="C_LIVE" />
        : <BreakoutPaper key={tab} variant={tab} />}
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
