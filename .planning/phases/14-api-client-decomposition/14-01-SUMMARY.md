---
phase: 14-api-client-decomposition
plan: 01
subsystem: api
tags: [typescript, react, api-client, refactoring, barrel-export]

# Dependency graph
requires: []
provides:
  - frontend/src/api/base.ts — shared auth infrastructure (BASE, setAuthToken, getHeaders)
  - frontend/src/api/signals.ts — Signal domain functions and types
  - frontend/src/api/trades.ts — Trade domain functions and types
  - frontend/src/api/scanner.ts — Scanner domain functions and types
  - frontend/src/api/settings.ts — Settings domain functions and types
  - frontend/src/api/positions.ts — Positions domain functions and types
  - frontend/src/api/klines.ts — Klines functions and types
  - frontend/src/api/client.ts — barrel re-export for backward compatibility
affects: [scanner-decomposition, signals-decomposition, trades-decomposition, settings-decomposition]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Domain-scoped API modules: each domain (signals/trades/scanner/settings/positions/klines) owns its types and functions"
    - "Barrel re-export pattern: client.ts aggregates all domains via export * for backward compatibility"
    - "Cross-domain imports: scanner imports Trade from trades.ts; positions imports Signal from signals.ts"

key-files:
  created:
    - frontend/src/api/base.ts
    - frontend/src/api/signals.ts
    - frontend/src/api/trades.ts
    - frontend/src/api/scanner.ts
    - frontend/src/api/settings.ts
    - frontend/src/api/positions.ts
    - frontend/src/api/klines.ts
  modified:
    - frontend/src/api/client.ts

key-decisions:
  - "OrderLogDetails moved to positions.ts (consumer is OrderLogEntry in positions, not scanner)"
  - "scanner.ts imports Trade type from trades.ts for takeSignalAsTrade and takeEntry return types"
  - "positions.ts imports Signal type from signals.ts for BybitPosition.signal field"
  - "client.ts becomes pure barrel re-export preserving all existing import paths"

patterns-established:
  - "Domain modules import shared auth from base.ts, not directly from client.ts"
  - "Cross-domain type imports use import type to avoid circular dependencies"

requirements-completed: [API-01, API-02]

# Metrics
duration: 4min
completed: 2026-04-13
---

# Phase 14 Plan 01: API Client Decomposition Summary

**Split 1292-line monolithic client.ts into 7 domain modules (base, signals, trades, scanner, settings, positions, klines) with barrel re-export preserving all existing import paths**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-13T18:55:42Z
- **Completed:** 2026-04-13T18:59:30Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Created 7 domain-scoped API modules with clean separation of concerns
- Transformed client.ts from 1292-line monolith into 9-line barrel re-export
- tsc --noEmit passes with zero errors; Vite production build succeeds
- All existing `import { X } from '../api/client'` paths remain intact

## Task Commits

Each task was committed atomically:

1. **Task 1: Create 7 domain modules from client.ts** - `0b313e3` (feat)
2. **Task 2: Transform client.ts into barrel re-export and verify build** - `471c9b7` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `frontend/src/api/base.ts` — shared auth: BASE, setAuthToken, getHeaders (14 lines)
- `frontend/src/api/signals.ts` — Signal, SignalsResponse, getSignals, syncSignals, clearSignals, getSignal (64 lines)
- `frontend/src/api/trades.ts` — Trade, TradeClose, TradeTP, TradesResponse, TradeStats, TradeLive + 14 functions (221 lines)
- `frontend/src/api/scanner.ts` — all scanner interfaces and 22 functions including SSE streaming (631 lines)
- `frontend/src/api/settings.ts` — SettingsResponse, BudgetStatus, VirtualBalanceInfo, TickerMapping + 13 functions (187 lines)
- `frontend/src/api/positions.ts` — OrderLogDetails, BybitPosition, PnlStats, OrderLogEntry, KillSwitchResponse, CoinStat + 8 functions (151 lines)
- `frontend/src/api/klines.ts` — KlineData, KlinesResponse, getKlines (30 lines)
- `frontend/src/api/client.ts` — reduced to 9-line barrel re-export

## Decisions Made
- OrderLogDetails moved to positions.ts (its only consumer is OrderLogEntry in positions, scanner defined it but didn't use it directly)
- scanner.ts imports `import type { Trade }` from trades.ts for takeSignalAsTrade and takeEntry return types
- positions.ts imports `import type { Signal }` from signals.ts for BybitPosition.signal field
- Cross-domain imports use `import type` to avoid runtime circular dependency issues

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
- Worktree lacked node_modules; symlinked from main repo to run tsc/vite build verification
- Pre-existing `ImportMeta.env` errors in worktree tsc run resolved by using symlinked node_modules (Vite types)

## Known Stubs
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 50+ functions and 30+ interfaces from original client.ts accessible via both `import { X } from '../api/client'` and `import { X } from '../api/signals'` etc.
- Future decomposition phases (Scanner.tsx, Signals.tsx, Trades.tsx) can now import directly from domain modules

---
*Phase: 14-api-client-decomposition*
*Completed: 2026-04-13*
