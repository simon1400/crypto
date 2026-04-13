---
phase: 10-security
plan: "01"
subsystem: security
tags: [sse, auth, rate-limiting, security-hardening]
dependency_graph:
  requires: []
  provides: [SEC-01, SEC-04]
  affects: [frontend/src/api/client.ts, backend/src/middleware/auth.ts, backend/src/middleware/rateLimit.ts, backend/src/index.ts]
tech_stack:
  added: [ReadableStream, AbortController]
  patterns: [fetch+ReadableStream SSE, in-memory rate limiting, IP-based throttle]
key_files:
  created:
    - backend/src/middleware/rateLimit.ts
  modified:
    - frontend/src/api/client.ts
    - backend/src/middleware/auth.ts
    - backend/src/index.ts
decisions:
  - "SSE via fetch+ReadableStream instead of EventSource to enable X-Api-Secret header"
  - "In-memory Map for rate limiting (no Redis dependency, single-instance deployment)"
  - "5 attempts per minute per IP, 3s reconnect backoff on SSE disconnect"
metrics:
  duration: "5 minutes"
  completed_date: "2026-04-13T12:45:57Z"
  tasks_completed: 2
  files_changed: 4
---

# Phase 10 Plan 01: SSE Auth Fix and Login Rate Limiter Summary

**One-liner:** Replaced EventSource SSE with fetch+ReadableStream for header-based auth, removed query param token fallback, added 5-req/min IP rate limiter on login endpoint.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | SSE auth fix — fetch+ReadableStream, remove query param fallback | 8c78a8b | frontend/src/api/client.ts, backend/src/middleware/auth.ts |
| 2 | Add in-memory rate limiter on POST /api/login | b52c85b | backend/src/middleware/rateLimit.ts, backend/src/index.ts |

## What Was Built

### Task 1: SSE Auth Fix (SEC-01)

`subscribeScanProgress` in `frontend/src/api/client.ts` was using `EventSource` which cannot send custom headers, forcing the auth token to appear in the URL query string (`?token=...`). This exposed the token in:
- Server access logs
- Browser history
- Referrer headers

The fix replaces `EventSource` with a `fetch`+`ReadableStream` loop that:
- Sends `X-Api-Secret` header (via `getHeaders()`)
- Manually parses SSE `data:` lines from the stream
- Reconnects after 3 seconds on connection failure
- Uses `AbortController` for clean cancellation

`backend/src/middleware/auth.ts` removed the `|| req.query.token` fallback so no route can be accessed via query param token anymore.

### Task 2: Login Rate Limiter (SEC-04)

Created `backend/src/middleware/rateLimit.ts` with:
- In-memory `Map<IP, { count, resetAt }>` tracking
- 5 attempts per IP per 60-second window
- 429 response after limit exceeded
- `setInterval` cleanup every 5 minutes to remove stale entries
- Applied to `POST /api/login` before the login handler

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `backend/src/middleware/rateLimit.ts` exists: FOUND
- `frontend/src/api/client.ts` has ReadableStream: FOUND (3 matches)
- No EventSource in client.ts: CONFIRMED (0 matches)
- No query.token in backend: CONFIRMED (0 matches)
- Commits 8c78a8b and b52c85b exist: CONFIRMED
- TypeScript compiles cleanly in both frontend and backend: CONFIRMED
