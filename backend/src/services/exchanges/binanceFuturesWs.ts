/**
 * Binance USDT-M Futures WebSocket layer.
 *
 * Two distinct streams:
 *   1. USER DATA (private, requires listenKey)
 *      - URL: wss://fstream.binance.com/ws/<listenKey>  (testnet: stream.binancefuture.com)
 *      - Events: ORDER_TRADE_UPDATE (fill/cancel/expire), ACCOUNT_UPDATE (positions + balance + funding)
 *      - listenKey expires after 60 min if not refreshed; we ping every 30 min.
 *      - Recreate listenKey if WS drops (it's invalidated on REST disconnect heuristic).
 *
 *   2. MARKET DATA (public, no auth)
 *      - URL: wss://fstream.binance.com/stream?streams=<sym>@aggTrade/<sym>@aggTrade
 *      - We use aggTrade for instant fill trigger (analogous to Bybit publicTrade in breakoutWsTracker).
 *      - Dynamic subscribe/unsubscribe as live trades open/close.
 *
 * Both streams reconnect with exponential backoff + heartbeat watchdog.
 */

import WebSocket from 'ws'
import { BinanceFuturesClient, BINANCE_FUTURES_WS, BinanceNet } from './binanceFutures'

// ============================================================================
// User Data Stream
// ============================================================================

export type UserDataEvent =
  | OrderTradeUpdateEvent
  | AccountUpdateEvent
  | ListenKeyExpiredEvent
  | { e: string; [k: string]: any } // unknown event passthrough

export interface OrderTradeUpdateEvent {
  e: 'ORDER_TRADE_UPDATE'
  E: number // event time
  T: number // transaction time
  o: {
    s: string  // symbol
    c: string  // clientOrderId
    S: string  // side BUY/SELL
    o: string  // order type LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET / MARKET
    f: string  // timeInForce
    q: string  // origQty
    p: string  // price
    ap: string // avg fill price
    sp: string // stopPrice
    x: string  // execution type: NEW / CANCELED / CALCULATED / EXPIRED / TRADE
    X: string  // order status: NEW / PARTIALLY_FILLED / FILLED / CANCELED / EXPIRED
    i: number  // orderId
    l: string  // last filled qty
    z: string  // cumulative filled qty
    L: string  // last fill price
    n: string  // commission (fee)
    N: string  // commission asset
    T: number  // trade time
    t: number  // trade id
    rp: string // realized profit of the trade
    R: boolean // reduceOnly
    [k: string]: any
  }
}

export interface AccountUpdateEvent {
  e: 'ACCOUNT_UPDATE'
  E: number
  T: number
  a: {
    m: string // event reason: ORDER, FUNDING_FEE, WITHDRAW, DEPOSIT, ...
    B: Array<{ a: string; wb: string; cw: string; bc: string }> // balances
    P: Array<{
      s: string  // symbol
      pa: string // position amount
      ep: string // entry price
      cr: string // accumulated realized
      up: string // unrealized PnL
      mt: string // margin type
      iw: string // isolated wallet
      ps: string // position side
    }>
  }
}

export interface ListenKeyExpiredEvent {
  e: 'listenKeyExpired'
  E: number
  listenKey: string
}

export type UserDataHandler = (ev: UserDataEvent) => void | Promise<void>

interface UserDataStreamOpts {
  net: BinanceNet
  client: BinanceFuturesClient
  onEvent: UserDataHandler
  onDisconnect?: (reason: string) => void
}

export class BinanceUserDataStream {
  private ws: WebSocket | null = null
  private listenKey = ''
  private opts: UserDataStreamOpts
  private keepaliveTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private stopped = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastMessageAt = 0

  constructor(opts: UserDataStreamOpts) { this.opts = opts }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.ws) {
      try { this.ws.close() } catch { /* noop */ }
      this.ws = null
    }
    if (this.listenKey) {
      this.opts.client.closeUserDataStream().catch(() => { /* noop */ })
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      this.listenKey = await this.opts.client.startUserDataStream()
    } catch (e: any) {
      console.error('[BinanceWS user] startUserDataStream failed:', e.message)
      this.scheduleReconnect()
      return
    }

    const url = `${BINANCE_FUTURES_WS[this.opts.net]}/ws/${this.listenKey}`
    const ws = new WebSocket(url)
    this.ws = ws
    this.lastMessageAt = Date.now()

    ws.on('open', () => {
      console.log(`[BinanceWS user] connected (${this.opts.net})`)
      this.reconnectAttempt = 0
      // Refresh listenKey every 30 min (expires at 60 min).
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = setInterval(() => {
        this.opts.client.keepaliveUserDataStream()
          .catch((e) => console.warn('[BinanceWS user] keepalive failed:', e.message))
      }, 30 * 60 * 1000)
      // Heartbeat watchdog: any message resets lastMessageAt. If silent for 3 min → reconnect.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 3 * 60 * 1000) {
          console.warn('[BinanceWS user] heartbeat silent 3min, reconnecting')
          try { ws.terminate() } catch { /* noop */ }
        }
      }, 30 * 1000)
    })

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      try {
        const ev = JSON.parse(raw.toString()) as UserDataEvent
        Promise.resolve(this.opts.onEvent(ev)).catch((e) => {
          console.error('[BinanceWS user] handler error:', e.message)
        })
      } catch (e: any) {
        console.warn('[BinanceWS user] non-JSON message:', raw.toString().slice(0, 200))
      }
    })

    ws.on('close', (code, reason) => {
      console.warn(`[BinanceWS user] closed code=${code} reason=${reason?.toString() || ''}`)
      this.opts.onDisconnect?.(`code=${code}`)
      this.cleanupTimers()
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      console.error('[BinanceWS user] error:', err.message)
    })
  }

  private cleanupTimers(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.reconnectAttempt++
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6))
    console.log(`[BinanceWS user] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    setTimeout(() => this.connect(), delay)
  }
}

// ============================================================================
// Market Data Stream (aggTrade for instant fill trigger)
// ============================================================================

export interface AggTradeEvent {
  e: 'aggTrade'
  E: number
  s: string // symbol
  a: number // agg trade id
  p: string // price
  q: string // qty
  T: number // trade time
  m: boolean // is buyer market maker
}

export type MarketDataHandler = (sym: string, price: number, ts: number) => void | Promise<void>

interface MarketDataStreamOpts {
  net: BinanceNet
  onAggTrade: MarketDataHandler
}

export class BinanceMarketDataStream {
  private ws: WebSocket | null = null
  private opts: MarketDataStreamOpts
  private subscribed = new Set<string>()
  private reconnectAttempt = 0
  private stopped = false
  private msgId = 1
  private lastMessageAt = 0
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(opts: MarketDataStreamOpts) { this.opts = opts }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.ws) {
      try { this.ws.close() } catch { /* noop */ }
      this.ws = null
    }
  }

  /**
   * Set subscribed symbols (idempotent diff). Will SUBSCRIBE missing + UNSUBSCRIBE
   * stale on the same connection.
   */
  setSubscriptions(symbols: string[]): void {
    const want = new Set(symbols.map((s) => s.toLowerCase()))
    const toAdd: string[] = []
    const toRm: string[] = []
    for (const s of want) if (!this.subscribed.has(s)) toAdd.push(s)
    for (const s of this.subscribed) if (!want.has(s)) toRm.push(s)
    if (toAdd.length) this.send('SUBSCRIBE', toAdd.map((s) => `${s}@aggTrade`))
    if (toRm.length) this.send('UNSUBSCRIBE', toRm.map((s) => `${s}@aggTrade`))
    for (const s of toAdd) this.subscribed.add(s)
    for (const s of toRm) this.subscribed.delete(s)
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ method, params, id: this.msgId++ }))
    } catch (e: any) {
      console.warn('[BinanceWS market] send failed:', e.message)
    }
  }

  private connect(): void {
    if (this.stopped) return
    // Use combined stream endpoint; subscriptions added after open.
    const url = `${BINANCE_FUTURES_WS[this.opts.net]}/stream`
    const ws = new WebSocket(url)
    this.ws = ws
    this.lastMessageAt = Date.now()

    ws.on('open', () => {
      console.log(`[BinanceWS market] connected (${this.opts.net})`)
      this.reconnectAttempt = 0
      // Re-subscribe previously tracked symbols.
      if (this.subscribed.size > 0) {
        const params = Array.from(this.subscribed).map((s) => `${s}@aggTrade`)
        try {
          ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: this.msgId++ }))
        } catch { /* noop */ }
      }
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 3 * 60 * 1000) {
          console.warn('[BinanceWS market] heartbeat silent 3min, reconnecting')
          try { ws.terminate() } catch { /* noop */ }
        }
      }, 30 * 1000)
    })

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      try {
        const msg = JSON.parse(raw.toString()) as any
        // Combined-stream payload shape: { stream: 'btcusdt@aggTrade', data: {...} }
        const data = msg.data ?? msg
        if (data?.e === 'aggTrade') {
          const sym = String(data.s).toUpperCase()
          const price = Number(data.p)
          const ts = Number(data.T)
          Promise.resolve(this.opts.onAggTrade(sym, price, ts))
            .catch((e) => console.error('[BinanceWS market] handler error:', e.message))
        }
      } catch { /* subscription ack or non-trade message */ }
    })

    ws.on('close', (code) => {
      console.warn(`[BinanceWS market] closed code=${code}`)
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      console.error('[BinanceWS market] error:', err.message)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.reconnectAttempt++
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6))
    console.log(`[BinanceWS market] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    setTimeout(() => this.connect(), delay)
  }
}
