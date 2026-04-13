---
phase: 09-execution-reclassification
plan: "01"
subsystem: scanner/scoring
tags: [execution-type, enter-now, wait-for-pullback, limit-reclassification]
dependency_graph:
  requires: [phase-06-candidateScoring, phase-07-generateLimitPlan, phase-08-integrityMonitor]
  provides: [WAIT_FOR_PULLBACK_types, stricter_ENTER_NOW, ENTER_NOW_to_LIMIT_reclassification]
  affects: [scanner/scoring/types.ts, scanner/scoring/executionType.ts, scanner/scoring/index.ts, frontend/components/scanner/constants.ts]
tech_stack:
  added: []
  patterns: [collectLevels+clusterLevels inline heuristic for structural level detection, totalWeight threshold for level strength]
key_files:
  created: []
  modified:
    - backend/src/scanner/scoring/types.ts
    - backend/src/scanner/scoring/executionType.ts
    - backend/src/scanner/scoring/index.ts
    - frontend/src/components/scanner/constants.ts
decisions:
  - "WAIT_FOR_PULLBACK = valid setup but price not in optimal zone — informational with optional limit plan"
  - "ENTER_NOW->LIMIT reclassification uses totalWeight >= 14 inline heuristic, NOT scoreCandidate()"
  - "READY + trigger < 4/4 is no longer ENTER_NOW — becomes LIMIT or WAIT_FOR_PULLBACK per distance"
  - "WAIT_FOR_PULLBACK without limit candidates stays as-is, does NOT downgrade to WAIT_CONFIRMATION"
  - "Frontend orange badge for WAIT_FOR_PULLBACK (distinct from blue WAIT_CONFIRMATION and yellow LIMIT)"
metrics:
  duration: 480s
  completed: "2026-04-13"
  tasks: 2
  files: 4
---

# Phase 09 Plan 01: Execution Reclassification Summary

**One-liner:** Stricter ENTER_NOW gates (A_PLUS_READY OR READY+4/4+dist+impulse) with ENTER_NOW→LIMIT reclassification via structural level heuristic and new WAIT_FOR_PULLBACK type for valid-but-not-optimal setups.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add WAIT_FOR_PULLBACK types and reclassify selectExecutionType | ab84a07 | types.ts, executionType.ts, constants.ts |
| 2 | Wire WAIT_FOR_PULLBACK in scoring pipeline | 88e4d37 | index.ts |

## What Was Built

### New ExecutionType values (D-04)
- `WAIT_FOR_PULLBACK_LONG` and `WAIT_FOR_PULLBACK_SHORT` added to union in `types.ts`
- Russian labels: "Ждать откат для LONG" / "Ждать откат для SHORT"
- Orange badge style in frontend `constants.ts` (distinct from blue WAIT_CONFIRMATION)

### Stricter ENTER_NOW gate (D-01, D-02)
`selectExecutionType()` in `executionType.ts` now only assigns ENTER_NOW when:
- Category is `A_PLUS_READY` (setupScore >= 72), OR
- Category is `READY` AND trigger score == 4/4 (previously just "passed" >= 3/4) AND dist <= 0.35 AND impulse <= 0.6

READY + trigger 3/4 was previously ENTER_NOW; it now falls through to LIMIT or WAIT_FOR_PULLBACK.

### ENTER_NOW → LIMIT reclassification (D-03)
If `canEnterNow` is true, inline heuristic checks for strong structural level nearby:
- Calls `collectLevels(indicators, type)` + `clusterLevels(levels, price)` 
- For each cluster: `dist = abs(cluster.price - price) / atr1h`
- If `dist >= 0.5 && dist <= 1.0 && cluster.totalWeight >= 14` → reclassify to LIMIT
- Uses raw `totalWeight` from cluster (NOT `scoreCandidate()` which requires stopLoss/takeProfits params)

### WAIT_FOR_PULLBACK assignment logic
- `setupValid && entryTrigger.passed && score < 4` with extended distance/impulse → WAIT_FOR_PULLBACK
- `setupValid && !entryTrigger.passed` → WAIT_FOR_PULLBACK (valid setup, trigger not hit yet)

### Scoring pipeline (D-05)
- `isWaitPullback` flag alongside `isLimit` and `isMarket`
- `generateLimitPlan()` called for both LIMIT and WAIT_FOR_PULLBACK (shows suggested pullback level)
- WAIT_FOR_PULLBACK without limit candidates stays as WAIT_FOR_PULLBACK (informational signal)
- LIMIT without candidates still downgrades to WAIT_CONFIRMATION (existing behavior preserved)
- Distinct log line for WAIT_FOR_PULLBACK with suggested entry price

## Deviations from Plan

### Auto-added Missing Functionality

**[Rule 2 - Missing UI styles] Added WAIT_FOR_PULLBACK to frontend constants.ts**
- **Found during:** Task 1
- **Issue:** New ExecutionType values would render as blank/unstyled badge in frontend without constants entry
- **Fix:** Added WAIT_FOR_PULLBACK_LONG/SHORT with orange color scheme (`bg-orange-500/15`, `text-orange-400`) to EXECUTION_TYPE_STYLES in `frontend/src/components/scanner/constants.ts`
- **Files modified:** frontend/src/components/scanner/constants.ts
- **Commit:** ab84a07

## Known Stubs

None — all new execution type paths are fully implemented.

## Self-Check: PASSED

Files exist:
- backend/src/scanner/scoring/types.ts — FOUND
- backend/src/scanner/scoring/executionType.ts — FOUND
- backend/src/scanner/scoring/index.ts — FOUND
- frontend/src/components/scanner/constants.ts — FOUND

Commits exist:
- ab84a07 — FOUND (feat(09-01): add WAIT_FOR_PULLBACK types...)
- 88e4d37 — FOUND (feat(09-01): wire WAIT_FOR_PULLBACK in scoring pipeline)
