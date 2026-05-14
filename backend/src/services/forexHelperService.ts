/**
 * Forex Binary Helper — сигналы BB-touch для бинарных опционов на forex парах.
 *
 * Стратегия (backtest 6 мес Polygon, TEST WR 60.05% aggregate, EV +$0.08/$1
 * при payout 80%): close 1m свечи касается BB(20,2) → сигнал в обратную сторону
 * с horizon 1m (1 свеча 1m).
 *
 *   close ≤ BB_lower  → CALL  (ставка вверх, экспирация +1m)
 *   close ≥ BB_upper  → PUT   (ставка вниз, экспирация +1m)
 *
 * Источник live: TwelveData free tier (8 req/min, 800/день).
 * Архитектура:
 *  - При старте: подгружаем 25 последних 1m свечей по каждой паре (для прогрева BB(20))
 *  - Polling каждые 60s: запрашиваем последние 2 1m свечи (последняя закрытая + текущая)
 *  - На обнаружении новой закрытой свечи: добавляем в series, считаем BB, проверяем
 *    условие → создаём Signal с expiresAt = signalAt + 1 минута
 *  - Резолв: на следующем поллинге берём close следующей 1m свечи как exit price
 *
 * Forex hours: 22:00 UTC Sunday → 22:00 UTC Friday. В выходные TwelveData
 * вернёт пустой массив values — мы это игнорируем без ошибки.
 *
 * Пары: EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/CAD, NZD/USD (top edge на backtest).
 */

import { OHLCV } from './market'

// Все пары — с PO payout >=85% (без OTC). NZD/USD недоступен на PO в обычном виде,
// заменён на EUR/CAD (PO +92%). EUR и CAD оба показали edge на 1m TF в backtest.
const PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'AUD/USD',
  'USD/JPY',
  'USD/CAD',
  'EUR/CAD',
]
const TF_MS = 60_000           // 1 минута
const BB_PERIOD = 20
const BB_MULT = 2
const HORIZON_MS = 60_000      // 1 минута экспирации
const MAX_SERIES = 100
const MAX_ACTIVE_SIGNALS = 50
const MAX_HISTORY = 200
// Round-robin: 1 запрос каждые 10 секунд, 6 символов → каждая пара опрашивается раз в 60с,
// при этом мгновенный rate = 6 req/min (страховой запас vs 8/min free лимита TwelveData).
const POLL_TICK_MS = 10_000

export type SignalDirection = 'CALL' | 'PUT'
export type SignalOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING'
// WIN/LOSS/RECOVERY — реальный результат на PO; SKIPPED — юзер не вошёл в сделку
// (отметка нужна чтобы закрыть баннер без записи в статистику).
export type UserOutcome = 'WIN' | 'LOSS' | 'RECOVERY' | 'SKIPPED' | null

export interface ForexSignal {
  id: string
  symbol: string                // 'EUR/USD'
  direction: SignalDirection
  entryPrice: number
  signalAt: number
  expiresAt: number
  bbUpper: number
  bbLower: number
  bbMiddle: number
  outcome: SignalOutcome              // авто-резолв по цене TwelveData
  exitPrice?: number
  userOutcome?: UserOutcome           // ручная отметка юзера
  userMarkedAt?: number               // timestamp когда юзер нажал кнопку
}

export interface ForexSymbolState {
  symbol: string
  lastPrice: number | null
  lastCandleClose: number | null
  lastCandleTs: number | null
  bbUpper: number | null
  bbLower: number | null
  bbMiddle: number | null
  activeSignal: ForexSignal | null
  hasFreshTrigger: boolean
  lastError?: string
}

const series: Record<string, OHLCV[]> = {}
const state: Record<string, ForexSymbolState> = {}
const activeSignals: ForexSignal[] = []
const history: ForexSignal[] = []
// Suppression set: candle times that came in warmup (we never fire signals on those —
// they only seed BB). Без него после рестарта сразу зажигаются сигналы на исторических свечах
// 9-минутной давности → expiresAt в будущем, таймер показывает ~10 минут вместо 1.
const warmupCandleTimes: Record<string, Set<number>> = {}

let started = false
let pollTimer: NodeJS.Timeout | null = null
let resolveTimer: NodeJS.Timeout | null = null
let rrIdx = 0  // round-robin pointer into PAIRS

// -------------------- BB --------------------

function computeBB(closes: number[]): { upper: number; lower: number; middle: number } | null {
  if (closes.length < BB_PERIOD) return null
  const slice = closes.slice(-BB_PERIOD)
  const mean = slice.reduce((a, b) => a + b, 0) / BB_PERIOD
  let sq = 0
  for (const v of slice) sq += (v - mean) ** 2
  const std = Math.sqrt(sq / BB_PERIOD)
  return { upper: mean + BB_MULT * std, lower: mean - BB_MULT * std, middle: mean }
}

// -------------------- TwelveData fetch --------------------

interface TwelveDataValue {
  datetime: string  // "2026-05-14 15:30:00"
  open: string
  high: string
  low: string
  close: string
  volume?: string
}

interface TwelveDataSeries {
  status: 'ok' | 'error'
  message?: string
  code?: number
  values?: TwelveDataValue[]
}

function parseDatetimeUtc(s: string): number {
  // TwelveData returns "YYYY-MM-DD HH:mm:ss" in UTC. Append Z for ISO parsing.
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

async function fetchSeries(pair: string, outputsize: number): Promise<OHLCV[]> {
  const key = process.env.TWELVEDATA_API_KEY
  if (!key) throw new Error('TWELVEDATA_API_KEY not set')
  // timezone=UTC обязателен — без него TwelveData возвращает время в "Exchange Time"
  // (обычно EET, +2 или +3 от UTC), и парсер datetime → ms ушёл бы в "будущее" на 9-10 часов,
  // ломая таймеры экспирации и stale-фильтр.
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1min&outputsize=${outputsize}&timezone=UTC&apikey=${key}&format=JSON`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`TwelveData ${res.status} ${res.statusText}`)
  const json = (await res.json()) as TwelveDataSeries
  if (json.status === 'error') {
    throw new Error(`TwelveData error: ${json.message ?? 'unknown'}`)
  }
  const raw = json.values ?? []
  // TwelveData returns newest first — reverse to ascending
  const candles: OHLCV[] = raw.map((v) => ({
    time: parseDatetimeUtc(v.datetime),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: v.volume ? parseFloat(v.volume) : 0,
  })).filter((c) => isFinite(c.close) && c.time > 0).sort((a, b) => a.time - b.time)
  return candles
}

// -------------------- Series management --------------------

function ensureState(symbol: string): ForexSymbolState {
  if (!state[symbol]) {
    state[symbol] = {
      symbol, lastPrice: null, lastCandleClose: null, lastCandleTs: null,
      bbUpper: null, bbLower: null, bbMiddle: null,
      activeSignal: null, hasFreshTrigger: false,
    }
  }
  return state[symbol]
}

function pushCandles(symbol: string, fresh: OHLCV[]): OHLCV[] {
  const s = series[symbol] ?? (series[symbol] = [])
  const existing = new Set(s.map((c) => c.time))
  const added: OHLCV[] = []
  for (const c of fresh) {
    if (!existing.has(c.time)) {
      s.push(c)
      added.push(c)
    }
  }
  s.sort((a, b) => a.time - b.time)
  if (s.length > MAX_SERIES) s.splice(0, s.length - MAX_SERIES)
  return added
}

function recomputeBB(symbol: string): void {
  const s = series[symbol]
  if (!s || s.length === 0) return
  const closes = s.map((c) => c.close)
  const bb = computeBB(closes)
  const cur = ensureState(symbol)
  const last = s[s.length - 1]
  cur.lastPrice = last.close
  cur.lastCandleClose = last.close
  cur.lastCandleTs = last.time
  if (bb) {
    cur.bbUpper = bb.upper
    cur.bbLower = bb.lower
    cur.bbMiddle = bb.middle
  }
}

// -------------------- Signal lifecycle --------------------

function fireSignalForClose(symbol: string, closedCandle: OHLCV): void {
  const cur = ensureState(symbol)
  if (cur.bbUpper == null || cur.bbLower == null || cur.bbMiddle == null) return

  // Single-signal mode: НЕ зажигаем новый сигнал пока существует хотя бы один
  // неотмеченный сигнал в activeSignals (по любой паре). Это согласовано с тем что
  // юзер просил — он будет работать с одним сигналом за раз и сам помечать результат.
  // Раньше проверка была только по cur.activeSignal (per-symbol slot), и после
  // auto-резолва slot обнулялся → на следующей свече зажигался новый сигнал поверх
  // уже видимого в баннере (юзер видел два сигнала EUR/USD подряд).
  const anyUnmarked = activeSignals.some((s) => s.userOutcome == null)
  if (anyUnmarked) {
    cur.hasFreshTrigger = false
    return
  }
  // Skip stale candles — only fire on freshly closed candle within the last 90s.
  // TwelveData возвращает несколько последних свечей при каждом poll, и без этого
  // ограничения после рестарта или паузы мы зажжём сигнал на 9-минутной свече,
  // а expiresAt уйдёт сильно в "будущее" относительно `now` (timer показывает ~10 мин).
  const ageMs = Date.now() - (closedCandle.time + TF_MS)
  if (ageMs > 90_000) return
  if (ageMs < -5_000) return  // candle from future — clock skew, skip

  const close = closedCandle.close
  let direction: SignalDirection | null = null
  if (close <= cur.bbLower) direction = 'CALL'
  else if (close >= cur.bbUpper) direction = 'PUT'
  if (!direction) {
    cur.hasFreshTrigger = false
    return
  }
  // signalAt = МОМЕНТ когда мы обнаружили сигнал, а не close свечи.
  // Polling round-robin + лаг TwelveData (до ~60с на free tier) могут означать что
  // closedCandle.time на 30-90с в прошлом → окно входа (signalAt+30s) сразу 00:00.
  // Юзер реально может среагировать только с момента когда баннер появился на экране,
  // поэтому отсчитываем 30с-окно от этого момента.
  const signalAt = Date.now()
  const sig: ForexSignal = {
    id: `${symbol}-${closedCandle.time}`,
    symbol,
    direction,
    entryPrice: close,
    signalAt,
    expiresAt: signalAt + HORIZON_MS,
    bbUpper: cur.bbUpper,
    bbLower: cur.bbLower,
    bbMiddle: cur.bbMiddle,
    outcome: 'PENDING',
  }
  cur.activeSignal = sig
  cur.hasFreshTrigger = true
  activeSignals.push(sig)
  if (activeSignals.length > MAX_ACTIVE_SIGNALS) activeSignals.shift()
  console.log(`[ForexHelper] ${symbol} ${direction} @ ${close} (exp ${new Date(sig.expiresAt).toISOString()})`)
}

// Сигналы живут в activeSignals пока юзер не нажмёт кнопку. После клика — удаляются,
// а в history они уже есть (push происходит в markSignalOutcome).
// Auto-резолв намеренно убран: при PAUSE-on-signal цены не обновляются → exit=entry=TIE
// мусор. Юзер сам помечает результат глядя на свой реальный PnL на PO.
function resolveExpiredSignals(): void {
  for (let i = activeSignals.length - 1; i >= 0; i--) {
    const sig = activeSignals[i]
    if (sig.userOutcome != null) {
      activeSignals.splice(i, 1)
      const cur = state[sig.symbol]
      if (cur && cur.activeSignal?.id === sig.id) cur.activeSignal = null
    }
  }
}

// -------------------- Per-symbol poll --------------------

async function pollSymbol(symbol: string, outputsize = 3, isWarmup = false): Promise<void> {
  try {
    const fresh = await fetchSeries(symbol, outputsize)
    if (fresh.length === 0) {
      const cur = ensureState(symbol)
      cur.lastError = undefined
      return
    }
    const added = pushCandles(symbol, fresh)
    recomputeBB(symbol)

    if (isWarmup) {
      // Записываем все warmup candle times в suppress-set — на них никогда не зажигаем сигналы.
      // Это исторические свечи, использованы только для seed BB(20). Иначе после старта мгновенно
      // зажигаются ложные сигналы на 5-10-минутных старых барах.
      const sup = (warmupCandleTimes[symbol] ??= new Set())
      for (const c of fresh) sup.add(c.time)
    } else {
      for (const c of added) {
        const sup = warmupCandleTimes[symbol]
        if (sup && sup.has(c.time)) continue  // was loaded during warmup, no signal
        fireSignalForClose(symbol, c)
      }
    }
    const cur = ensureState(symbol)
    cur.lastError = undefined
  } catch (e: any) {
    const cur = ensureState(symbol)
    cur.lastError = e.message ?? String(e)
    console.warn(`[ForexHelper] poll ${symbol} failed: ${cur.lastError}`)
  }
}

// -------------------- Warmup --------------------

async function warmup(): Promise<void> {
  console.log(`[ForexHelper] warmup: loading 25 1m candles per pair, round-robin every ${POLL_TICK_MS / 1000}s...`)
  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i]
    ensureState(pair)
    await pollSymbol(pair, 25, /* isWarmup */ true)
    const bb = state[pair]
    console.log(`[ForexHelper] warmup ${pair}: BB U=${bb.bbUpper?.toFixed(5)} L=${bb.bbLower?.toFixed(5)}`)
    if (i < PAIRS.length - 1) {
      await new Promise((r) => setTimeout(r, POLL_TICK_MS))
    }
  }
  console.log('[ForexHelper] warmup done — entering polling loop')
}

// -------------------- Lifecycle --------------------

export async function startForexHelper(): Promise<void> {
  if (started) return
  if (!process.env.TWELVEDATA_API_KEY) {
    console.warn('[ForexHelper] TWELVEDATA_API_KEY missing — forex helper disabled')
    return
  }
  started = true

  await warmup()

  // Round-robin polling: 1 request per POLL_TICK_MS, cycling through PAIRS.
  // 6 pairs × 10s = 60s between polls of the same pair → 6 req/min, в пределах TwelveData free 8/min.
  //
  // PAUSE-on-signal: пока есть хотя бы один НЕОТМЕЧЕННЫЙ сигнал в activeSignals
  // (userOutcome не выставлен), polling ПОЛНОСТЬЮ остановлен. Никакие запросы к TwelveData
  // не делаются — ни для отслеживания цены, ни для других пар. Это экономит дневной лимит
  // 800 req/день: при ~3 минутах между нажатиями кнопок мы пропускаем 18 запросов на каждом
  // сигнале. Цена резолва берётся из последней свечи в series (которая обновлялась до сигнала).
  pollTimer = setInterval(() => {
    const anyUnmarked = activeSignals.some((s) => s.userOutcome == null)
    if (anyUnmarked) return  // пауза до клика юзера

    const sym = PAIRS[rrIdx % PAIRS.length]
    rrIdx++
    pollSymbol(sym, 3, /* isWarmup */ false).catch(() => {})
  }, POLL_TICK_MS)

  resolveTimer = setInterval(() => {
    try { resolveExpiredSignals() } catch (e: any) { console.warn('[ForexHelper] resolve:', e.message) }
  }, 5_000)

  console.log(`[ForexHelper] started — round-robin polling 1 pair per ${POLL_TICK_MS / 1000}s (6 pairs total)`)
}

export function stopForexHelper(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (resolveTimer) { clearInterval(resolveTimer); resolveTimer = null }
  started = false
  console.log('[ForexHelper] stopped')
}

// -------------------- User outcome marking --------------------

export interface MarkResult {
  ok: boolean
  signal?: ForexSignal
  error?: string
}

export function markSignalOutcome(signalId: string, userOutcome: UserOutcome): MarkResult {
  let sig = activeSignals.find((s) => s.id === signalId)
  const inHistory = history.find((s) => s.id === signalId)
  if (!sig) sig = inHistory
  if (!sig) return { ok: false, error: 'signal not found' }
  sig.userOutcome = userOutcome
  sig.userMarkedAt = Date.now()
  // Push to history on first mark (auto-resolve is disabled, so history population is here)
  if (!inHistory) {
    history.push(sig)
    if (history.length > MAX_HISTORY) history.shift()
  }
  console.log(`[ForexHelper] user marked ${signalId} as ${userOutcome}`)
  return { ok: true, signal: sig }
}

// -------------------- Public getters --------------------

export interface ForexHelperSnapshot {
  serverTime: number
  symbols: ForexSymbolState[]
  active: ForexSignal[]
  history: ForexSignal[]
  stats: {
    total: number               // ВСЕГО auto-резолв сделок (для контекста)
    wins: number                // auto
    losses: number              // auto
    ties: number                // auto
    winRate: number             // auto WR
    payoutEV: number            // auto EV
  }
  userStats: {
    totalMarked: number
    wins: number               // юзер пометил WIN
    losses: number             // юзер пометил LOSS
    recoveries: number         // юзер пометил RECOVERY (перекрыл предыдущую серию)
    winRate: number            // userWins / (userWins + userLosses), recovery в wins
    currentLossStreak: number  // сколько LOSS подряд без перекрытия (для martingale-логики)
  }
}

function computeUserStats() {
  // SKIPPED (юзер не вошёл) не учитывается в статистике
  const marked = history.filter((h) => h.userOutcome && h.userOutcome !== 'SKIPPED')
  let wins = 0
  let losses = 0
  let recoveries = 0
  for (const h of marked) {
    if (h.userOutcome === 'WIN') wins++
    else if (h.userOutcome === 'LOSS') losses++
    else if (h.userOutcome === 'RECOVERY') recoveries++
  }
  // current loss streak: с конца истории считаем подряд LOSS пока не встретим WIN/RECOVERY.
  // SKIPPED и unmarked не прерывают серию.
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
  return {
    totalMarked: marked.length,
    wins, losses, recoveries,
    winRate,
    currentLossStreak: streak,
  }
}

export function getForexSnapshot(): ForexHelperSnapshot {
  const symbols = PAIRS.map((p) => state[p]).filter(Boolean)
  const wins = history.filter((h) => h.outcome === 'WIN').length
  const losses = history.filter((h) => h.outcome === 'LOSS').length
  const ties = history.filter((h) => h.outcome === 'TIE').length
  const decided = wins + losses
  const winRate = decided === 0 ? 0 : wins / decided
  const payoutEV = decided === 0 ? 0 : winRate * 0.80 - (1 - winRate) * 1.00
  const userStats = computeUserStats()
  return {
    serverTime: Date.now(),
    symbols,
    active: [...activeSignals],
    history: history.slice(-50).reverse(),
    stats: { total: history.length, wins, losses, ties, winRate, payoutEV },
    userStats,
  }
}
