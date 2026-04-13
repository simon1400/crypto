# Roadmap: Crypto Trading Dashboard

## Milestones

- ✅ **v1.0 Replay Backtester** — Phases 1-5 (closed 2026-04-13, partially complete) → [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Smart Entry** — Phases 6-9 (shipped 2026-04-13) → [archive](milestones/v2.0-ROADMAP.md)
- 🔄 **v3.0 Code Quality & Security Hardening** — Phases 10-12 (active)

---

## Phases

- [x] **Phase 10: Security** — Auth token leak fix, JSON.parse safety, CSV injection prevention, rate limiting (completed 2026-04-13)
- [ ] **Phase 11: Data Integrity** — Prisma transactions, graceful shutdown, DB indexes, N+1 batch fix
- [ ] **Phase 12: Frontend Resilience** — Error handling, AbortController, type safety, shared balance state

---

## Phase Details

### Phase 10: Security
**Goal**: The application handles auth and user input without exploitable vectors
**Depends on**: Nothing (first phase of milestone)
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. SSE endpoint no longer accepts token in query param — connections without valid X-Api-Secret header are rejected
  2. A malformed JSON string in any DB field does not crash the server — the route returns a graceful fallback or error response
  3. Exporting trades/signals to CSV and opening in a spreadsheet does not trigger formula execution for fields starting with =, +, @, or -
  4. Submitting more than 5 login requests per minute from the same IP receives a 429 response, not a 200
**Plans**: 2 plans
Plans:
- [x] 10-01-PLAN.md — SSE auth fix (fetch+ReadableStream) + login rate limiting
- [x] 10-02-PLAN.md — JSON.parse safety (safeParse utility) + CSV injection prevention

### Phase 11: Data Integrity
**Goal**: The database stays consistent under concurrent operations and the process shuts down cleanly
**Depends on**: Phase 10
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):
  1. A multi-step operation (delete + create or position update + TP placement) that fails mid-way leaves no partial state in the database
  2. Sending SIGTERM to the backend process results in clean disconnect logged to console — no hanging DB connections or orphaned intervals
  3. Querying Trade or GeneratedSignal by status or coin uses an index (verifiable via EXPLAIN ANALYZE in psql)
  4. The scannerTracker updates multiple trades in a single batch call, not one prisma.trade.update per iteration
**Plans**: 2 plans
Plans:
- [x] 11-01-PLAN.md — Prisma transactions for multi-step ops + N+1 batch MFE/MAE fix
- [ ] 11-02-PLAN.md — Graceful shutdown handler + DB performance indexes

### Phase 12: Frontend Resilience
**Goal**: The UI handles errors, async lifecycle, and shared state without silent failures or duplicate network calls
**Depends on**: Phase 11
**Requirements**: FE-01, FE-02, FE-03, FE-04
**Success Criteria** (what must be TRUE):
  1. Any failed API call in the frontend logs a console.error with context; critical failures (trade placement, position close) show a visible error message to the user
  2. Navigating away from a page that is polling cancels the in-flight request — no "Can't perform React state update on unmounted component" warnings in console
  3. TypeScript compilation has zero `any` errors on the previously-typed interfaces (indicators, marketContext, where-objects)
  4. The balance figure shown in Navbar and in any page component is always identical and fetched exactly once per polling interval — not once per component
**Plans**: 2 plans
Plans:
- [ ] 12-01-PLAN.md — [To be planned]
- [ ] 12-02-PLAN.md — [To be planned]
**UI hint**: yes

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 10. Security | 2/2 | Complete    | 2026-04-13 |
| 11. Data Integrity | 1/2 | In Progress|  |
| 12. Frontend Resilience | 0/? | Not started | - |
