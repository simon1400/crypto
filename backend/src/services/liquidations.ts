/**
 * Bybit Liquidation Stream — реал-тайм события ликвидаций по всем монетам сканера.
 *
 * WebSocket: wss://stream.bybit.com/v5/public/linear
 * Topic: liquidation.{symbol}
 * Сообщение: { topic, type, ts, data: { symbol, side, price, size, updatedTime } }
 *
 * Архитектура:
 * - При старте бэка вызывается startLiquidationListener()
 * - Подписывается на liquidation.{symbol} для всех монет SCAN_COINS
 * - В памяти держит rolling window 60 минут с массивом событий по каждой монете
 * - Старые события автоматически удаляются раз в минуту
 * - getLiquidationStats(coin, windowMin) возвращает агрегированную статистику
 *
 * НЕ создаёт отдельный модуль / страницу. Только источник данных для скоринга и GPT.
 */

import { WebsocketClient } from 'bybit-api'

export interface LiquidationEvent {
  time: number     // ms timestamp
  side: 'Buy' | 'Sell'  // Buy = ликвидация шортов (рынок откупает), Sell = ликвидация лонгов
  price: number
  size: number     // в base coin
  valueUsd: number // size * price
}

export interface LiquidationStats {
  windowMinutes: number
  totalUsd: number       // суммарный объём ликвидаций USD
  longsLiqUsd: number    // объём ликвидаций ЛОНГОВ (side = Sell)
  shortsLiqUsd: number   // объём ликвидаций ШОРТОВ (side = Buy)
  count: number
  largestUsd: number     // самая большая одиночная ликвидация
}

// In-memory storage: { 'BTCUSDT': [event, event, ...] }
const liquidationLog: Record<string, LiquidationEvent[]> = {}

const WINDOW_MS = 60 * 60 * 1000 // 60 минут хранения

let wsClient: WebsocketClient | null = null
let started = false

/**
 * Подписывается на liquidation streams для списка монет.
 * Использует Bybit public WebSocket (без API ключей).
 */
export function startLiquidationListener(coins: string[]): void {
  if (started) return
  started = true

  wsClient = new WebsocketClient({
    market: 'v5',
    testnet: false, // ликвидации только на mainnet
  })

  // Подписываемся на все монеты сразу
  const topics = coins.map(coin => `liquidation.${coin}USDT`)
  wsClient.subscribeV5(topics, 'linear')

  wsClient.on('update', (msg: any) => {
    try {
      if (!msg.topic?.startsWith('liquidation.')) return
      const data = msg.data
      if (!data) return

      // Bybit может присылать как объект, так и массив объектов
      const events = Array.isArray(data) ? data : [data]
      for (const ev of events) {
        const symbol = ev.symbol
        if (!symbol) continue

        const price = parseFloat(ev.price)
        const size = parseFloat(ev.size ?? ev.qty ?? '0')
        if (!price || !size) continue

        const event: LiquidationEvent = {
          time: parseInt(ev.updatedTime ?? msg.ts ?? Date.now(), 10),
          side: ev.side as 'Buy' | 'Sell',
          price,
          size,
          valueUsd: price * size,
        }

        if (!liquidationLog[symbol]) liquidationLog[symbol] = []
        liquidationLog[symbol].push(event)
      }
    } catch (err: any) {
      console.error('[Liquidations] Update parse error:', err.message)
    }
  })

  wsClient.on('open', ({ wsKey }: any) => {
    console.log(`[Liquidations] WebSocket connected (${wsKey}) — subscribed to ${topics.length} symbols`)
  })

  wsClient.on('reconnect', () => {
    console.log('[Liquidations] Reconnecting...')
  })

  ;(wsClient as any).on('error', (err: any) => {
    console.error('[Liquidations] WS error:', err?.message ?? err)
  })

  // Очистка старых событий каждую минуту
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS
    let totalRemoved = 0
    for (const symbol of Object.keys(liquidationLog)) {
      const before = liquidationLog[symbol].length
      liquidationLog[symbol] = liquidationLog[symbol].filter(e => e.time >= cutoff)
      totalRemoved += before - liquidationLog[symbol].length
    }
    if (totalRemoved > 0) {
      // console.log(`[Liquidations] Cleaned ${totalRemoved} expired events`)
    }
  }, 60 * 1000)

  console.log(`[Liquidations] Started — listening for ${coins.length} symbols`)
}

/**
 * Получить агрегированную статистику ликвидаций по монете за окно.
 * coin: 'BTC' (без USDT) или 'BTCUSDT'
 * windowMinutes: окно в минутах (по умолчанию 15)
 */
export function getLiquidationStats(coin: string, windowMinutes = 15): LiquidationStats {
  const symbol = coin.endsWith('USDT') ? coin : `${coin}USDT`
  const cutoff = Date.now() - windowMinutes * 60 * 1000
  const events = (liquidationLog[symbol] || []).filter(e => e.time >= cutoff)

  let longsLiqUsd = 0
  let shortsLiqUsd = 0
  let largestUsd = 0
  for (const e of events) {
    if (e.side === 'Sell') longsLiqUsd += e.valueUsd
    else if (e.side === 'Buy') shortsLiqUsd += e.valueUsd
    if (e.valueUsd > largestUsd) largestUsd = e.valueUsd
  }

  return {
    windowMinutes,
    totalUsd: Math.round((longsLiqUsd + shortsLiqUsd) * 100) / 100,
    longsLiqUsd: Math.round(longsLiqUsd * 100) / 100,
    shortsLiqUsd: Math.round(shortsLiqUsd * 100) / 100,
    count: events.length,
    largestUsd: Math.round(largestUsd * 100) / 100,
  }
}

export function isLiquidationListenerActive(): boolean {
  return started
}
