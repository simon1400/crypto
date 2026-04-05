---
phase: 04-indicator-overlay
plan: "01"
subsystem: frontend/backtester
tags: [indicators, ema, rsi, macd, chart, lightweight-charts]
dependency_graph:
  requires: [frontend/src/pages/Backtester.tsx, lightweight-charts]
  provides: [frontend/src/lib/indicators.ts, frontend/src/components/backtester/IndicatorToolbar.tsx]
  affects: [frontend/src/pages/Backtester.tsx]
tech_stack:
  added: [frontend/src/lib/indicators.ts]
  patterns: [client-side indicator computation, sub-chart panes, time scale sync via subscribe/unsubscribe]
key_files:
  created:
    - frontend/src/lib/indicators.ts
    - frontend/src/components/backtester/IndicatorToolbar.tsx
  modified:
    - frontend/src/pages/Backtester.tsx
decisions:
  - "subscribeVisibleTimeRangeChange returns void in lightweight-charts v5 — must call unsubscribeVisibleTimeRangeChange(handler) for cleanup (not return value)"
  - "EMA series always created on main chart; data cleared (setData([])) when disabled — avoids destroy/recreate on toggle"
  - "RSI/MACD sub-charts are created/destroyed on toggle to keep DOM clean"
metrics:
  duration: "4 min"
  completed_date: "2026-04-05"
  tasks_completed: 2
  tasks_total: 3
  files_modified: 3
---

# Phase 04 Plan 01: Indicator Overlay Summary

**One-liner:** Client-side EMA/RSI/MACD indicators with toggle toolbar, EMA overlaid on main chart, RSI and MACD as separate synchronized sub-panes.

## What Was Built

Two new files and one major modification:

1. **`frontend/src/lib/indicators.ts`** — Client-side indicator math (no backend calls):
   - `ema(values, period)` — identical to backend version, returns full array
   - `rsiSeries(closes, period)` — Wilder RSI for every bar; first `period` entries default to 50
   - `macdSeries(closes)` — returns `{ macd[], signal[], histogram[] }` for all bars

2. **`frontend/src/components/backtester/IndicatorToolbar.tsx`** — Horizontal toggle bar with "EMA 20/50", "RSI", "MACD" buttons using same active/inactive styling as timeframe buttons.

3. **`frontend/src/pages/Backtester.tsx`** — Indicator integration:
   - EMA 20 (yellow `#f0b90b`) and EMA 50 (purple `#e040fb`) as LineSeries on main chart
   - RSI sub-chart (150px) with `createSubChart()` helper, 30/70 dashed reference lines, bidirectional time sync
   - MACD sub-chart (150px) with blue MACD line, orange signal line, green/red histogram
   - `setIndicatorData(candles)` sets full series data; `updateIndicatorsForNewCandle(allCandles, idx)` updates single bar during replay
   - `displayCandles()` and step/auto-play paths both call indicator updates
   - `emaEnabled` toggle clears/sets EMA data; `rsiEnabled`/`macdEnabled` create/destroy sub-charts

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `subscribeVisibleTimeRangeChange` returns void, not unsubscribe function**
- **Found during:** Task 2 TypeScript compile
- **Issue:** Plan suggested storing return value as unsubscribe handler, but in lightweight-charts v5 the method returns `void`
- **Fix:** Store handler function in a local variable and call `unsubscribeVisibleTimeRangeChange(handler)` explicitly in cleanup
- **Files modified:** `frontend/src/pages/Backtester.tsx`
- **Commit:** a1fd32c

## Tasks

| Task | Name | Status | Commit |
|------|------|--------|--------|
| 1 | Create indicator library + IndicatorToolbar | DONE | a9be28c |
| 2 | Integrate indicators into Backtester | DONE | a1fd32c |
| 3 | Human verify indicator overlays | CHECKPOINT | — |

## Known Stubs

None — indicators compute from real loaded candle data.

## Self-Check

Files created/modified:
- [x] `frontend/src/lib/indicators.ts` — exists
- [x] `frontend/src/components/backtester/IndicatorToolbar.tsx` — exists
- [x] `frontend/src/pages/Backtester.tsx` — exists

Commits:
- [x] a9be28c — feat(04-01): add client-side indicator library and IndicatorToolbar component
- [x] a1fd32c — feat(04-01): integrate EMA overlay, RSI pane, MACD pane into Backtester

## Self-Check: PASSED
