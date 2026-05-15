/**
 * OTC Binary Helper — сигналы BB-touch для OTC активов PocketOption.
 *
 * Источник данных: расширение `pocket-option-bridge` перехватывает WebSocket трафик
 * PO в браузере юзера, парсит ticks вида ["BNB-USD_otc", 1778799110.116, 623.4741]
 * и шлёт их батчами на `POST /api/binary/otc-ingest`.
 *
 * Архитектура:
 *  - Принимаем tick: { symbol, ts (seconds float), price }
 *  - Агрегируем в 1m OHLCV свечи (открытие = первый tick минуты, close = последний)
 *  - На закрытии 1m свечи (т.е. когда пришёл tick из новой минуты) считаем BB(20,2)
 *    на последних 20 свечах
 *  - Если close ≤ BB_lower → CALL signal, close ≥ BB_upper → PUT signal, horizon 5 мин
 *
 * Single-signal mode (как forex): пока есть неотмеченный сигнал — новые не зажигаем.
 *
 * Symbol format: PO использует "AUDUSD_otc", "BNB-USD_otc", "AED-CNY_otc".
 * Для отображения нормализуем к "AUD/USD OTC" формату.
 */

import { OHLCV } from './market'

const TF_MS = 60_000
const BB_PERIOD = 20
const BB_MULT = 2
const HORIZON_MS = 5 * 60_000   // 5 минут — тот же выбор что и у forex
const MAX_SERIES = 200
const MAX_ACTIVE_SIGNALS = 50
const MAX_HISTORY = 500

// Pairs that the UI cares about. Other symbols still ingested into series but not shown.
// Empty = show all symbols we have data for.
const TRACK_PREFIXES: string[] = []

export type SignalDirection = 'CALL' | 'PUT'
export type SignalOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING'
export type UserOutcome = 'WIN' | 'LOSS' | 'RECOVERY' | 'SKIPPED' | null

export interface OtcSignal {
  id: string
  symbol: string          // raw "AUDUSD_otc"
  displaySymbol: string   // "AUD/USD OTC"
  direction: SignalDirection
  entryPrice: number
  signalAt: number
  expiresAt: number
  bbUpper: number
  bbLower: number
  bbMiddle: number
  outcome: SignalOutcome
  exitPrice?: number
  userOutcome?: UserOutcome
  userMarkedAt?: number
}

export interface OtcSymbolState {
  symbol: string
  displaySymbol: string
  lastPrice: number | null
  lastCandleClose: number | null
  lastCandleTs: number | null
  bbUpper: number | null
  bbLower: number | null
  bbMiddle: number | null
  activeSignal: OtcSignal | null
  lastTickAt: number | null
}

interface CandleBucket {
  time: number       // ms — open of bar
  open: number
  high: number
  low: number
  close: number
}

// Per-symbol series of closed 1m bars
const series: Record<string, OHLCV[]> = {}
// Per-symbol forming bar (not yet closed)
const forming: Record<string, CandleBucket> = {}
// Per-symbol state for UI
const state: Record<string, OtcSymbolState> = {}

const activeSignals: OtcSignal[] = []
const history: OtcSignal[] = []

// ------------------------------------------------------------
// Symbol normalization
// ------------------------------------------------------------

function normalizeSymbol(raw: string): string {
  // Examples:
  //   "BNB-USD_otc" → "BNB/USD OTC"
  //   "AUDUSD_otc"  → "AUD/USD OTC"
  //   "EURUSD"      → "EUR/USD" (demo mode, no _otc suffix)
  const hasOtc = /_otc$/i.test(raw)
  let s = raw.replace(/_otc$/i, '')
  if (s.includes('-')) {
    s = s.replace('-', '/')
  } else if (s.length === 6) {
    s = s.slice(0, 3) + '/' + s.slice(3)
  } else if (s.length === 7) {
    s = s.slice(0, 3) + '/' + s.slice(3)
  }
  return hasOtc ? s + ' OTC' : s
}

function ensureState(symbol: string): OtcSymbolState {
  let s = state[symbol]
  if (!s) {
    s = {
      symbol,
      displaySymbol: normalizeSymbol(symbol),
      lastPrice: null, lastCandleClose: null, lastCandleTs: null,
      bbUpper: null, bbLower: null, bbMiddle: null,
      activeSignal: null,
      lastTickAt: null,
    }
    state[symbol] = s
  }
  return s
}

// ------------------------------------------------------------
// BB
// ------------------------------------------------------------

function computeBB(closes: number[]): { upper: number; lower: number; middle: number } | null {
  if (closes.length < BB_PERIOD) return null
  const slice = closes.slice(-BB_PERIOD)
  const mean = slice.reduce((a, b) => a + b, 0) / BB_PERIOD
  let sq = 0
  for (const v of slice) sq += (v - mean) ** 2
  const std = Math.sqrt(sq / BB_PERIOD)
  return { upper: mean + BB_MULT * std, lower: mean - BB_MULT * std, middle: mean }
}

// ------------------------------------------------------------
// Tick → candle aggregation
// ------------------------------------------------------------

export interface IncomingTick {
  symbol: string
  ts: number     // seconds (float) from PO
  price: number
}

// История от PO — формат пока не реверсирован, payload произвольный.
// При первом вызове логируем JSON-структуру в console чтобы понять формат.
const HISTORY_DUMP_LIMIT = 3
let historyDumpsLogged = 0

export interface IngestHistoryResult {
  accepted: number
  skipped: number
  candlesByPair?: Record<string, number>
}

export function ingestHistory(source: string, payload: any): IngestHistoryResult {
  // Dump first few payloads to console (kept for sanity during early rollout)
  if (historyDumpsLogged < HISTORY_DUMP_LIMIT) {
    historyDumpsLogged++
    try {
      const sample = JSON.stringify(payload).slice(0, 600)
      console.log(`[OtcHelper] history payload #${historyDumpsLogged} (source=${source}):`, sample)
    } catch { /* */ }
  }

  // Verified formats (reversed 2026-05-14):
  //
  //   loadHistoryPeriodFast (the gold mine — pre-built 1m OHLC bars):
  //     { asset: "CADCHF_otc", index: ..., data: [
  //         { symbol_id, time: 1778829480, open, close, high, low, volume }, ...
  //       ] }
  //     time = seconds UTC, aligned to minute boundary.
  //
  //   updateHistoryNewFast (recent ticks; less useful — we'd need to bucket them):
  //     { asset: "CADCHF_otc", period: 60, history: [[ts_seconds, price], ...] }
  //
  // We only handle loadHistoryPeriodFast — it gives us ready candles, which is exactly
  // what we need to seed BB(20) immediately. updateHistoryNewFast is ignored (live tick
  // stream will fill the recent ~minute anyway).

  if (!payload || typeof payload !== 'object') return { accepted: 0, skipped: 0 }
  const asset = payload.asset
  if (typeof asset !== 'string') return { accepted: 0, skipped: 0 }

  const data = payload.data
  if (!Array.isArray(data)) {
    // Not the OHLC variant — silently skip (tick variant arrives via updateStream anyway)
    return { accepted: 0, skipped: 0 }
  }

  // Seed candle series for this asset. We replace the existing series if it's smaller
  // (i.e. extension just opened the asset — fresh warmup overrides any partial data).
  const existing = series[asset] ?? []
  if (existing.length >= BB_PERIOD) {
    // Already warmed up live — don't overwrite
    return { accepted: 0, skipped: data.length }
  }

  const seeded: OHLCV[] = []
  for (const bar of data) {
    if (!bar || typeof bar !== 'object') continue
    const time = typeof bar.time === 'number' ? bar.time * 1000 : NaN
    const open = Number(bar.open)
    const high = Number(bar.high)
    const low = Number(bar.low)
    const close = Number(bar.close)
    const volume = Number(bar.volume ?? 0)
    if (!isFinite(time) || !isFinite(open) || !isFinite(close) || !isFinite(high) || !isFinite(low)) continue
    seeded.push({ time, open, high, low, close, volume })
  }
  if (seeded.length === 0) return { accepted: 0, skipped: data.length }

  seeded.sort((a, b) => a.time - b.time)
  // Keep only the most recent MAX_SERIES (we don't need more)
  const trimmed = seeded.slice(-MAX_SERIES)
  series[asset] = trimmed

  // Initialize state and BB on the seeded series
  const s = ensureState(asset)
  const last = trimmed[trimmed.length - 1]
  s.lastPrice = last.close
  s.lastCandleClose = last.close
  s.lastCandleTs = last.time
  const bb = computeBB(trimmed.map((c) => c.close))
  if (bb) {
    s.bbUpper = bb.upper
    s.bbLower = bb.lower
    s.bbMiddle = bb.middle
  }
  console.log(`[OtcHelper] warmup ${asset}: seeded ${trimmed.length} candles, BB ready=${bb != null}`)

  return { accepted: trimmed.length, skipped: data.length - trimmed.length, candlesByPair: { [asset]: trimmed.length } }
}

export function ingestTicks(ticks: IncomingTick[]): { accepted: number; skipped: number } {
  let accepted = 0
  let skipped = 0
  // PO posts timestamps in *exchange* timezone (often UTC+2 / +3 depending on server), not UTC.
  // Our `Date.now()` is wall-clock UTC. We don't try to reconcile — instead we use Date.now() as
  // the canonical bar boundary and treat PO's ts as a monotonic ordering hint only. Each tick is
  // recorded against the server's current minute, not the broker's. This makes the math simple
  // and immune to broker-side TZ quirks.
  const now = Date.now()
  for (const t of ticks) {
    if (!t.symbol || !isFinite(t.price) || !isFinite(t.ts)) { skipped++; continue }
    handleTick(t.symbol, now, t.price)
    accepted++
  }
  return { accepted, skipped }
}

function handleTick(symbol: string, tsMs: number, price: number): void {
  const s = ensureState(symbol)
  s.lastPrice = price
  s.lastTickAt = Date.now()

  const barOpen = Math.floor(tsMs / TF_MS) * TF_MS
  let bar = forming[symbol]
  if (!bar) {
    forming[symbol] = { time: barOpen, open: price, high: price, low: price, close: price }
    return
  }

  if (bar.time === barOpen) {
    // Same minute — update OHLC
    if (price > bar.high) bar.high = price
    if (price < bar.low) bar.low = price
    bar.close = price
    return
  }

  // New minute started — finalize previous bar
  if (barOpen > bar.time) {
    finalizeBar(symbol, bar)
    forming[symbol] = { time: barOpen, open: price, high: price, low: price, close: price }
  }
}

function finalizeBar(symbol: string, bar: CandleBucket): void {
  const arr = series[symbol] ?? (series[symbol] = [])
  const ohlcv: OHLCV = {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: 0,
  }
  arr.push(ohlcv)
  if (arr.length > MAX_SERIES) arr.splice(0, arr.length - MAX_SERIES)

  // Update BB
  const bb = computeBB(arr.map((c) => c.close))
  const s = ensureState(symbol)
  s.lastCandleClose = bar.close
  s.lastCandleTs = bar.time
  if (bb) {
    s.bbUpper = bb.upper
    s.bbLower = bb.lower
    s.bbMiddle = bb.middle
  }

  // Try to fire signal on this closed bar (only if no unmarked signal exists)
  const anyUnmarked = activeSignals.some((sig) => sig.userOutcome == null)
  if (anyUnmarked) return

  if (bb == null) return
  let direction: SignalDirection | null = null
  if (bar.close <= bb.lower) direction = 'CALL'
  else if (bar.close >= bb.upper) direction = 'PUT'
  if (!direction) return

  const signalAt = Date.now()
  const sig: OtcSignal = {
    id: `${symbol}-${bar.time}`,
    symbol,
    displaySymbol: s.displaySymbol,
    direction,
    entryPrice: bar.close,
    signalAt,
    expiresAt: signalAt + HORIZON_MS,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMiddle: bb.middle,
    outcome: 'PENDING',
  }
  s.activeSignal = sig
  activeSignals.push(sig)
  if (activeSignals.length > MAX_ACTIVE_SIGNALS) activeSignals.shift()
  console.log(`[OtcHelper] ${s.displaySymbol} ${direction} @ ${bar.close}`)
}

// ------------------------------------------------------------
// User outcome marking + cleanup (mirror forexHelperService)
// ------------------------------------------------------------

export interface MarkResult {
  ok: boolean
  signal?: OtcSignal
  error?: string
}

export function markOtcSignalOutcome(signalId: string, userOutcome: UserOutcome): MarkResult {
  let sig = activeSignals.find((s) => s.id === signalId)
  const inHistory = history.find((s) => s.id === signalId)
  if (!sig) sig = inHistory
  if (!sig) return { ok: false, error: 'signal not found' }
  sig.userOutcome = userOutcome
  sig.userMarkedAt = Date.now()
  if (!inHistory) {
    history.push(sig)
    if (history.length > MAX_HISTORY) history.shift()
  }
  // Remove from active
  for (let i = activeSignals.length - 1; i >= 0; i--) {
    if (activeSignals[i].id === signalId) {
      activeSignals.splice(i, 1)
      const cur = state[activeSignals[i]?.symbol ?? sig.symbol]
      if (cur && cur.activeSignal?.id === signalId) cur.activeSignal = null
      break
    }
  }
  const cur = state[sig.symbol]
  if (cur && cur.activeSignal?.id === signalId) cur.activeSignal = null
  console.log(`[OtcHelper] user marked ${signalId} as ${userOutcome}`)
  return { ok: true, signal: sig }
}

// ------------------------------------------------------------
// Stats + snapshot
// ------------------------------------------------------------

function computeUserStats() {
  const marked = history.filter((h) => h.userOutcome && h.userOutcome !== 'SKIPPED')
  let wins = 0, losses = 0, recoveries = 0
  for (const h of marked) {
    if (h.userOutcome === 'WIN') wins++
    else if (h.userOutcome === 'LOSS') losses++
    else if (h.userOutcome === 'RECOVERY') recoveries++
  }
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i].userOutcome
    if (!o || o === 'SKIPPED') continue
    if (o === 'LOSS') streak++
    else break
  }
  const decided = wins + losses + recoveries
  const positives = wins + recoveries
  const winRate = decided === 0 ? 0 : positives / decided
  return { totalMarked: marked.length, wins, losses, recoveries, winRate, currentLossStreak: streak }
}

export interface OtcSnapshot {
  serverTime: number
  symbols: OtcSymbolState[]
  active: OtcSignal[]
  history: OtcSignal[]
  bridgeAlive: boolean      // получали ли тики за последнюю минуту
  lastTickAt: number | null
  userStats: ReturnType<typeof computeUserStats>
}

export function getOtcSnapshot(): OtcSnapshot {
  const allSymbols = Object.values(state)
    .filter((s) => TRACK_PREFIXES.length === 0 || TRACK_PREFIXES.some((p) => s.symbol.startsWith(p)))
    .sort((a, b) => a.displaySymbol.localeCompare(b.displaySymbol))
  const now = Date.now()
  const lastTickAt = allSymbols.reduce<number | null>((acc, s) => {
    if (!s.lastTickAt) return acc
    if (!acc || s.lastTickAt > acc) return s.lastTickAt
    return acc
  }, null)
  const bridgeAlive = lastTickAt != null && (now - lastTickAt) < 60_000
  return {
    serverTime: now,
    symbols: allSymbols,
    active: [...activeSignals],
    history: history.slice(-50).reverse(),
    bridgeAlive,
    lastTickAt,
    userStats: computeUserStats(),
  }
}
