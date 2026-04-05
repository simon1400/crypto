# Requirements: Replay Backtester

**Defined:** 2026-04-05
**Core Value:** Бесплатный симулятор для тестирования торговых стратегий на реальных исторических данных

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Chart & Data

- [x] **CHART-01**: User can select any Bybit linear coin and load its historical candles
- [x] **CHART-02**: User can switch between timeframes (1m, 5m, 15m, 1h, 4h, 1D)
- [x] **CHART-03**: Chart displays volume histogram below candles
- [ ] **CHART-04**: User can overlay technical indicators (EMA, RSI, MACD) on the chart

### Drawing

- [ ] **DRAW-01**: User can draw trendlines, horizontal lines, and rays on the chart
- [ ] **DRAW-02**: User can draw Fibonacci retracement and extension
- [ ] **DRAW-03**: User can draw rectangles, parallel channels, and triangles
- [ ] **DRAW-04**: User can select, move, and delete drawings
- [ ] **DRAW-05**: Drawings persist in localStorage (serialized via plugin API)

### Replay

- [ ] **REPLAY-01**: User can rewind chart to any historical date (future candles hidden)
- [ ] **REPLAY-02**: User can play forward candle-by-candle with Play/Pause/Step buttons
- [ ] **REPLAY-03**: User can adjust playback speed (1x, 2x, 5x, 10x)

### Virtual Trading

- [x] **TRADE-01**: User can place Entry, Stop Loss, Take Profit as draggable lines on chart
- [x] **TRADE-02**: P&L calculates in real-time as replay progresses (TP/SL hit detection)
- [ ] **TRADE-03**: Trade history log shows all virtual trades with results per session
- [ ] **TRADE-04**: User can save and load backtesting sessions (drawings + trades + position)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced

- **ADV-01**: User can compare multiple charts side-by-side
- **ADV-02**: User can export chart screenshots
- **ADV-03**: User can create and save strategy templates
- **ADV-04**: All 68 drawing tools from plugin (beyond lines, fib, shapes)
- **ADV-05**: Keyboard shortcuts for replay control (Space, Arrows, +/-)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Algorithmic backtesting (code-based strategies) | Focus on visual/manual testing |
| Real trading through backtester | Separate auto-trading module exists |
| Multi-chart layout | Complexity without value for v1 |
| TradingView Advanced Charts | License prohibits private use |
| Server-side data caching in DB | localStorage + backend proxy sufficient for v1 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CHART-01 | Phase 1 | Complete |
| CHART-02 | Phase 1 | Complete |
| CHART-03 | Phase 1 | Complete |
| CHART-04 | Phase 4 | Pending |
| DRAW-01 | Phase 2 | Pending |
| DRAW-02 | Phase 2 | Pending |
| DRAW-03 | Phase 2 | Pending |
| DRAW-04 | Phase 2 | Pending |
| DRAW-05 | Phase 2 | Pending |
| REPLAY-01 | Phase 3 | Pending |
| REPLAY-02 | Phase 3 | Pending |
| REPLAY-03 | Phase 3 | Pending |
| TRADE-01 | Phase 5 | Complete |
| TRADE-02 | Phase 5 | Complete |
| TRADE-03 | Phase 5 | Pending |
| TRADE-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 — traceability filled after roadmap creation*
