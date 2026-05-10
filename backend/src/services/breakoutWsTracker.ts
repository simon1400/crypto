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

async function getOpenSymbols(): Promise<string[]> {
  const [a, b] = await Promise.all([
    prisma.breakoutPaperTrade.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      select: { symbol: true },
    }),
    prisma.breakoutPaperTradeB.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      select: { symbol: true },
    }),
  ])
  const set = new Set<string>()
  for (const t of a) set.add(t.symbol)
  for (const t of b) set.add(t.symbol)
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

async function handleTrade(symbol: string, price: number, ts: number): Promise<void> {
  const now = Date.now()
  const last = lastProcessedAt[symbol] ?? 0
  if (now - last < THROTTLE_MS) return
  if (busy[symbol]) return
  lastProcessedAt[symbol] = now
  busy[symbol] = true
  try {
    const tick: OHLCV = { time: ts, open: price, high: price, low: price, close: price, volume: 0 }
    await runTrackForSymbol(symbol, tick)
  } catch (e: any) {
    console.warn(`[BreakoutWS] handleTrade ${symbol} failed: ${e.message}`)
  } finally {
    busy[symbol] = false
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
      // Берём ПОСЛЕДНИЙ trade в батче — самая свежая цена.
      let latest: any = null
      for (const ev of events) {
        if (!latest || (ev.T ?? 0) > (latest.T ?? 0)) latest = ev
      }
      if (!latest) return
      const symbol = latest.s
      const price = parseFloat(latest.p)
      const ts = parseInt(latest.T ?? Date.now(), 10)
      if (!symbol || !price || price <= 0) return
      // Fire-and-forget: WS callback не должен блокироваться на DB.
      handleTrade(symbol, price, ts).catch(() => { /* logged inside */ })
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
  if (wsClient) {
    try { wsClient.closeAll() } catch { /* ignore */ }
    wsClient = null
  }
  subscribed.clear()
  started = false
  console.log('[BreakoutWS] stopped')
}
