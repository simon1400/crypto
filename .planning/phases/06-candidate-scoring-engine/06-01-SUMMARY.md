---
phase: 06-candidate-scoring-engine
plan: 01
subsystem: scanner/scoring
tags: [scoring, types, candidate-scoring, hard-filter, 4D]
dependency_graph:
  requires: []
  provides: [candidateScoring, EntryCandidate, CandidateScore, CandidateFilterResult, LimitZoneSource-expanded]
  affects: [scanner/scoring/executionType.ts, scanner/scoring/types.ts]
tech_stack:
  added: []
  patterns: [hard-filter-weighted-sum-penalties, 4D-scoring]
key_files:
  created:
    - backend/src/scanner/scoring/candidateScoring.ts
  modified:
    - backend/src/scanner/scoring/types.ts
decisions:
  - Scoring uses hard filter → weighted sum (3,3,2,2) → penalty multipliers (NOT multiplicative)
  - Confluence clusters avoid x0.9 penalty, providing measurable advantage over isolated levels
  - scoreGeometryBonus computes R:R improvement vs market entry — limitRR minus marketRR
  - scoreSetupIntegrity starts at 8 and deducts for distance/structure/RSI risks
  - Zone width is ±0.15 ATR around cluster price (symmetric for both LONG and SHORT)
metrics:
  duration: "~2 minutes"
  completed: "2026-04-13T09:16:11Z"
  tasks_completed: 2
  files_changed: 2
---

# Phase 06 Plan 01: Candidate Scoring Types and Engine Summary

**One-liner:** 4D candidate scoring engine (structural_strength, geometry_bonus, fill_realism, setup_integrity) with hard filters (0.3-2.0 ATR), weighted sum (3,3,2,2), and penalty multipliers (x0.85 far, x0.9 no-confluence).

## What Was Built

### Task 1: types.ts — Expanded Types

Added to `backend/src/scanner/scoring/types.ts`:

1. **Expanded `LimitZoneSource` union** with 19 new deep level sources: `EMA50_1H`, `EMA20_4H`, `EMA50_4H`, `BB_LOWER_4H`, `BB_UPPER_4H`, `PIVOT_S1_4H`, `PIVOT_S2_4H`, `PIVOT_R1_4H`, `PIVOT_R2_4H`, `FIB_618`, `FIB_500`, `FIB_382`, `SUPPORT_4H`, `RESISTANCE_4H`, `VWAP_4H`, `BB_LOWER_1H`, `BB_UPPER_1H`, `PIVOT_S1_1H`, `PIVOT_R1_1H`, `CLUSTER`

2. **`CandidateScore` interface** — 4D scoring result with `structural_strength`, `geometry_bonus`, `fill_realism`, `setup_integrity`, `weighted_total`, `penalties_applied`, `final_score`

3. **`EntryCandidate` interface** — candidate entry level with price, zone, source, confluence_count, distance_atr, candidate_score, fill_category, integrity_estimate, rr_improvement

4. **`CandidateFilterResult` interface** — pass/fail with reason string

### Task 2: candidateScoring.ts — Scoring Engine

Created `backend/src/scanner/scoring/candidateScoring.ts` with:

- **`hardFilterCandidate()`** — rejects if distance < 0.3 ATR or > 2.0 ATR (SCORE-03)
- **`scoreStructuralStrength()`** — normalizes `totalWeight` from levelClusterer to 0-10; single level: `weight×10/9`, cluster: `totalWeight/2`
- **`scoreGeometryBonus()`** — computes R:R improvement vs market entry; maps to 0/2/4/6/8/10
- **`scoreFillRealism()`** — ATR-distance buckets: ≤0.5→9, ≤0.8→7, ≤1.0→6, ≤1.3→4, ≤1.5→3, ≤2.0→2
- **`scoreSetupIntegrity()`** — starts at 8, deducts for distance/structure/RSI overextension
- **`scoreCandidate()`** — main orchestrator returning `{ candidate, filtered }`

**Penalty logic:** Confluence clusters (2+ levels) avoid the x0.9 single-level penalty, giving them measurably higher `final_score` than isolated levels at the same distance. This directly implements SCORE-04.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All functions are fully implemented with real scoring logic.

## Self-Check: PASSED

- `backend/src/scanner/scoring/candidateScoring.ts` exists (commit c6a0033)
- `backend/src/scanner/scoring/types.ts` modified (commit 0fe80fa)
- TypeScript compiles with zero errors
- 6 exported functions in candidateScoring.ts
- All constants present: W_STRENGTH=3, MIN_DISTANCE_ATR=0.3, MAX_DISTANCE_ATR=2.0, FAR_DISTANCE_PENALTY=0.85, NO_CONFLUENCE_PENALTY=0.9
