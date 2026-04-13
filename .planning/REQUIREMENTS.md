# Requirements: Smart Entry

**Defined:** 2026-04-13
**Core Value:** Лимитные ордера на оптимальный structural level, а не на ближайший к цене

## v2.0 Requirements

Requirements for Smart Entry milestone. Each maps to roadmap phases.

### Candidate Scoring

- [x] **SCORE-01**: System scores each candidate level by 4 dimensions (structural strength, geometry bonus, fill realism, setup integrity) using weighted sum with hard filters
- [x] **SCORE-02**: Candidate pool includes deep levels (EMA50 1H, Fib 0.618/0.5, EMA20/50 4H, BB 4H, Pivots 4H) collected via levelClusterer
- [x] **SCORE-03**: Candidates filtered by distance: min 0.3 ATR, max 2.0 ATR from current price
- [x] **SCORE-04**: Confluence (multiple levels in cluster) boosts candidate score

### Multi-Candidate Display

- [x] **CAND-01**: Each limit signal stores 3 ranked candidates (preferred, secondary, deep)
- [ ] **CAND-02**: Scanner UI shows all 3 candidates per signal with scores and fill categories
- [x] **CAND-03**: Only preferred candidate auto-executes as limit order

### Integrity Monitoring

- [ ] **INTEG-01**: Signals with preferred entry > 1.2 ATR from price get integrity monitoring enabled
- [ ] **INTEG-02**: Waiting signals follow lifecycle: ACTIVE → STALKING → STALE → INVALIDATED
- [ ] **INTEG-03**: Integrity checks run every 15-30 min: HH/HL structure, market regime, RSI degradation, volume anomaly
- [ ] **INTEG-04**: TTL enforcement: 12h default, 24h for A_PLUS_READY; auto-invalidation with reason logged

### Execution Classification

- [ ] **EXEC-01**: ENTER_NOW reclassified to LIMIT when strong structural level exists within 0.5-1.0 ATR
- [ ] **EXEC-02**: New WAIT_FOR_PULLBACK execution type for valid setups where price is not in optimal zone
- [ ] **EXEC-03**: ENTER_NOW restricted to: score >= 72, price at/near key level, entry trigger 4/4

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Entry

- **ADV-01**: Multi-level DCA execution (multiple simultaneous limit orders)
- **ADV-02**: Per-coin mean reversion character tuning for fill realism
- **ADV-03**: Historical backtest of entry quality (compare old vs new scoring on past signals)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-level DCA execution | Too early, complicates analytics |
| Multiplicative scoring formula | One weak factor kills score |
| Changes to setupScore pipeline | Works well, only change entry level selection |
| Changes to risk profiles / TP calculation | Depend on entry, auto-recalculate |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCORE-01 | Phase 6 | Complete |
| SCORE-02 | Phase 6 | Complete |
| SCORE-03 | Phase 6 | Complete |
| SCORE-04 | Phase 6 | Complete |
| CAND-01 | Phase 7 | Complete |
| CAND-02 | Phase 7 | Pending |
| CAND-03 | Phase 7 | Complete |
| INTEG-01 | Phase 8 | Pending |
| INTEG-02 | Phase 8 | Pending |
| INTEG-03 | Phase 8 | Pending |
| INTEG-04 | Phase 8 | Pending |
| EXEC-01 | Phase 9 | Pending |
| EXEC-02 | Phase 9 | Pending |
| EXEC-03 | Phase 9 | Pending |

**Coverage:**
- v2.0 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after roadmap creation*
