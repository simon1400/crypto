# Roadmap: Crypto Auto-Trading

## Milestones

- ✅ **v1.0 Replay Backtester** - Phases 1-5 (shipped 2026-04-05)
- 🚧 **v2.0 Smart Entry** - Phases 6-9 (in progress)

---

## Phases

<details>
<summary>✅ v1.0 Replay Backtester (Phases 1-5) — SHIPPED 2026-04-05</summary>

### Phase 1: Chart Foundation
**Goal**: User can load any Bybit coin and view its candles across multiple timeframes with volume
**Depends on**: Nothing (first phase)
**Requirements**: CHART-01, CHART-02, CHART-03
**Success Criteria** (what must be TRUE):
  1. User can type a coin symbol (e.g. BTCUSDT) and the chart loads its historical candles
  2. User can switch between 1m, 5m, 15m, 1h, 4h, 1D timeframes and the chart reloads with correct data
  3. Volume histogram appears below the candle chart, updating when timeframe changes
  4. Backend fetches from Bybit v5 Kline API with pagination to fill up to the requested candle count
**Plans**: 2/2 plans complete
Plans:
- [x] 01-01-PLAN.md — Backend Bybit kline service + GET /api/klines route
- [x] 01-02-PLAN.md — Backtester page with candlestick chart, volume, timeframe switching
**UI hint**: yes

### Phase 2: Drawing Tools
**Goal**: User can draw, edit, and persist annotations on the chart
**Depends on**: Phase 1
**Requirements**: DRAW-01, DRAW-02, DRAW-03, DRAW-04, DRAW-05
**Success Criteria** (what must be TRUE):
  1. User can draw trendlines, horizontal lines, and rays by selecting the tool and clicking on the chart
  2. User can draw Fibonacci retracement by clicking two price points
  3. User can draw rectangles, parallel channels, and triangles
  4. User can click an existing drawing to select it, drag it to a new position, or press Delete to remove it
  5. After page refresh, drawings reappear exactly as left (serialized to localStorage per symbol+timeframe)
**Plans**: 1 plan
Plans:
- [ ] 02-01-PLAN.md — Drawing toolbar + DrawingManager integration + localStorage persistence
**UI hint**: yes

### Phase 3: Replay Engine
**Goal**: User can rewind the chart to a past date and replay candles forward in simulated time
**Depends on**: Phase 1
**Requirements**: REPLAY-01, REPLAY-02, REPLAY-03
**Success Criteria** (what must be TRUE):
  1. User can set a replay start date via a date picker; candles after that date are hidden from the chart
  2. User can press Play and watch candles appear one at a time at the selected speed
  3. User can press Pause to stop playback, and Step to advance exactly one candle at a time
  4. User can select playback speed (1x, 2x, 5x, 10x) and the interval between candles changes accordingly
**Plans**: 1 plan
Plans:
- [ ] 03-01-PLAN.md — ReplayControls component + replay state/logic in Backtester (date picker, play/pause/step, speed)
**UI hint**: yes

### Phase 4: Indicator Overlay
**Goal**: User can display EMA, RSI, and MACD computed from loaded candles on the chart
**Depends on**: Phase 1
**Requirements**: CHART-04
**Success Criteria** (what must be TRUE):
  1. User can toggle EMA (configurable period, default 20 and 50) lines overlaid on the candle chart
  2. User can open a separate RSI pane below the chart that updates as replay progresses
  3. User can open a separate MACD pane that shows MACD line, signal line, and histogram
**Plans**: 1 plan
Plans:
- [ ] 04-01-PLAN.md — Client-side indicators (EMA/RSI/MACD) with overlay, sub-panes, and time sync
**UI hint**: yes

### Phase 5: Virtual Trading
**Goal**: User can simulate trades during replay and review their outcomes per session
**Depends on**: Phase 3
**Requirements**: TRADE-01, TRADE-02, TRADE-03, TRADE-04
**Success Criteria** (what must be TRUE):
  1. User can place Entry, Stop Loss, and Take Profit as draggable horizontal lines on the chart while in replay mode
  2. As replay plays forward, P&L updates in real time and the position is marked closed (TP hit or SL hit) when price crosses the respective line
  3. A trade history panel lists all virtual trades in the current session with entry price, exit price, and P&L result
  4. User can save the current session (drawings + trades + replay position) and reload it to continue later
**Plans**: 0/2 plans executed
Plans:
- [ ] 05-01-PLAN.md — DB migration (source field) + useBacktestTrading hook + TradingPanel + price lines + hit detection
- [ ] 05-02-PLAN.md — Trade history panel + session save/load + E2E verification checkpoint
**UI hint**: yes

</details>

---

### v2.0 Smart Entry (In Progress)

**Milestone Goal:** Замена proximity bias на 4D candidate scoring framework — лимитные ордера ставятся на оптимальный structural level, а не на ближайший к цене.

- [ ] **Phase 6: Candidate Scoring Engine** - 4D scoring framework для candidate levels в generateLimitPlan()
- [ ] **Phase 7: Multi-Candidate Storage & UI** - Хранение 3 кандидатов на сигнал и отображение в сканере
- [ ] **Phase 8: Integrity Monitoring** - Lifecycle и мониторинг integrity для ожидающих лимиток
- [ ] **Phase 9: Execution Reclassification** - Пересмотр ENTER_NOW -> LIMIT/WAIT_FOR_PULLBACK

---

## Phase Details

### Phase 6: Candidate Scoring Engine
**Goal**: Сканер выбирает entry level по 4-мерному scoring, а не по близости к цене
**Depends on**: Phase 5
**Requirements**: SCORE-01, SCORE-02, SCORE-03, SCORE-04
**Success Criteria** (what must be TRUE):
  1. Каждый candidate level получает score по 4 измерениям: structural_strength, geometry_bonus, fill_realism, setup_integrity — через weighted sum с hard filters
  2. Пул кандидатов включает глубокие уровни: EMA50 1H, Fib 0.618/0.5, EMA20/50 4H, BB Lower/Upper 4H, Pivot S1/S2 4H (через levelClusterer.ts)
  3. Кандидаты с дистанцией < 0.3 ATR или > 2.0 ATR от текущей цены отсекаются hard filter
  4. Кандидат с confluence (несколько уровней в кластере) получает более высокий score чем одиночный уровень на той же дистанции
**Plans**: 2 plans
Plans:
- [x] 06-01-PLAN.md — Types + 4D candidate scoring module (candidateScoring.ts)
- [ ] 06-02-PLAN.md — Rewrite generateLimitPlan() with levelClusterer + scoring integration
**Key files**: backend/src/scanner/scoring/executionType.ts, backend/src/scanner/entryAnalyzer/levelClusterer.ts, backend/src/scanner/scoring/types.ts, backend/src/scanner/scoring/candidateScoring.ts

### Phase 7: Multi-Candidate Storage & UI
**Goal**: Каждый лимитный сигнал хранит 3 ranked кандидата, которые видны в UI сканера
**Depends on**: Phase 6
**Requirements**: CAND-01, CAND-02, CAND-03
**Success Criteria** (what must be TRUE):
  1. Каждый лимитный сигнал в БД содержит 3 кандидата (preferred, secondary, deep) с ценами, scores и fill категориями
  2. Scanner UI показывает все 3 кандидата для каждого сигнала — preferred выделен, secondary приглушён, deep помечен как агрессивный
  3. Автоматическое исполнение происходит только для preferred кандидата — secondary и deep видны но не исполняются
**Plans**: TBD
**Key files**: backend/src/scanner/scoring/types.ts, frontend/src/pages/Scanner.tsx
**UI hint**: yes

### Phase 8: Integrity Monitoring
**Goal**: Ожидающие лимитки с дальним entry автоматически проверяются на живучесть сетапа
**Depends on**: Phase 7
**Requirements**: INTEG-01, INTEG-02, INTEG-03, INTEG-04
**Success Criteria** (what must be TRUE):
  1. Сигналы с preferred entry > 1.2 ATR от текущей цены автоматически получают включённый integrity monitoring
  2. Ожидающий сигнал проходит lifecycle: ACTIVE -> STALKING (цена приближается) -> STALE (> 8 часов) -> INVALIDATED (структура сломана)
  3. Каждые 15-30 минут для ожидающих сигналов выполняются проверки: HH/HL structure на 1H, market regime, RSI деградация (> 75 для LONG), аномальный объём (< 0.5x avg)
  4. Сигналы с истёкшим TTL (12ч default, 24ч для A_PLUS_READY) автоматически инвалидируются с записанной причиной
**Plans**: TBD
**Key files**: backend/src/services/scannerTracker.ts

### Phase 9: Execution Reclassification
**Goal**: ENTER_NOW используется только для действительно оптимальных условий входа прямо сейчас
**Depends on**: Phase 6
**Requirements**: EXEC-01, EXEC-02, EXEC-03
**Success Criteria** (what must be TRUE):
  1. Сигналы с сильным structural level в пределах 0.5-1.0 ATR получают тип LIMIT (а не ENTER_NOW), когда лимитный вход улучшает R:R
  2. Новый тип WAIT_FOR_PULLBACK применяется к сетапам где структура валидна, но цена не в оптимальной зоне — сигнал информирует пользователя ждать pullback 0.5-1.0 ATR
  3. ENTER_NOW присваивается только при одновременном выполнении трёх условий: score >= 72, цена уже у ключевого уровня, entry trigger 4/4
**Plans**: TBD
**Key files**: backend/src/scanner/scoring/executionType.ts

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Chart Foundation | v1.0 | 2/2 | Complete | 2026-04-05 |
| 2. Drawing Tools | v1.0 | 0/1 | Planning complete | - |
| 3. Replay Engine | v1.0 | 0/1 | Planning complete | - |
| 4. Indicator Overlay | v1.0 | 0/1 | Planning complete | - |
| 5. Virtual Trading | v1.0 | 0/2 | Planned | - |
| 6. Candidate Scoring Engine | v2.0 | 1/2 | In Progress|  |
| 7. Multi-Candidate Storage & UI | v2.0 | 0/? | Not started | - |
| 8. Integrity Monitoring | v2.0 | 0/? | Not started | - |
| 9. Execution Reclassification | v2.0 | 0/? | Not started | - |
