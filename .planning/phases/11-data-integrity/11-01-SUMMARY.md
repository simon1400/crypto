---
phase: 11-data-integrity
plan: 01
subsystem: database
tags: [prisma, transactions, mfe-mae, scanner, data-integrity, batching]

# Dependency graph
requires: []
provides:
  - Atomic deleteMany+create for tryMergeEntryPair in scannerTracker (prisma.$transaction)
  - Atomic deleteMany+create for merge-entry route in entry.ts (prisma.$transaction)
  - Atomic position.update+orderLog.create for handleEntryOrderUpdate in positionManager
  - Batched MFE/MAE updates via single $transaction per tracker tick
affects: [12-frontend-resilience]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "prisma.$transaction(async (tx) => { ... }) for interactive multi-step atomic DB operations"
    - "prisma.$transaction(array.map(...)) for sequential independent batch updates"
    - "Accumulator pattern: collect pendingMfeUpdates[], flush after loop"

key-files:
  created: []
  modified:
    - backend/src/services/scannerTracker.ts
    - backend/src/routes/scanner/entry.ts
    - backend/src/trading/positionManager.ts

key-decisions:
  - "logOrderAction kept outside $transaction in positionManager — it uses module-level prisma, not injectable; inline tx.orderLog.create used instead for the critical ORDER_FILLED path"
  - "MFE/MAE batch uses array-form $transaction (independent updates) not interactive callback"
  - "External Bybit API call (placeTpOrders) stays outside transaction — cannot participate in DB transaction"

patterns-established:
  - "Pattern: multi-step DB mutations always wrapped in prisma.$transaction callback"
  - "Pattern: per-tick N+1 updates replaced with accumulator array flushed in single $transaction"

requirements-completed: [DATA-01, DATA-04]

# Metrics
duration: 12min
completed: 2026-04-13
---

# Phase 11 Plan 01: Data Integrity - Atomic Transactions + Batched MFE/MAE Summary

**Prisma $transaction wrappers for three multi-step delete+create operations and O(n)→O(1) MFE/MAE batching via accumulator pattern**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-13T14:15:00Z
- **Completed:** 2026-04-13T14:27:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- All deleteMany+create pairs in tryMergeEntryPair and merge-entry route are now atomic — no partial state possible if create fails after deleteMany
- handleEntryOrderUpdate wraps position.update + orderLog.create in a single $transaction ensuring both succeed or neither does
- MFE/MAE updates reduced from N individual `prisma.trade.update` calls per tick to a single batched `$transaction` after the main loop

## Task Commits

Each task was committed atomically:

1. **Task 1: Wrap multi-step DB ops in prisma.$transaction (DATA-01)** - `ef822e2` (feat)
2. **Task 2: Batch MFE/MAE updates into single $transaction per tick (DATA-04)** - `7034024` (perf)

**Plan metadata:** `(pending docs commit)` (docs: complete plan)

## Files Created/Modified
- `backend/src/services/scannerTracker.ts` - Added $transaction for tryMergeEntryPair + pendingMfeUpdates batch flush
- `backend/src/routes/scanner/entry.ts` - Added $transaction for merge-entry deleteMany+create
- `backend/src/trading/positionManager.ts` - Added $transaction for position.update+orderLog in handleEntryOrderUpdate

## Decisions Made
- `logOrderAction` uses module-level `prisma` client internally — rather than refactoring the helper to accept an optional `tx` parameter (broader change), the ORDER_FILLED path inlines `tx.orderLog.create` directly inside the $transaction callback, keeping the log atomic with the position update
- The TP order placement (Bybit API call) is deliberately kept outside the transaction since external I/O cannot participate in a DB transaction
- MFE/MAE batch uses the array form of $transaction (all updates independent) which is appropriate since each update targets a different trade.id

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 11-02 (next plan) can proceed — data integrity layer is now in place for all multi-step scanner operations
- No blockers

---
*Phase: 11-data-integrity*
*Completed: 2026-04-13*
