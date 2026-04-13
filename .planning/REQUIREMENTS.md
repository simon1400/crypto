# Requirements — v4.0 Frontend Refactoring

**Defined:** 2026-04-13
**Core Value:** Разбить большие файлы на компоненты, убрать дупликацию, вынести shared утилиты — сократить размер файлов в разы без потери функционала.

## v4.0 Requirements

### Shared Utilities

- [x] **UTIL-01**: Вынести TP validation (sum=100%, min 1) в `lib/validation.ts` — используется в TradeDetail, NewTradeForm, EntryResultCard
- [x] **UTIL-02**: Вынести P&L calculation в `lib/pnl.ts` — формулы из SignalTable, Signals, TradeDetail, PositionCard
- [x] **UTIL-03**: Вынести CSV export в `lib/csvExport.ts` — generic шаблон с sanitization, BOM, blob download
- [x] **UTIL-04**: Вынести chart config (dark theme, common options) в `lib/chartConfig.ts` — из PositionChartModal, Backtester, PnlChart, SignalChart
- [x] **UTIL-05**: Создать `hooks/useAsyncData.ts` — loading/error/data state для fetch паттернов
- [x] **UTIL-06**: Создать `components/Pagination.tsx` — переиспользуемый компонент пагинации

### Scanner Decomposition

- [ ] **SCAN-01**: Вынести таб Signals (saved signals list) в отдельный компонент
- [ ] **SCAN-02**: Вынести таб Scan (run scan, results) в отдельный компонент
- [ ] **SCAN-03**: Вынести таб Entry Analyzer в отдельный компонент
- [ ] **SCAN-04**: Вынести таб Risk Calculator в отдельный компонент
- [ ] **SCAN-05**: Вынести таб Coin List Manager в отдельный компонент
- [ ] **SCAN-06**: Вынести таб Analytics в отдельный компонент

### Signals Decomposition

- [ ] **SIG-01**: Вынести SignalModal в отдельный компонент
- [ ] **SIG-02**: Вынести DepositSimulator в отдельный компонент
- [ ] **SIG-03**: Вынести StrategyAnalysis в отдельный компонент

### Backtester Decomposition

- [ ] **BT-01**: Вынести chart setup и theme config в отдельный модуль
- [ ] **BT-02**: Вынести drawing persistence (localStorage save/load) в хук или утилиту
- [ ] **BT-03**: Вынести replay logic в отдельный хук

### Settings Decomposition

- [ ] **SET-01**: Вынести API Keys section в отдельный компонент
- [ ] **SET-02**: Вынести Position Sizing section в отдельный компонент
- [ ] **SET-03**: Вынести Channel Subscriptions section в отдельный компонент
- [ ] **SET-04**: Вынести Telegram Notifications section в отдельный компонент
- [ ] **SET-05**: Вынести Ticker Mappings section в отдельный компонент
- [ ] **SET-06**: Вынести Virtual Balance section в отдельный компонент

### Trades Decomposition

- [ ] **TRD-01**: Вынести фильтры и controls в отдельный компонент
- [ ] **TRD-02**: Вынести таблицу trades в отдельный компонент
- [ ] **TRD-03**: Упростить modal management (shared pattern)

### Component Decomposition

- [ ] **COMP-01**: Разбить UnifiedSignalCard на sub-компоненты (header, scores, models, context, actions)
- [ ] **COMP-02**: Вынести data fetching из PositionChartModal в хук, chart config в shared utility

### API Client Decomposition

- [x] **API-01**: Разбить client.ts на domain-модули (signals, scanner, trades, positions, settings)
- [x] **API-02**: Сохранить единый re-export из client.ts для обратной совместимости

## Future Requirements

(None)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Новый функционал | Чистый рефакторинг — zero feature changes |
| Error boundaries | Новая функциональность, не рефакторинг |
| WebSocket price subscription | Архитектурное изменение, выходит за scope |
| State management library (Zustand) | Смена подхода, не рефакторинг существующего |
| Float→Decimal migration | Из v3.0 out of scope — слишком рискованно |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| UTIL-01 | Phase 13 | Complete |
| UTIL-02 | Phase 13 | Complete |
| UTIL-03 | Phase 13 | Complete |
| UTIL-04 | Phase 13 | Complete |
| UTIL-05 | Phase 13 | Complete |
| UTIL-06 | Phase 13 | Complete |
| API-01 | Phase 14 | Complete |
| API-02 | Phase 14 | Complete |
| SCAN-01 | Phase 15 | Pending |
| SCAN-02 | Phase 15 | Pending |
| SCAN-03 | Phase 15 | Pending |
| SCAN-04 | Phase 15 | Pending |
| SCAN-05 | Phase 15 | Pending |
| SCAN-06 | Phase 15 | Pending |
| SIG-01 | Phase 16 | Pending |
| SIG-02 | Phase 16 | Pending |
| SIG-03 | Phase 16 | Pending |
| BT-01 | Phase 16 | Pending |
| BT-02 | Phase 16 | Pending |
| BT-03 | Phase 16 | Pending |
| SET-01 | Phase 17 | Pending |
| SET-02 | Phase 17 | Pending |
| SET-03 | Phase 17 | Pending |
| SET-04 | Phase 17 | Pending |
| SET-05 | Phase 17 | Pending |
| SET-06 | Phase 17 | Pending |
| TRD-01 | Phase 17 | Pending |
| TRD-02 | Phase 17 | Pending |
| TRD-03 | Phase 17 | Pending |
| COMP-01 | Phase 18 | Pending |
| COMP-02 | Phase 18 | Pending |

**Coverage:**
- v4.0 requirements: 31 total (note: spec header said 30, actual count is 31)
- Mapped to phases: 31
- Unmapped: 0

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 — traceability populated by roadmapper*
