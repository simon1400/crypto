---
phase: 12-frontend-resilience
plan: 01
subsystem: ui
tags: [react, typescript, context, type-safety]

# Dependency graph
requires: []
provides:
  - "Typed ScannerCoinIndicators, ScannerIndicators, ScannerMarketContext, OrderLogDetails interfaces in api/client.ts"
  - "BalanceProvider React Context with single 15s polling interval"
  - "useBalance() hook consumed by Navbar and Positions"
affects: [scanner, positions, navbar, order-log]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "React Context for shared polling state (BalanceContext)"
    - "Typed Record<string, unknown> for dynamic JSON shapes instead of any"

key-files:
  created:
    - frontend/src/contexts/BalanceContext.tsx
  modified:
    - frontend/src/api/client.ts
    - frontend/src/components/OrderLogTable.tsx
    - frontend/src/pages/Scanner.tsx
    - frontend/src/App.tsx
    - frontend/src/components/Navbar.tsx
    - frontend/src/pages/Positions.tsx

key-decisions:
  - "Cast mc to any in Scanner.tsx CSV export block — exploratory access of optional nested fields; typed at boundary (ScannerMarketContext) is sufficient"
  - "OrderLogDetails uses index signature [key: string]: unknown to allow pnl and other optional fields not in the base type"

patterns-established:
  - "BalanceContext pattern: shared polling state via createContext + useContext, single interval in Provider"
  - "ScannerMarketContext: typed boundary with index signature for extensibility across signal sources"

requirements-completed: [FE-03, FE-04]

# Metrics
duration: 15min
completed: 2026-04-13
---

# Phase 12 Plan 01: Frontend Resilience - Type Safety and Balance Context Summary

**Replaced `any` on ScannerSignal.indicators/marketContext and OrderLogEntry.details with typed interfaces; consolidated duplicate balance polling into a single BalanceContext with 15s interval**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-13T14:30:00Z
- **Completed:** 2026-04-13T14:45:00Z
- **Tasks:** 2
- **Files modified:** 6 (1 created)

## Accomplishments
- Added `ScannerCoinIndicators`, `ScannerIndicators`, `ScannerMarketContext`, `OrderLogDetails` interfaces to `api/client.ts`
- Eliminated `any` on the three highest-traffic interfaces (ScannerSignal.indicators, marketContext, OrderLogEntry.details)
- Created `BalanceContext.tsx` with `BalanceProvider` + `useBalance()` hook, single 15s polling replacing two separate polls
- Navbar and Positions now read from shared context — no duplicate getBudget/getBalance calls

## Task Commits

Each task was committed atomically:

1. **Task 1: Add typed interfaces for ScannerSignal and OrderLogEntry fields** - `cb3a236` (feat)
2. **Task 2: Create BalanceContext and wire into Navbar + Positions** - `67e6473` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `frontend/src/contexts/BalanceContext.tsx` - New: BalanceProvider with 15s interval, useBalance hook
- `frontend/src/api/client.ts` - Added ScannerCoinIndicators, ScannerIndicators, ScannerMarketContext, OrderLogDetails; replaced any fields
- `frontend/src/components/OrderLogTable.tsx` - Removed `as any` casts; access details fields via typed interface
- `frontend/src/pages/Scanner.tsx` - Fixed filter callback type; cast mc to any only in CSV export block
- `frontend/src/App.tsx` - Wrapped AppLayout with BalanceProvider
- `frontend/src/components/Navbar.tsx` - Replaced getBudget polling with useBalance()
- `frontend/src/pages/Positions.tsx` - Replaced getBalance useEffect with useBalance()

## Decisions Made
- Cast `mc` to `any` in Scanner.tsx CSV export block: the code does exploratory dynamic access of optional nested fields across different signal source shapes — typing the boundary (ScannerMarketContext) is the right level; the CSV export is legitimately `any`-safe.
- Added `[key: string]: unknown` index signature to `OrderLogDetails` to accommodate `pnl` and other optional fields present at runtime but not in the base type.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript errors from ScannerMarketContext nested field access in CSV export**
- **Found during:** Task 1 (typing marketContext)
- **Issue:** Scanner.tsx CSV export accesses `mc.funding.fundingRate` and `mc.oi.oiChangePct1h` — these became `unknown` after typing, breaking arithmetic operations
- **Fix:** Changed `const mc = s.marketContext || {} as any` to `const mc = (s.marketContext as any) || {}` in the CSV export block, scoping the `any` cast narrowly
- **Files modified:** frontend/src/pages/Scanner.tsx
- **Verification:** `npx tsc --noEmit` passes clean
- **Committed in:** cb3a236 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug from typing)
**Impact on plan:** Necessary to resolve TypeScript errors introduced by the typing change. No scope creep.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Type safety foundations in place for scanner interfaces
- BalanceContext ready to extend (add `lastUpdated`, `error` state if needed)
- Plan 12-02 can proceed without blockers

---
*Phase: 12-frontend-resilience*
*Completed: 2026-04-13*
