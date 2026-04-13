# Roadmap: Crypto Trading Dashboard

## Milestones

- ✅ **v1.0 Replay Backtester** — Phases 1-5 (closed 2026-04-13, partially complete) → [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Smart Entry** — Phases 6-9 (shipped 2026-04-13) → [archive](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Code Quality & Security Hardening** — Phases 10-12 (shipped 2026-04-13) → [archive](milestones/v3.0-ROADMAP.md)
- 🚧 **v4.0 Frontend Refactoring** — Phases 13-18 (in progress)

---

### 🚧 v4.0 Frontend Refactoring (In Progress)

**Milestone Goal:** Разбить большие файлы на компоненты, убрать дупликацию, вынести shared утилиты — сократить размер файлов в разы без потери функционала. Zero functional changes.

## Phases

- [x] **Phase 13: Shared Utilities** - Extract TP validation, P&L calc, CSV export, chart config, useAsyncData hook, and Pagination component into lib/ and hooks/ (completed 2026-04-13)
- [x] **Phase 14: API Client Decomposition** - Split client.ts into domain modules with backward-compatible re-export (completed 2026-04-13)
- [x] **Phase 15: Scanner Decomposition** - Extract all 6 Scanner.tsx tabs into separate components (completed 2026-04-13)
- [x] **Phase 16: Signals + Backtester Decomposition** - Extract SignalModal, DepositSimulator, StrategyAnalysis, chart setup, drawing persistence, and replay logic (completed 2026-04-13)
- [x] **Phase 17: Settings + Trades Decomposition** - Extract 6 Settings sections and Trades filters, table, and modal management (completed 2026-04-13)
- [ ] **Phase 18: Component Decomposition** - Decompose UnifiedSignalCard and PositionChartModal into sub-components

## Phase Details

### Phase 13: Shared Utilities
**Goal**: Shared utility modules and hooks exist in lib/ and hooks/ — eliminating duplicated logic across pages
**Depends on**: Nothing (foundation for all later phases)
**Requirements**: UTIL-01, UTIL-02, UTIL-03, UTIL-04, UTIL-05, UTIL-06
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes after adding lib/validation.ts, lib/pnl.ts, lib/csvExport.ts, lib/chartConfig.ts
  2. `hooks/useAsyncData.ts` and `components/Pagination.tsx` exist and compile without errors
  3. Vite dev build completes with no new warnings related to the new utility files
  4. Existing pages that will later consume these utilities still render correctly at runtime (no import side effects)
**Plans**: 2 plans
Plans:
- [ ] 13-01-PLAN.md — lib/validation.ts + lib/pnl.ts + lib/csvExport.ts
- [x] 13-02-PLAN.md — lib/chartConfig.ts + hooks/useAsyncData.ts + components/Pagination.tsx
**UI hint**: yes

### Phase 14: API Client Decomposition
**Goal**: client.ts is split into domain-scoped modules (signals, scanner, trades, positions, settings) with a single re-export barrel maintaining backward compatibility
**Depends on**: Phase 13
**Requirements**: API-01, API-02
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes with no errors after split — all existing import paths from pages still resolve
  2. Vite production build (`npm run build`) succeeds with no broken import warnings
  3. App loads in browser without console errors related to API functions (network tab shows same requests as before)
  4. No page loses any API call — every function previously in client.ts is reachable via the re-export barrel
**Plans**: 1 plan
Plans:
- [ ] 14-01-PLAN.md — Create domain modules (base, signals, trades, scanner, settings, positions, klines) + barrel re-export

### Phase 15: Scanner Decomposition
**Goal**: Scanner.tsx delegates each of its 6 tabs to dedicated components — Scanner.tsx becomes a thin orchestrator
**Depends on**: Phase 14
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, SCAN-06
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes after extracting all 6 tab components
  2. Scanner page renders all 6 tabs identically to before — no missing data, no broken interactions
  3. Switching between tabs in browser produces no console errors
  4. Scanner.tsx file size is reduced by at least 60% compared to pre-refactor (orchestrator pattern achieved)
**Plans**: 3 plans
Plans:
- [x] 15-01-PLAN.md — Extract ScannerSignalsTab + ScannerScanTab
- [x] 15-02-PLAN.md — Extract ScannerEntryTab + ScannerCalcTab
- [x] 15-03-PLAN.md — Extract ScannerCoinListTab + ScannerAnalyticsTab + finalize orchestrator
**UI hint**: yes

### Phase 16: Signals + Backtester Decomposition
**Goal**: Signals.tsx and Backtester.tsx delegate modal/simulator/chart logic to extracted components and hooks — each page file becomes significantly smaller
**Depends on**: Phase 13
**Requirements**: SIG-01, SIG-02, SIG-03, BT-01, BT-02, BT-03
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes after all 6 extractions (SignalModal, DepositSimulator, StrategyAnalysis, chart setup, drawing persistence hook, replay hook)
  2. Signals page renders signal list, opens modal, and runs deposit simulator without errors
  3. Backtester page loads chart, restores drawings from localStorage, and replay controls function identically to before
  4. Vite build completes with no new errors
**Plans**: 2 plans
Plans:
- [x] 16-01-PLAN.md - Extract SignalModal, DepositSimulator, StrategyAnalysis from Signals.tsx
- [x] 16-02-PLAN.md - Extract useDrawingPersistence, useReplay hooks + shared chartConfig for Backtester.tsx
**UI hint**: yes

### Phase 17: Settings + Trades Decomposition
**Goal**: Settings.tsx delegates its 6 sections to components; Trades.tsx delegates filters, table, and modal management to components — both pages become orchestrators
**Depends on**: Phase 13
**Requirements**: SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, TRD-01, TRD-02, TRD-03
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes after extracting all 9 components (6 settings sections + trades filters + trades table + shared modal pattern)
  2. Settings page renders all 6 sections and each section's save/update actions work correctly in browser
  3. Trades page renders trade list with filters applied, modals open and close correctly
  4. Pagination works in Trades (using shared Pagination component from Phase 13)
**Plans**: 2 plans
Plans:
- [x] 17-01-PLAN.md — Extract 6 Settings sections into components/settings/
- [x] 17-02-PLAN.md — Extract Trades filters, table, cancel modal + shared Pagination
**UI hint**: yes

### Phase 18: Component Decomposition
**Goal**: UnifiedSignalCard.tsx and PositionChartModal.tsx are decomposed into sub-components and hooks — reducing component complexity and enabling reuse
**Depends on**: Phase 13
**Requirements**: COMP-01, COMP-02
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes after UnifiedSignalCard is split into header, scores, models, context, and actions sub-components
  2. `tsc --noEmit` passes after PositionChartModal data fetching is extracted into a hook and chart config uses shared lib/chartConfig.ts (from Phase 13)
  3. Signal cards render identically across Scanner and Signals pages — all badge styles, scores, and action buttons present
  4. Position chart modal opens, fetches candles, and renders chart with drawings without errors
**Plans**: 2 plans
Plans:
- [ ] 18-01-PLAN.md — Decompose UnifiedSignalCard into sub-components
- [ ] 18-02-PLAN.md — Extract usePositionChart hook + shared chartConfig
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 13. Shared Utilities | v4.0 | 1/2 | Complete    | 2026-04-13 |
| 14. API Client Decomposition | v4.0 | 0/1 | Complete    | 2026-04-13 |
| 15. Scanner Decomposition | v4.0 | 3/3 | Complete    | 2026-04-13 |
| 16. Signals + Backtester Decomposition | v4.0 | 2/2 | Complete    | 2026-04-13 |
| 17. Settings + Trades Decomposition | v4.0 | 2/2 | Complete    | 2026-04-13 |
| 18. Component Decomposition | v4.0 | 0/2 | Not started | - |
