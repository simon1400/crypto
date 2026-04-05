# Roadmap: Replay Backtester v1.0

**Milestone:** v1.0 Replay Backtester
**Created:** 2026-04-05
**Granularity:** Standard (5 phases)
**Coverage:** 14/14 requirements mapped

---

## Phases

- [x] **Phase 1: Chart Foundation** - Backend klines endpoint + candlestick chart with volume and timeframe switching (completed 2026-04-05)
- [ ] **Phase 2: Drawing Tools** - Trendlines, Fibonacci, shapes with persistence to localStorage
- [ ] **Phase 3: Replay Engine** - Rewind to date, candle-by-candle playback with speed control
- [ ] **Phase 4: Indicator Overlay** - EMA, RSI, MACD rendered on the chart
- [ ] **Phase 5: Virtual Trading** - Entry/SL/TP lines, P&L tracking, trade history, session save/load

---

## Phase Details

### Phase 1: Chart Foundation
**Goal**: User can load any Bybit coin and view its candles across multiple timeframes with volume
**Depends on**: Nothing (first phase)
**Requirements**: CHART-01, CHART-02, CHART-03
**Success Criteria** (what must be TRUE):
  1. User can type a coin symbol (e.g. BTCUSDT) and the chart loads its historical candles
  2. User can switch between 1m, 5m, 15m, 1h, 4h, 1D timeframes and the chart reloads with correct data
  3. Volume histogram appears below the candle chart, updating when timeframe changes
  4. Backend fetches from Bybit v5 Kline API with pagination to fill up to the requested candle count
**Plans:** 2/2 plans complete
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
**Plans**: TBD
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
**Plans**: TBD
**UI hint**: yes

### Phase 4: Indicator Overlay
**Goal**: User can display EMA, RSI, and MACD computed from loaded candles on the chart
**Depends on**: Phase 1
**Requirements**: CHART-04
**Success Criteria** (what must be TRUE):
  1. User can toggle EMA (configurable period, default 20 and 50) lines overlaid on the candle chart
  2. User can open a separate RSI pane below the chart that updates as replay progresses
  3. User can open a separate MACD pane that shows MACD line, signal line, and histogram
**Plans**: TBD
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
**Plans**: TBD
**UI hint**: yes

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Chart Foundation | 2/2 | Complete   | 2026-04-05 |
| 2. Drawing Tools | 0/? | Not started | - |
| 3. Replay Engine | 0/? | Not started | - |
| 4. Indicator Overlay | 0/? | Not started | - |
| 5. Virtual Trading | 0/? | Not started | - |
