---
phase: 08-integrity-monitoring
plan: 01
subsystem: backend/integrity-monitor
tags: [integrity, lifecycle, limit-signals, monitoring, cancellation]
dependency_graph:
  requires: [Phase 06 candidateScoring, Phase 07 EntryCandidateSet in marketContext]
  provides: [checkSignalIntegrity, INVALIDATED status, integrity lifecycle]
  affects: [GeneratedSignal status, linked PENDING_ENTRY trades]
tech_stack:
  added: []
  patterns: [setInterval service, marketContext JSON extension, per-signal try/catch loop]
key_files:
  created:
    - backend/src/services/integrityMonitor.ts
  modified:
    - backend/src/index.ts
    - frontend/src/lib/constants.ts
decisions:
  - Integrity state stored as JSON inside marketContext.integrity (no schema migration needed)
  - Orange badge for INVALIDATED to distinguish from EXPIRED (gray/neutral)
  - Sequential signal processing with 200ms rate limit when > 5 signals
  - Full bearish (LH_LL) for LONG and full bullish (HH_HL) for SHORT trigger STRUCTURE_BREAK; mixed structures warn but do not invalidate
metrics:
  duration: 98s
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_modified: 3
---

# Phase 08 Plan 01: Integrity Monitoring Summary

**One-liner:** Integrity monitoring service for pending limit signals with 4-state lifecycle, 3 check types (structure/RSI/volume), TTL enforcement, and automatic PENDING_ENTRY trade cancellation on invalidation.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Create integrityMonitor.ts with full lifecycle and checks | 4d5f609 | backend/src/services/integrityMonitor.ts |
| 2 | Wire integrity monitor into index.ts and add INVALIDATED status | e3b7ac1 | backend/src/index.ts, frontend/src/lib/constants.ts |

## What Was Built

### integrityMonitor.ts
New service (`backend/src/services/integrityMonitor.ts`, 318 lines) with:

- **`checkSignalIntegrity()`** — main exported function, queries all NEW LIMIT signals and runs per-signal processing
- **Monitoring enablement (INTEG-01):** parses `marketContext.limit_entry_plan.candidates.preferred.distance_atr`; enables monitoring only when > 1.2 ATR
- **Lifecycle states:** `ACTIVE` (initial) → `STALKING` (price within 0.5 ATR of entry) → `STALE` (age > 8h) → `INVALIDATED` (checks fail / TTL exceeded)
- **Integrity checks (INTEG-03):**
  - Structure break: `LH_LL` for LONG, `HH_HL` for SHORT → `STRUCTURE_BREAK`
  - RSI overextension: RSI > 75 for LONG, < 25 for SHORT → `RSI_OVEREXTENSION`
  - Volume anomaly: `volRatio < 0.5` → `VOLUME_ANOMALY`
- **TTL enforcement (INTEG-04):** 12h default, 24h for `A_PLUS_READY` → `TTL_EXPIRED`
- **Invalidation action:** Sets `GeneratedSignal.status = 'INVALIDATED'`, finds linked PENDING_ENTRY trade by `notes` pattern, calls `cancelPendingTrade(trade, 'INTEGRITY_' + reason)`
- **State persistence:** `marketContext.integrity` JSON with enabled, lifecycle, lastCheckedAt, createdAt, reason, checksRun
- **Rate limiting:** 200ms delay between signals when > 5 pending

### index.ts
Added 15-minute `setInterval` calling `checkSignalIntegrity()` with error boundary.

### constants.ts
Added `INVALIDATED: { label: 'Невалидный', color: 'text-orange-400 bg-orange-400/10' }` to `SCANNER_STATUS_MAP` — orange to distinguish from `EXPIRED` (neutral gray).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all logic is wired end-to-end.

## Self-Check: PASSED

- `backend/src/services/integrityMonitor.ts` — exists, exports `checkSignalIntegrity`
- `backend/src/index.ts` — imports and registers 15-min interval
- `frontend/src/lib/constants.ts` — INVALIDATED entry in SCANNER_STATUS_MAP
- Backend TypeScript: no errors
- Frontend TypeScript: no errors
- Key patterns verified: INVALIDATED, cancelPendingTrade, fetchOHLCV, TTL_EXPIRED, checkSignalIntegrity in index.ts
