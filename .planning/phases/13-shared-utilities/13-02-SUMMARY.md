---
phase: 13-shared-utilities
plan: "02"
subsystem: frontend-utilities
tags: [chart-config, hooks, pagination, refactor, utilities]
dependency_graph:
  requires: []
  provides:
    - frontend/src/lib/chartConfig.ts
    - frontend/src/hooks/useAsyncData.ts
    - frontend/src/components/Pagination.tsx
  affects:
    - PositionChartModal.tsx
    - Backtester.tsx
    - PnlChart.tsx
    - SignalChart.tsx
    - Scanner.tsx
    - Trades.tsx
    - OrderLogTable.tsx
tech_stack:
  added: []
  patterns:
    - Factory function for chart theme variants (createDarkChartOptions)
    - Generic hook with AbortController lifecycle (useAsyncData)
    - Reusable pagination component with optional props
key_files:
  created:
    - frontend/src/lib/chartConfig.ts
    - frontend/src/hooks/useAsyncData.ts
    - frontend/src/components/Pagination.tsx
  modified: []
decisions:
  - "createDarkChartOptions uses overrides object defaulting { width: 0, height: 0 } so all params optional except via destructuring"
  - "useAsyncData fetcherRef updated each render to avoid stale closure without adding fetcher to deps"
  - "Pagination returns null for totalPages <= 1 — no empty wrapper rendered"
metrics:
  duration_seconds: 147
  completed_date: "2026-04-13"
  tasks_completed: 3
  files_created: 3
  files_modified: 0
---

# Phase 13 Plan 02: Chart Config, useAsyncData Hook, and Pagination Component Summary

**One-liner:** Dark theme chart factory with `createDarkChartOptions`, generic `useAsyncData<T>` hook with AbortController lifecycle, and arrow-navigation `Pagination` component extracted from Scanner/Trades patterns.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create lib/chartConfig.ts with dark theme factory | 400df2f | frontend/src/lib/chartConfig.ts |
| 2 | Create hooks/useAsyncData.ts with fetch lifecycle management | e577c94 | frontend/src/hooks/useAsyncData.ts |
| 3 | Create components/Pagination.tsx | ded6f7a | frontend/src/components/Pagination.tsx |

## What Was Built

**chartConfig.ts** — Exports `CHART_COLORS` constant (full trading terminal palette) and `createDarkChartOptions(overrides)` factory. Supports two background variants (`primary`/`card`), optional `timeVisible`, `secondsVisible`, and `crosshairMode` — accommodating all four chart consumers without modification.

**useAsyncData.ts** — Generic hook `useAsyncData<T>(fetcher, deps)` returning `{ data, loading, error, refetch, abort }`. Uses `fetcherRef` to prevent stale closures, creates a new `AbortController` per fetch, aborts on unmount and re-fetch. `AbortError` is silently ignored; all other errors surface as strings.

**Pagination.tsx** — Default-export component rendering `← page / totalPages →` arrow navigation. Returns `null` when `totalPages <= 1`. Supports optional `total` prop (shows "Всего: N" left-aligned) and optional `className` for wrapper override. Matches existing Scanner and OrderLogTable UI patterns exactly.

## Verification

- `tsc --noEmit` passes with zero errors after each task
- Vite production build completes successfully (`✓ built in 2.25s`)
- No existing files modified — only three new files created

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All three files are complete utilities with no placeholder data or hardcoded stubs.

## Self-Check: PASSED

- frontend/src/lib/chartConfig.ts: exists
- frontend/src/hooks/useAsyncData.ts: exists
- frontend/src/components/Pagination.tsx: exists
- Commits 400df2f, e577c94, ded6f7a: verified in git log
