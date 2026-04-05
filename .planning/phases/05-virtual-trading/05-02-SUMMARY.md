---
phase: 05-virtual-trading
plan: 02
subsystem: frontend
tags: [trade-history, session-persistence, virtual-trading, backtester]
dependency_graph:
  requires: [05-01]
  provides: [trade-history-panel, session-save-load]
  affects: [frontend/src/pages/Backtester.tsx, frontend/src/components/backtester/]
tech_stack:
  added: []
  patterns: [localStorage session persistence, deferred price line recreation, React useState for toast]
key_files:
  created:
    - frontend/src/components/backtester/TradeHistory.tsx
  modified:
    - frontend/src/pages/Backtester.tsx
decisions:
  - pendingSessionOrder state pattern used to defer placeOrder() until candleSeriesRef.current is populated after async kline fetch
  - TradeHistory always rendered (not conditionally) to show empty state message
  - Session save/load buttons shown conditionally (save: when replayMode; load: when session exists in localStorage)
  - formatDate unused in TradeHistory (dates not shown in table to keep it compact); kept statusBadge and pnlColor
metrics:
  duration: 10min
  completed_date: "2026-04-05"
  tasks_completed: 1
  tasks_total: 2
  files_changed: 2
---

# Phase 5 Plan 2: Trade History + Session Save/Load Summary

**One-liner:** TradeHistory table component showing session P&L + localStorage session persistence with deferred price line recreation via pendingSessionOrder pattern.

## What Was Built

### TradeHistory component (`frontend/src/components/backtester/TradeHistory.tsx`)
- Props: `{ trades: Trade[], sessionPnl: number }`
- Header row: "Сделки сессии" title + trade count + total session P&L (pnlColor)
- Table columns: Монета | Тип | Вход | Выход | P&L | Статус
- Scrollable body (`max-h-64 overflow-y-auto`) for many trades
- Empty state: "Нет сделок. Откройте позицию в режиме воспроизведения."
- statusBadge and pnlColor helpers inlined (no import from Trades.tsx)
- Consistent card styling: `bg-card rounded-xl p-4 border border-card mt-3`

### Session Save/Load in Backtester.tsx
- `SESSION_KEY = 'backtest_session'` constant
- `saveSession()`: persists symbol, tf, currentIndex, replayMode, activeOrder, closedTradeIds, savedAt to localStorage
- "Сохранено" toast: 2-second state message, no external library
- `loadSession()`: restores replay position, sets replayMode; if symbol/tf match, calls displayCandles; if differ, loads new symbol first
- `pendingSessionOrder` state + useEffect: defers `placeOrder()` until `candleSeriesRef.current !== null`
- `hasSavedSession` state: initialized from `!!localStorage.getItem(SESSION_KEY)`, updated on save

### UI buttons
- "Сохранить сессию": visible when `replayMode === true`, shows "Сохранено" for 2s after save
- "Загрузить сессию": visible when `hasSavedSession === true`
- Style: `bg-input text-text-secondary rounded-lg px-3 py-1.5 text-sm hover:text-text-primary`

### TradeHistory integration in Backtester.tsx
- Replaced inline `closedTrades.length > 0` block with `<TradeHistory>` component
- Always rendered (shows empty state when no trades)
- `sessionPnl = closedTrades.reduce((sum, t) => sum + t.realizedPnl, 0)` computed inline

## Deviations from Plan

None — plan executed exactly as written.

## Task Status

| Task | Name | Status | Commit |
|------|------|--------|--------|
| 1 | TradeHistory + session save/load | COMPLETE | d559a6b |
| 2 | Human verify end-to-end | CHECKPOINT | — |

## Known Stubs

None. All data flows from real `closedTrades` array from `useBacktestTrading` hook.

## Self-Check

- [x] `frontend/src/components/backtester/TradeHistory.tsx` exists
- [x] `backtest_session` key referenced in Backtester.tsx
- [x] `pendingSessionOrder` pattern implemented
- [x] Commit d559a6b exists
- [x] All 6 acceptance criteria pass

## Self-Check: PASSED
