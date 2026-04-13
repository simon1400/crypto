---
phase: 07-multi-candidate-storage-ui
plan: 02
subsystem: frontend/scanner
tags: [candidates, scanner-ui, CandidateRow, UnifiedSignalCard]
dependency_graph:
  requires: [07-01]
  provides: [CandidateInfo, CandidateSetInfo, CandidateRow-component]
  affects: [frontend/src/api/client.ts, frontend/src/components/scanner/UnifiedSignalCard.tsx]
tech_stack:
  added: []
  patterns: [CandidateRow with role-based visual differentiation (preferred/secondary/deep)]
key_files:
  created: []
  modified:
    - frontend/src/api/client.ts
    - frontend/src/components/scanner/UnifiedSignalCard.tsx
decisions:
  - CandidateRow defined inline in UnifiedSignalCard (not a separate file) — component is small and tightly coupled
  - Candidates fallback to old limitEntryPlan display for backward compatibility with older saved signals
  - candidates wired from both s.candidates (scan result) and mc.limit_entry_plan.candidates (saved signal marketContext)
metrics:
  duration: 120s
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_modified: 2
---

# Phase 07 Plan 02: Scanner UI Candidate Display Summary

**One-liner:** UnifiedSignalCard now renders preferred/secondary/deep entry candidates with 4D score breakdown, fill category, ATR distance, and role-based visual differentiation (gold/gray/red).

## What Was Built

Added frontend display of all 3 entry candidates for each limit signal in the Scanner UI:

1. **Type interfaces in client.ts**: `CandidateScoreInfo`, `CandidateInfo`, `CandidateSetInfo` exported interfaces mirror the backend `EntryCandidate` / `EntryCandidateSet` types from Plan 07-01. `CandidateSetInfo` and `candidates` fields added to `ScanSignal.limit_entry_plan` and as a top-level `ScanSignal.candidates` field.

2. **CandidateRow component** added inside `UnifiedSignalCard.tsx` — renders a single candidate row with:
   - Role-based styling: preferred (gold/accent), secondary (muted gray), deep (red/short-tinted)
   - Price + source label, fill category (Likely/Possible/Unlikely with color), distance in ATR
   - 4D score breakdown: Score, Str, Geo, Fill, Int
   - R:R improvement shown when > 0
   - Confluence sources shown when confluence_count > 1
   - "Aggressive" warning text for deep role

3. **CardData.candidates field** wired in both `normalizeFromSaved` (reads `mc.limit_entry_plan?.candidates`) and `normalizeFromScan` (reads `s.candidates || s.limit_entry_plan?.candidates`).

4. **Backward-compatible fallback**: Old limit signals without candidates still render the original `data.limitEntryPlan` block (zone source + zone range + explanation).

## Decisions Made

- **Inline CandidateRow**: Defined before the export rather than in a separate component file — it's tightly bound to this card's design tokens and formatting helpers.
- **Dual read path**: `normalizeFromScan` tries `s.candidates` first (direct field added by Plan 07-01 to the enriched scan result), then falls back to `s.limit_entry_plan?.candidates` (for any intermediate data shape).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all fields read from real API data when available; fallback to old display when candidates absent.

## Self-Check

- [x] `frontend/src/api/client.ts` — CandidateSetInfo interface defined, candidates on ScanSignal
- [x] `frontend/src/components/scanner/UnifiedSignalCard.tsx` — CandidateRow component, CardData.candidates, normalizeFromSaved + normalizeFromScan wired
- [x] TypeScript compiles with zero errors (tsc --noEmit)
- [x] Preferred/Secondary/Deep labels present with visual differentiation
- [x] Aggressive warning on deep role
- [x] Commits 66db0b1 and fc97bab exist
- [x] Checkpoint Task 3 ready for visual verification

## Self-Check: PASSED
