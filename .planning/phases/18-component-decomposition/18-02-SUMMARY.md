---
phase: 18-component-decomposition
plan: 02
subsystem: frontend
tags: [decomposition, hooks, chart, refactoring]
dependency_graph:
  requires: []
  provides: [usePositionChart hook, slimmed PositionChartModal]
  affects: [frontend/src/pages/Scanner.tsx, frontend/src/pages/Trades.tsx]
tech_stack:
  added: []
  patterns: [custom hook extraction, shared chart config]
key_files:
  created:
    - frontend/src/hooks/usePositionChart.ts
  modified:
    - frontend/src/components/PositionChartModal.tsx
decisions:
  - Moved PositionChartPosition interface to hook file; PositionChartModal re-exports it for backward compatibility
  - Extracted zone series creation into inline helper addZone() to reduce 4x repeated BaselineSeries setup
  - Used createDarkChartOptions with spread + 'as any' cast (matches plan spec) to replace 25-line inline config
metrics:
  duration: ~15 minutes
  completed: "2026-04-13T20:04:48Z"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
---

# Phase 18 Plan 02: PositionChartModal Decomposition Summary

**One-liner:** Extracted kline fetching + polling into `usePositionChart` hook and replaced 25-line inline chart config with shared `createDarkChartOptions`, reducing PositionChartModal from 667 to 497 lines.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create usePositionChart hook | 098df15 | frontend/src/hooks/usePositionChart.ts (new, 163L) |
| 2 | Slim PositionChartModal with hook + chartConfig | 0da249e | frontend/src/components/PositionChartModal.tsx (667→497L) |

## What Was Built

**Task 1 — usePositionChart hook:**
- Moved `PositionChartPosition` interface to hook file
- Moved helper functions: `normalizeSymbol`, `toUnix`, `snapToHour`, `pickPrecision`
- Moved constants: `FUTURE_BARS = 24`, `CLOSED_TAIL_BARS = 5`
- Encapsulates all `useRef` declarations (8 refs: candleSeries, 4 zone overlays, diagonal, zoneEdges, liveCandle)
- Encapsulates `useState` for klines, latestKlineTime, loading, error
- Encapsulates stable primitive dep computations (depEntry, depStopLoss, etc.)
- Encapsulates kline fetch + 15s poll `useEffect`
- Returns `UsePositionChartResult` interface with all values needed by modal

**Task 2 — PositionChartModal slim-down:**
- Calls `usePositionChart(position)` at component top
- Chart creation now uses `createDarkChartOptions({ background: 'primary', timeVisible: true, secondsVisible: false, crosshairMode: 0 })`
- Re-exports `PositionChartPosition` for backward compatibility (Scanner.tsx and Trades.tsx unaffected)
- Inline `addZone()` helper eliminates 4x repeated BaselineSeries setup boilerplate
- Removed unused `currentPrice` destructuring from overlay block

## Deviations from Plan

**1. [Rule 2 - Cleanup] Added inline addZone() helper**
- **Found during:** Task 2 — line count was 536 after initial rewrite (above the 500-line target)
- **Issue:** 4x repeated BaselineSeries configuration blocks were ~80 lines; color constants another 9 lines
- **Fix:** Extracted `addZone()` helper inside the useEffect; refactored color constants to `G(alpha)` and `R(alpha)` helper functions
- **Files modified:** frontend/src/components/PositionChartModal.tsx
- **Result:** 536 → 497 lines, meeting the < 500 acceptance criterion

**2. [Rule 1 - Bug] Removed unused currentPrice destructuring**
- **Found during:** Task 2 code review
- **Issue:** `const { entry, stopLoss, takeProfits, currentPrice } = position` — `currentPrice` was destructured but not used in the chart-building effect (it's handled by depCurrentPrice from hook)
- **Fix:** Removed from destructuring
- **Files modified:** frontend/src/components/PositionChartModal.tsx

## Verification Results

- `npx tsc --noEmit` — passes (zero errors) after both tasks
- `npx vite build` — succeeds (✓ built in 2.19s)
- All consumers (Scanner.tsx, Trades.tsx) verified — import `PositionChartPosition` from PositionChartModal re-export still works

## Known Stubs

None — all data flows through real API (getKlines → Bybit).

## Self-Check: PASSED
