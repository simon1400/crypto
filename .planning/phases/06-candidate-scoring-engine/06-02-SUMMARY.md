---
phase: 06-candidate-scoring-engine
plan: 02
subsystem: scanner/scoring
tags: [scoring, execution-type, limit-plan, levelClusterer, 4D-scoring, candidate-ranking]
dependency_graph:
  requires: [06-01]
  provides: [generateLimitPlan-rewritten, null-limitPlan-fallback, WAIT_CONFIRMATION-downgrade]
  affects: [scanner/scoring/executionType.ts, scanner/scoring/index.ts]
tech_stack:
  added: []
  patterns: [levelClusterer-integration, 4D-candidate-ranking, nullable-return-fallback]
key_files:
  created: []
  modified:
    - backend/src/scanner/scoring/executionType.ts
    - backend/src/scanner/scoring/index.ts
decisions:
  - generateLimitPlan returns LimitEntryPlan | null — null when no candidate passes 0.3-2.0 ATR hard filter
  - null limitPlan causes WAIT_CONFIRMATION downgrade (not silent failure)
  - takeProfits cast to { price, rr, close_pct }[] to satisfy scoreCandidate signature (safe — runtime objects always have close_pct from calculateStandardizedExits)
metrics:
  duration: "~5 minutes"
  completed: "2026-04-13T09:25:00Z"
  tasks_completed: 2
  files_changed: 2
---

# Phase 06 Plan 02: generateLimitPlan Rewrite Summary

**One-liner:** Rewrote generateLimitPlan() to use levelClusterer.collectLevels() for deep candidate collection and scoreCandidate() 4D ranking instead of hardcoded proximity-biased zone selection.

## What Was Built

### Task 1: executionType.ts — generateLimitPlan Rewrite

Rewrote `backend/src/scanner/scoring/executionType.ts`:

1. **Added imports**: `collectLevels`, `clusterLevels`, `calcFillProbability` from levelClusterer; `scoreCandidate` from candidateScoring; `EntryCandidate` from types.

2. **Deleted `boostConfluence()`** — 22-line function that manually boosted weights for nearby zones. Replaced by cluster-based confluence from `clusterLevels()`.

3. **Rewrote `generateLimitPlan()`** — new return type is `LimitEntryPlan | null`:
   - Step 1: `collectLevels(indicators, type)` — collects all deep levels (4h, 1h, 15m) including EMA50 1H, Fib 0.618/0.5, EMA20/50 4H, BB Lower/Upper 4H, Pivot S1/S2 4H
   - Step 2: `clusterLevels(levels, price)` — groups nearby levels into clusters
   - Step 3: `scoreCandidate(cluster, type, indicators, stopLoss, takeProfits)` for each cluster
   - Step 4: Sort by `final_score` descending, return null if empty
   - Best candidate becomes preferred entry with scoring info in explanation

4. **Kept unchanged**: `selectExecutionType()`, `generateMarketPlan()`, `maybeDowngradeExecution()`.

### Task 2: index.ts — Null limitPlan Fallback

Updated `backend/src/scanner/scoring/index.ts`:

- Changed `const limitPlan` to `let limitPlan`
- Added `let finalExecutionType = executionType`
- Guard: `if (isLimit && !limitPlan)` → logs `[Scoring] ... no limit candidates passed 4D scoring, downgrading to WAIT_CONFIRMATION` and sets `finalExecutionType = 'WAIT_CONFIRMATION'`
- `finalExecutionType` used in `buildSignalExplanation()` call and in the returned `EnrichedSignal.execution_type`

## Deviations from Plan

**1. [Rule 2 - Type Safety] takeProfits cast for scoreCandidate**
- **Found during:** Task 1
- **Issue:** `generateLimitPlan` receives `{ price, rr }[]` but `scoreCandidate` expects `{ price, rr, close_pct }[]`
- **Fix:** Cast `takeProfits as { price: number; rr: number; close_pct: number }[]` at call site — safe because at runtime the objects always come from `calculateStandardizedExits()` which does include `close_pct`
- **Files modified:** `backend/src/scanner/scoring/executionType.ts`

## Known Stubs

None. All logic is fully implemented.

## Self-Check: PASSED

- `backend/src/scanner/scoring/executionType.ts` modified (commit 7f7585a)
- `backend/src/scanner/scoring/index.ts` modified (commit 8f2ce6a)
- `boostConfluence` not found in executionType.ts
- `collectLevels`, `clusterLevels`, `scoreCandidate` all present in executionType.ts
- `finalExecutionType` appears 4 times in index.ts
- `isLimit && !limitPlan` guard present
- TypeScript compiles with zero errors (both before and after each task)
- candidateScoring.ts has 6 exported functions (unchanged from plan 01)
