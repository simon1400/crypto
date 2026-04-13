---
phase: 16-signals-backtester-decomposition
plan: 02
subsystem: ui
tags: [react, hooks, backtester, chart, localStorage, replay]

# Dependency graph
requires:
  - phase: 13-shared-utilities
    provides: createDarkChartOptions from lib/chartConfig.ts

provides:
  - useDrawingPersistence hook (drawing save/load/auto-save via localStorage)
  - useReplay hook (replay state machine, play/pause/step/speed/exit with interval management)
  - Slimmer Backtester.tsx using shared chart config and 2 new hooks

affects: [17-settings-trades-decomposition, 18-component-decomposition]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "useDrawingPersistence: thin hook returning pure utility functions (no internal state)"
    - "useReplay: self-contained hook exposing setters for external sync (session restore, kline reload)"
    - "Wrapper function onStartReplay preserves error display when hook's handleStartReplay returns undefined"

key-files:
  created:
    - frontend/src/hooks/useDrawingPersistence.ts
    - frontend/src/hooks/useReplay.ts
  modified:
    - frontend/src/pages/Backtester.tsx

key-decisions:
  - "useReplay called after useBacktestTrading to get checkCandle/updatePnl callbacks; replayMode: false passed to useBacktestTrading since it doesn't use the value in its body"
  - "onStartReplay wrapper added in Backtester.tsx to preserve out-of-range error display (setError call) that hook's handleStartReplay doesn't handle"
  - "useDrawingPersistence is a thin hook returning pure functions -- no useState needed since drawing state lives in DrawingManager"

patterns-established:
  - "Thin hook pattern: hook wraps pure utility functions for clear import path without direct helper imports"
  - "Callback circular dependency resolved: trading hook called first, replay hook called second with trading callbacks"

requirements-completed: [BT-01, BT-02, BT-03]

# Metrics
duration: 25min
completed: 2026-04-13
---

# Phase 16 Plan 02: Signals + Backtester Decomposition (Part 2) Summary

**Drawing persistence and replay logic extracted to hooks, inline chart config replaced with createDarkChartOptions -- Backtester.tsx reduced from 1162 to 1012 lines (-150L)**

## Performance

- **Duration:** 25 min
- **Started:** 2026-04-13T15:00:00Z
- **Completed:** 2026-04-13T15:25:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Created `useDrawingPersistence` hook extracting localStorage save/load/auto-save logic
- Created `useReplay` hook extracting replay state machine, auto-play interval, and all 6 handler functions
- Replaced all inline chart config (main chart + createSubChart) with shared `createDarkChartOptions`
- Backtester.tsx reduced by 150 lines, imports 3 new utilities instead of duplicating logic

## Task Commits

1. **Task 1: Create useDrawingPersistence and useReplay hooks** - `c1cf720` (feat)
2. **Task 2: Update Backtester.tsx to use shared chartConfig + 2 hooks** - `bc3bdf1` (feat)

## Files Created/Modified

- `frontend/src/hooks/useDrawingPersistence.ts` - Drawing save/load utilities for localStorage (getStorageKey, saveDrawings, loadDrawings)
- `frontend/src/hooks/useReplay.ts` - Replay engine: state, auto-play interval, play/pause/step/speed/start/exit with displayCandles
- `frontend/src/pages/Backtester.tsx` - Now imports createDarkChartOptions, useDrawingPersistence, useReplay; removed ~150 lines of inline code

## Decisions Made

- `useReplay` called after `useBacktestTrading` to get `checkCandle`/`updatePnl` callbacks; `replayMode: false` passed to `useBacktestTrading` since it doesn't use the value in its body
- Added `onStartReplay` wrapper in Backtester.tsx to preserve the `setError('Дата за пределами данных')` call that the hook's `handleStartReplay` cannot handle
- `useDrawingPersistence` is a thin hook returning pure functions -- no internal state needed since drawing state lives in `DrawingManager`

## Deviations from Plan

None - plan executed exactly as specified.

## Self-Check: PASSED

- `frontend/src/hooks/useDrawingPersistence.ts` exists with `export function useDrawingPersistence`
- `frontend/src/hooks/useReplay.ts` exists with `export function useReplay`
- `Backtester.tsx` imports `createDarkChartOptions`, `useDrawingPersistence`, `useReplay`
- `tsc --noEmit` passes with zero errors
- `vite build` succeeds
- Line count: 1012 (was 1162, -150L)
- Commits c1cf720 and bc3bdf1 verified in git log
