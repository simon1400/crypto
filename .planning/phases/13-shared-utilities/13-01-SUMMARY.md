---
phase: 13-shared-utilities
plan: 01
subsystem: frontend-lib
tags: [typescript, utilities, validation, pnl, csv]

# Dependency graph
requires: []
provides:
  - "validateTakeProfits and defaultTpDistribution in frontend/src/lib/validation.ts"
  - "calcSignalPnl, calcPnlForecast, calcNetPnl, calcPnlPct, calcTpPnl in frontend/src/lib/pnl.ts"
  - "escapeCsvField and downloadCsv in frontend/src/lib/csvExport.ts"
affects: [NewTradeForm, TradeDetail, EntryResultCard, SignalTable, PositionCard, Trades, Signals, Scanner]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "lib/ utility modules with named exports (no default exports)"
    - "Extracted formulas as pure functions for reuse across pages"

key-files:
  created:
    - frontend/src/lib/validation.ts
    - frontend/src/lib/pnl.ts
    - frontend/src/lib/csvExport.ts
  modified: []

key-decisions:
  - "defaultTpDistribution hardcodes [40,30,30] for 3 TPs matching EntryResultCard source"
  - "downloadCsv separator option defaults to comma; Scanner/Trades callers pass semicolon"
  - "calcSignalPnl accepts inline interface matching Signal shape — no import dependency on api/client"

patterns-established:
  - "lib/ pure utility modules: no React imports, no side effects, named exports only"
  - "P&L formulas extracted as pure functions with explicit type parameters"

requirements-completed: [UTIL-01, UTIL-02, UTIL-03]

# Metrics
duration: 8min
completed: 2026-04-13
---

# Phase 13 Plan 01: Shared Utilities - Validation, P&L, and CSV Export Summary

**Three shared lib/ utility modules extracted from duplicated logic: TP validation, P&L calculations, and CSV export**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-13T15:00:56Z
- **Completed:** 2026-04-13T15:08:56Z
- **Tasks:** 3
- **Files created:** 3

## Accomplishments

- Created `frontend/src/lib/validation.ts` with `validateTakeProfits` (from NewTradeForm/TradeDetail) and `defaultTpDistribution` (from EntryResultCard)
- Created `frontend/src/lib/pnl.ts` with 5 pure functions: `calcSignalPnl`, `calcPnlForecast`, `calcNetPnl`, `calcPnlPct`, `calcTpPnl`
- Created `frontend/src/lib/csvExport.ts` with `escapeCsvField` (wrapping sanitizeCsvField) and `downloadCsv` (BOM + blob + anchor pattern)
- All formulas extracted verbatim from source files — no logic changes

## Task Commits

Each task was committed atomically:

1. **Task 1: Create lib/validation.ts with TP validation** - `5756d4a` (feat)
2. **Task 2: Create lib/pnl.ts with P&L calculations** - `4f5b3b7` (feat)
3. **Task 3: Create lib/csvExport.ts with generic CSV download** - `2e222cf` (feat)

## Files Created

- `frontend/src/lib/validation.ts` - TP validation with Russian error messages, defaultTpDistribution
- `frontend/src/lib/pnl.ts` - Signal PnL, forecast PnL, net PnL, pnl%, TP PnL calculations
- `frontend/src/lib/csvExport.ts` - BOM+blob+anchor CSV download with sanitization, configurable separator

## Decisions Made

- `calcSignalPnl` uses an inline interface rather than importing `Signal` from `api/client.ts` to keep pnl.ts dependency-free
- `downloadCsv` defaults separator to `','` matching Signals.tsx; Scanner.tsx and Trades.tsx will pass `';'` when wired in later phases
- `defaultTpDistribution` hardcodes the exact values from EntryResultCard ([40,30,30] for 3 TPs) with a general formula for 4+ TPs

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all three files are pure utility modules with no stub data or placeholder values.

## Self-Check: PASSED

- `frontend/src/lib/validation.ts` - FOUND
- `frontend/src/lib/pnl.ts` - FOUND
- `frontend/src/lib/csvExport.ts` - FOUND
- Commits 5756d4a, 4f5b3b7, 2e222cf - FOUND (verified via git log)
- No TypeScript errors in new files (verified via tsc --noEmit)
- No trailing semicolons in any file

---
*Phase: 13-shared-utilities*
*Completed: 2026-04-13*
