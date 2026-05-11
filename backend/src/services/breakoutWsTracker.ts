/**
 * Daily Breakout WebSocket Tracker — реал-тайм SL/TP detection через Bybit publicTrade.
 *
 * Архитектура:
 * - Один WebSocket к Bybit linear, подписан на publicTrade.{SYMBOL} для всех монет
 *   с открытыми paper trades (A+B вместе).
 * - На каждый trade event дёргаем trackOnePaper с synthetic candle {time:now, h=l=c=price}.
 * - Throttle per-symbol (200мс) — не молотим БД на каждый трейд активной BTCUSDT.
 * - Refresh subscriptions каждые 10с: добавляем символы новых сделок, убираем закрытые.
 * - Этот сервис ЗАМЕНЯЕТ старый fast tick (2с) для tracking SL/TP. Slow 5min tick
 *   остаётся как safety net (5m candle replay подбирает wick'и при WS дисконнекте).
 */

import { WebsocketClient } from 'bybit-api'
import { OHLCV } from './market'
import { runTrackForSymbol } from './dailyBreakoutPaperTrader'
import { processWsTradeForLimits } from './dailyBreakoutLimitTrader'
import { processWsTradeForBScaleIn } from './dailyBreakoutScaleInB'
import { prisma } from '../db/prisma'

let wsClient: WebsocketClient | null = null
let started = false
let subscribed = new Set<string>()
let refreshTimer: NodeJS.Timeout | null = null

// Per-symbol throttle: skip events that arrive within THROTTLE_MS of the last processed one.
// 200мс = 5 проверок в секунду на символ — этого хватает чтобы поймать любой пробой
// SL/TP, но не молотит БД при высокой активности (BTC может выдавать 100+ tps).
const THROTTLE_MS = 200
const lastProcessedAt: Record<string, number> = {}

// Per-symbol busy lock: один tick на символ обрабатывается, остальные skipping.
// Без него под нагрузкой два события могут одновременно дёрнуть trackOnePaper и
// записать дублирующие fills.
const busy: Record<string, boolean> = {}

// Per-symbol pending buffer: между throttled ticks мы НЕ дропаем events, а копим
// high/low в буфер. Когда throttle window истечёт — flush буфера пройдёт через
// trackOnePaper с агрегированной synthetic candle. Без этого активная монета с
// >5 трейдов/сек теряла бы промежуточные пики, и реальный пробой SL/TP мог бы
// никогда не быть зафиксирован WS-трекером (только safety-net через 60s).
type PendingTick = { high: number; low: number; latestPrice: number; latestT: number }
const pending: Record<string, PendingTick> = {}
const flushTimers: Record<string, NodeJS.Timeout | null> = {}

async function getOpenSymbols(): Promise<string[]> {
  const [a, b, cActive, cPending] = await Promise.all([
    prisma.breakoutPaperTrade.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      select: { symbol: true },
    }),
    prisma.breakoutPaperTradeB.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      select: { symbol: true },
    }),
    prisma.breakoutPaperTradeC.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      select: { symbol: true },
    }),
    // C also needs WS subscriptions for PENDING_LIMIT (instant fill on edge touch)
    prisma.breakoutPaperTradeC.findMany({
      where: { limitOrderState: 'PENDING_LIMIT' },
      select: { symbol: true },
    }),
  ])
  const set = new Set<string>()
  for (const t of a) set.add(t.symbol)
  for (const t of b) set.add(t.symbol)
  for (const t of cActive) set.add(t.symbol)
  for (const t of cPending) set.add(t.symbol)
  return Array.from(set)
}

async function refreshSubscriptions(): Promise<void> {
  if (!wsClient) return
  let target: string[]
  try {
    target = await getOpenSymbols()
  } catch (e: any) {
    console.warn('[BreakoutWS] refresh: getOpenSymbols failed:', e.message)
    return
  }
  const targetSet = new Set(target)

  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const s of targetSet) if (!subscribed.has(s)) toAdd.push(s)
  for (const s of subscribed) if (!targetSet.has(s)) toRemove.push(s)

  if (toAdd.length > 0) {
    const topics = toAdd.map(s => `publicTrade.${s}`)
    try {
      wsClient.subscribeV5(topics, 'linear')
      for (const s of toAdd) subscribed.add(s)
      console.log(`[BreakoutWS] subscribed +${toAdd.length}: ${toAdd.join(', ')}`)
    } catch (e: any) {
      console.warn(`[BreakoutWS] subscribe failed: ${e.message}`)
    }
  }

  if (toRemove.length > 0) {
    const topics = toRemove.map(s => `publicTrade.${s}`)
    try {
      wsClient.unsubscribeV5(topics, 'linear')
      for (const s of toRemove) subscribed.delete(s)
      console.log(`[BreakoutWS] unsubscribed -${toRemove.length}: ${toRemove.join(', ')}`)
    } catch (e: any) {
      console.warn(`[BreakoutWS] unsubscribe failed: ${e.message}`)
    }
  }
}

function mergePending(symbol: string, high: number, low: number, latestPrice: number, latestT: number): void {
  const cur = pending[symbol]
  if (!cur) {
    pending[symbol] = { high, low, latestPrice, latestT }
    return
  }
  if (high > cur.high) cur.high = high
  if (low < cur.low) cur.low = low
  if (latestT >= cur.latestT) { cur.latestT = latestT; cur.latestPrice = latestPrice }
}

async function flushPending(symbol: string): Promise<void> {
  const p = pending[symbol]
  if (!p) return
  delete pending[symbol]
  if (busy[symbol]) {
    // Очень редкий случай: предыдущий flush ещё крутится. Возвращаем в буфер и
    // переплpанируем — следующий tick через throttle window.
    mergePending(symbol, p.high, p.low, p.latestPrice, p.latestT)
    scheduleFlush(symbol)
    return
  }
  busy[symbol] = true
  lastProcessedAt[symbol] = Date.now()
  try {
    const tick: OHLCV = {
      time: p.latestT, open: p.latestPrice, high: p.high, low: p.low, close: p.latestPrice, volume: 0,
    }
    // Variant A/B tracking — TP/SL detection on existing FILLED trades.
    await runTrackForSymbol(symbol, tick)
    // Variant C limit-fill detection — checks PENDING_LIMIT for symbol against
    // both extremes (high for BUY, low for SELL). Instant fill ≈ ms latency
    // vs slow tick safety-net (60s).
    await processWsTradeForLimits(symbol, p.high, p.latestT).catch(() => { /* logged inside */ })
    await processWsTradeForLimits(symbol, p.low, p.latestT).catch(() => { /* logged inside */ })
    // Variant B scale-in limit-fill detection — same instant-fill mechanism
    // as C, но для SCALE_IN trade rows (pyramiding @ 33% to TP1). Если scale-in
    // отключён в config B, функция найдёт 0 PENDING_LIMIT и сразу вернётся.
    await processWsTradeForBScaleIn(symbol, p.high, p.latestT).catch(() => { /* logged inside */ })
    await processWsTradeForBScaleIn(symbol, p.low, p.latestT).catch(() => { /* logged inside */ })
  } catch (e: any) {
    console.warn(`[BreakoutWS] flush ${symbol} failed: ${e.message}`)
  } finally {
    busy[symbol] = false
  }
}

function scheduleFlush(symbol: string): void {
  if (flushTimers[symbol]) return
  const now = Date.now()
  const last = lastProcessedAt[symbol] ?? 0
  const wait = Math.max(0, THROTTLE_MS - (now - last))
  flushTimers[symbol] = setTimeout(() => {
    flushTimers[symbol] = null
    flushPending(symbol).catch(() => { /* logged inside */ })
  }, wait)
}

function handleBatch(symbol: string, high: number, low: number, close: number, ts: number): void {
  mergePending(symbol, high, low, close, ts)
  const now = Date.now()
  const last = lastProcessedAt[symbol] ?? 0
  if (now - last >= THROTTLE_MS && !busy[symbol]) {
    // Throttle window прошло — можно flush'ить сразу, без таймера.
    flushPending(symbol).catch(() => { /* logged inside */ })
  } else {
    scheduleFlush(symbol)
  }
}

export function startBreakoutWsTracker(): void {
  if (started) return
  started = true

  wsClient = new WebsocketClient({ market: 'v5', testnet: false })

  wsClient.on('update', (msg: any) => {
    try {
      if (!msg.topic?.startsWith('publicTrade.')) return
      const data = msg.data
      if (!data) return
      const events = Array.isArray(data) ? data : [data]
      // publicTrade event shape: { T: ts, s: symbol, S: side, p: price, v: size, ... }
      // Bybit батчит до 50+ трейдов в одном WS message при волатильности. Если
      // взять только "последний по T" — потеряем промежуточные пики high/low,
      // и реальный пробой SL/TP может быть пропущен (например batch:
      // [0.268, 0.265, 0.266] — последний 0.266, но пик 0.268 пробил TP).
      // Поэтому строим high/low из ВСЕХ events батча.
      let symbol: string | null = null
      let high = -Infinity, low = Infinity
      let latestT = 0, latestPrice = 0
      for (const ev of events) {
        const p = parseFloat(ev.p)
        if (!p || p <= 0) continue
        if (!symbol) symbol = ev.s
        if (p > high) high = p
        if (p < low) low = p
        const t = parseInt(ev.T ?? 0, 10)
        if (t >= latestT) { latestT = t; latestPrice = p }
      }
      if (!symbol || high === -Infinity) return
      const ts = latestT || Date.now()
      // Fire-and-forget: handleBatch только мерджит в pending буфер и планирует flush.
      handleBatch(symbol, high, low, latestPrice, ts)
    } catch (err: any) {
      console.error('[BreakoutWS] update parse error:', err.message)
    }
  })

  wsClient.on('open', ({ wsKey }: any) => {
    console.log(`[BreakoutWS] connected (${wsKey})`)
  })

  wsClient.on('reconnect', () => {
    console.log('[BreakoutWS] reconnecting...')
  })

  wsClient.on('reconnected', () => {
    console.log('[BreakoutWS] reconnected — bybit-api auto-resubscribes')
  })

  ;(wsClient as any).on('error', (err: any) => {
    console.error('[BreakoutWS] error:', err?.message ?? err)
  })

  // Initial subscription + periodic refresh.
  refreshSubscriptions().catch(() => { /* logged inside */ })
  refreshTimer = setInterval(() => {
    refreshSubscriptions().catch(() => { /* logged inside */ })
  }, 10_000)

  console.log('[BreakoutWS] started — publicTrade stream for open paper trades')
}

export function stopBreakoutWsTracker(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  for (const sym of Object.keys(flushTimers)) {
    const t = flushTimers[sym]
    if (t) clearTimeout(t)
    flushTimers[sym] = null
  }
  for (const sym of Object.keys(pending)) delete pending[sym]
  if (wsClient) {
    try { wsClient.closeAll() } catch { /* ignore */ }
    wsClient = null
  }
  subscribed.clear()
  started = false
  console.log('[BreakoutWS] stopped')
}
