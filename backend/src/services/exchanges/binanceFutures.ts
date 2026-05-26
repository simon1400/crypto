/**
 * Binance USDT-M Futures REST API client (signed).
 *
 * Lean wrapper covering exactly what Variant C live trader needs:
 *   - account: balance, leverage, position mode
 *   - orders: place LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET, cancel, list open
 *   - market: exchangeInfo (filters: tick size, step size, minNotional), klines
 *   - positions: positionRisk for reconciliation
 *
 * Auth: HMAC SHA256 on query string for SIGNED endpoints. `X-MBX-APIKEY` header
 * always required for SIGNED + USER_DATA endpoints.
 *
 * Network: testnet vs prod selected by config (BreakoutLiveConfigC.useTestnet).
 *   - prod:    https://fapi.binance.com
 *   - testnet: https://testnet.binancefuture.com
 *
 * Docs: https://binance-docs.github.io/apidocs/futures/en/
 */

import crypto from 'crypto'

// ============================================================================
// Endpoints
// ============================================================================

export const BINANCE_FUTURES_REST = {
  prod: 'https://fapi.binance.com',
  testnet: 'https://testnet.binancefuture.com',
} as const

export const BINANCE_FUTURES_WS = {
  prod: 'wss://fstream.binance.com',
  testnet: 'wss://stream.binancefuture.com',
} as const

export type BinanceNet = 'prod' | 'testnet'

// ============================================================================
// Types
// ============================================================================

export interface BinanceCreds {
  apiKey: string
  apiSecret: string
  net: BinanceNet
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderType =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT'
  | 'TAKE_PROFIT_MARKET'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX' // GTX = post-only

export interface PlaceOrderParams {
  symbol: string
  side: OrderSide
  type: OrderType
  quantity?: number
  price?: number
  stopPrice?: number
  timeInForce?: TimeInForce
  reduceOnly?: boolean
  closePosition?: boolean
  newClientOrderId?: string
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  priceProtect?: boolean
}

export interface OrderResponse {
  orderId: number
  symbol: string
  status: string // NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED | NEW_INSURANCE | NEW_ADL
  clientOrderId: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  cumQuote: string
  timeInForce: string
  type: string
  reduceOnly: boolean
  closePosition: boolean
  side: string
  positionSide: string
  stopPrice: string
  workingType: string
  priceProtect: boolean
  origType: string
  updateTime: number
}

/**
 * Conditional order parameters for the Algo Order API. Binance moved
 * STOP_MARKET / TAKE_PROFIT_MARKET / STOP / TAKE_PROFIT / TRAILING_STOP_MARKET
 * to a separate Algo Service endpoint post 2025-12-09 — the old /fapi/v1/order
 * returns -4120 for these types.
 */
export interface PlaceAlgoOrderParams {
  symbol: string
  side: OrderSide
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'STOP' | 'TAKE_PROFIT' | 'TRAILING_STOP_MARKET'
  triggerPrice: number
  quantity?: number
  reduceOnly?: boolean
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  timeInForce?: TimeInForce
  clientAlgoId?: string
  priceProtect?: boolean
  closePosition?: boolean
}

export interface AlgoOrderResponse {
  algoId: number
  clientAlgoId: string
  symbol: string
  side: string
  type: string
  algoStatus: string // NEW | TRIGGERED | CANCELLED | EXPIRED
  triggerPrice: string
  quantity: string
  reduceOnly: boolean
  workingType: string
  timeInForce: string
  updateTime: number
}

export interface PositionRisk {
  symbol: string
  positionAmt: string // signed: + long, - short, 0 flat
  entryPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  marginType: 'isolated' | 'cross'
  isolatedMargin: string
  positionSide: string // BOTH for one-way mode
  updateTime: number
}

export interface AccountInfo {
  totalWalletBalance: string
  totalUnrealizedProfit: string
  totalMarginBalance: string
  availableBalance: string
  assets: Array<{ asset: string; walletBalance: string; availableBalance: string }>
  positions: PositionRisk[]
}

/**
 * One filled trade row from /fapi/v1/userTrades. Field naming follows Binance's
 * raw response (lowercase, strings — they shorten property names like `id`,
 * `qty`, `commission`).
 */
export interface UserTrade {
  symbol: string
  id: number
  orderId: number
  side: 'BUY' | 'SELL'
  price: string
  qty: string
  quoteQty: string
  commission: string
  commissionAsset: string
  realizedPnl: string
  time: number
  buyer: boolean
  maker: boolean
}

export interface SymbolFilter {
  symbol: string
  tickSize: number
  stepSize: number
  minQty: number
  /** LOT_SIZE.maxQty — applies to LIMIT and other non-MARKET orders. */
  maxQty: number
  /** MARKET_LOT_SIZE.maxQty — separate, usually much smaller cap for MARKET. */
  marketMaxQty: number
  minNotional: number
  pricePrecision: number
  quantityPrecision: number
}

export class BinanceApiError extends Error {
  code: number
  httpStatus: number
  constructor(httpStatus: number, code: number, msg: string) {
    super(`[Binance ${httpStatus}/${code}] ${msg}`)
    this.code = code
    this.httpStatus = httpStatus
  }
}

// ============================================================================
// Core client
// ============================================================================

export class BinanceFuturesClient {
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly base: string
  readonly net: BinanceNet

  // Track rate-limit weight usage from response headers; surface via getter for monitoring.
  private lastUsedWeight1m = 0
  private lastOrderCount1m = 0

  // Persistent serverTimeOffset (server - local). Updated on `syncTime()`.
  private timeOffsetMs = 0

  // Ban gate: when Binance returns 418/-1003 with "banned until <ms>", we cache
  // that timestamp here and short-circuit subsequent requests until it passes.
  // Without this, every caller keeps hammering REST during the ban window which
  // extends the ban (Binance lengthens the window on continued violation —
  // observed cascading bans 2026-05-19..26 on testnet). Public so getters can
  // expose it for monitoring and so the WS layer can pause its REST keepalive.
  private bannedUntilMs = 0
  private bannedReason = ''

  constructor(creds: BinanceCreds) {
    this.apiKey = creds.apiKey
    this.apiSecret = creds.apiSecret
    this.net = creds.net
    this.base = BINANCE_FUTURES_REST[creds.net]
  }

  get usedWeight1m(): number { return this.lastUsedWeight1m }
  get orderCount1m(): number { return this.lastOrderCount1m }

  /** Currently banned by Binance? Returns ms remaining or 0 if not banned. */
  get banRemainingMs(): number {
    const rem = this.bannedUntilMs - Date.now()
    return rem > 0 ? rem : 0
  }
  get banReason(): string { return this.bannedReason }
  isBanned(): boolean { return this.banRemainingMs > 0 }

  /**
   * Sync clock with Binance server. SIGNED endpoints reject if timestamp drift
   * exceeds recvWindow (default 5s). Call once on startup, then re-sync if
   * server returns -1021.
   */
  async syncTime(): Promise<number> {
    const r = await this.publicGet<{ serverTime: number }>('/fapi/v1/time')
    this.timeOffsetMs = r.serverTime - Date.now()
    return this.timeOffsetMs
  }

  private now(): number { return Date.now() + this.timeOffsetMs }

  // --------------------------------------------------------------------------
  // Public (no auth)
  // --------------------------------------------------------------------------

  async ping(): Promise<void> { await this.publicGet('/fapi/v1/ping') }

  async getExchangeInfo(): Promise<any> {
    return this.publicGet('/fapi/v1/exchangeInfo')
  }

  /** Build a per-symbol filter map from exchangeInfo. */
  async getSymbolFilters(): Promise<Map<string, SymbolFilter>> {
    const info = await this.getExchangeInfo()
    const map = new Map<string, SymbolFilter>()
    for (const s of info.symbols || []) {
      const f: any = {
        symbol: s.symbol,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      }
      for (const flt of s.filters || []) {
        if (flt.filterType === 'PRICE_FILTER') f.tickSize = Number(flt.tickSize)
        if (flt.filterType === 'LOT_SIZE') {
          f.stepSize = Number(flt.stepSize)
          f.minQty = Number(flt.minQty)
          f.maxQty = Number(flt.maxQty)
        }
        if (flt.filterType === 'MARKET_LOT_SIZE') {
          // Many low-cap perps have a much smaller maxQty for MARKET orders
          // than for LIMIT. e.g. KASUSDT LOT_SIZE.maxQty=1,000,000 but
          // MARKET_LOT_SIZE.maxQty=10,000. Sending a MARKET above this cap
          // returns -4005 "Quantity greater than max quantity". We have to
          // split the fill into multiple MARKETs of size <= marketMaxQty.
          f.marketMaxQty = Number(flt.maxQty)
        }
        if (flt.filterType === 'MIN_NOTIONAL') f.minNotional = Number(flt.notional)
      }
      // Default fallbacks if Binance ever omits a filter row.
      if (f.maxQty === undefined) f.maxQty = Number.POSITIVE_INFINITY
      if (f.marketMaxQty === undefined) f.marketMaxQty = f.maxQty
      map.set(s.symbol, f as SymbolFilter)
    }
    return map
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.publicGet<{ markPrice: string }>('/fapi/v1/premiumIndex', { symbol })
    return Number(r.markPrice)
  }

  // --------------------------------------------------------------------------
  // Account & positions (SIGNED, USER_DATA)
  // --------------------------------------------------------------------------

  async getAccount(): Promise<AccountInfo> {
    return this.signedGet<AccountInfo>('/fapi/v2/account')
  }

  async getBalanceUsdt(): Promise<number> {
    const acc = await this.getAccount()
    const usdt = acc.assets.find((a) => a.asset === 'USDT')
    return usdt ? Number(usdt.availableBalance) : 0
  }

  /** Open positions only (positionAmt != 0). */
  async getOpenPositions(): Promise<PositionRisk[]> {
    const r = await this.signedGet<PositionRisk[]>('/fapi/v2/positionRisk')
    return r.filter((p) => Number(p.positionAmt) !== 0)
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedPost('/fapi/v1/leverage', { symbol, leverage })
  }

  async setMarginType(symbol: string, type: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await this.signedPost('/fapi/v1/marginType', { symbol, marginType: type })
    } catch (e: any) {
      // -4046: No need to change margin type — idempotent, swallow.
      if (e instanceof BinanceApiError && e.code === -4046) return
      throw e
    }
  }

  // --------------------------------------------------------------------------
  // Orders (SIGNED, TRADE)
  // --------------------------------------------------------------------------

  async placeOrder(p: PlaceOrderParams): Promise<OrderResponse> {
    const body: Record<string, string | number | boolean> = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
    }
    if (p.quantity !== undefined) body.quantity = p.quantity
    if (p.price !== undefined) body.price = p.price
    if (p.stopPrice !== undefined) body.stopPrice = p.stopPrice
    if (p.timeInForce) body.timeInForce = p.timeInForce
    if (p.reduceOnly !== undefined) body.reduceOnly = p.reduceOnly
    if (p.closePosition !== undefined) body.closePosition = p.closePosition
    if (p.newClientOrderId) body.newClientOrderId = p.newClientOrderId
    if (p.workingType) body.workingType = p.workingType
    if (p.priceProtect !== undefined) body.priceProtect = p.priceProtect
    return this.signedPost<OrderResponse>('/fapi/v1/order', body)
  }

  async cancelOrder(symbol: string, opts: { orderId?: number; origClientOrderId?: string }): Promise<OrderResponse> {
    const params: Record<string, string | number> = { symbol }
    if (opts.orderId !== undefined) params.orderId = opts.orderId
    if (opts.origClientOrderId !== undefined) params.origClientOrderId = opts.origClientOrderId
    return this.signedDelete<OrderResponse>('/fapi/v1/order', params)
  }

  /** Cancel ALL open orders for a symbol. */
  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signedDelete('/fapi/v1/allOpenOrders', { symbol })
  }

  async getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
    const params = symbol ? { symbol } : {}
    return this.signedGet<OrderResponse[]>('/fapi/v1/openOrders', params)
  }

  async getOrder(symbol: string, opts: { orderId?: number; origClientOrderId?: string }): Promise<OrderResponse> {
    const params: Record<string, string | number> = { symbol, ...opts }
    return this.signedGet<OrderResponse>('/fapi/v1/order', params)
  }

  /**
   * Pull user trades (fills) for a symbol within a time window. Returns one
   * row per fill with exact qty, price, commission, realized PnL. Used by
   * the EOD reconciliation script to backfill `closes[].pnlUsd` for rows
   * where the WS event was missed (pre-2026-05-20 bug). Weight 5 per call.
   */
  async getUserTrades(symbol: string, opts: { startTime?: number; endTime?: number; limit?: number } = {}): Promise<UserTrade[]> {
    const params: Record<string, string | number> = { symbol }
    if (opts.startTime !== undefined) params.startTime = opts.startTime
    if (opts.endTime !== undefined) params.endTime = opts.endTime
    if (opts.limit !== undefined) params.limit = opts.limit
    return this.signedGet<UserTrade[]>('/fapi/v1/userTrades', params)
  }

  // --------------------------------------------------------------------------
  // Algo orders — conditional STOP_MARKET / TAKE_PROFIT_MARKET etc.
  //
  // Binance migrated conditional orders to a separate Algo Service endpoint
  // (post 2025-12-09). Placing STOP_MARKET via /fapi/v1/order now returns
  // -4120 with message "Order type not supported for this endpoint. Please
  // use the Algo Order API endpoints instead."
  //
  // Endpoint: POST /fapi/v1/algoOrder. Response fields differ: `algoId` and
  // `clientAlgoId` instead of `orderId`/`clientOrderId`.
  // --------------------------------------------------------------------------

  async placeAlgoOrder(p: PlaceAlgoOrderParams): Promise<AlgoOrderResponse> {
    const body: Record<string, string | number | boolean> = {
      algoType: 'CONDITIONAL',
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      triggerPrice: p.triggerPrice,
    }
    if (p.quantity !== undefined) body.quantity = p.quantity
    if (p.reduceOnly !== undefined) body.reduceOnly = String(p.reduceOnly)
    if (p.workingType) body.workingType = p.workingType
    if (p.timeInForce) body.timeInForce = p.timeInForce
    if (p.clientAlgoId) body.clientAlgoId = p.clientAlgoId
    if (p.priceProtect !== undefined) body.priceProtect = p.priceProtect
    if (p.closePosition !== undefined) body.closePosition = p.closePosition
    return this.signedPost<AlgoOrderResponse>('/fapi/v1/algoOrder', body)
  }

  /** Cancel a single conditional/algo order. */
  async cancelAlgoOrder(symbol: string, opts: { algoId?: number; clientAlgoId?: string }): Promise<any> {
    const params: Record<string, string | number> = { symbol }
    if (opts.algoId !== undefined) params.algoId = opts.algoId
    if (opts.clientAlgoId !== undefined) params.clientAlgoId = opts.clientAlgoId
    return this.signedDelete('/fapi/v1/algoOrder', params)
  }

  /** List all open conditional/algo orders. Used by sweepStrayAlgoOrders. */
  async getOpenAlgoOrders(): Promise<Array<{
    algoId: number
    clientAlgoId: string
    symbol: string
    side: 'BUY' | 'SELL'
    type: string
    triggerPrice: string
    quantity?: string
    origQty?: string
    reduceOnly: boolean
  }>> {
    return this.signedGet('/fapi/v1/openAlgoOrders', {})
  }

  /**
   * Fetch notional leverage brackets. Without args returns brackets for all
   * symbols; with `symbol` returns just one. Used by sizing to pick a leverage
   * the exchange will actually accept (Binance rejects -2027 if leverage > the
   * bracket whose notionalFloor..notionalCap contains the trade's notional).
   *
   * Response shape: [{ symbol, brackets: [{ bracket, initialLeverage,
   * notionalCap, notionalFloor, maintMarginRatio, cum }, …] }]
   */
  async getLeverageBrackets(symbol?: string): Promise<Array<{
    symbol: string
    brackets: Array<{
      bracket: number
      initialLeverage: number
      notionalCap: number
      notionalFloor: number
      maintMarginRatio: number
      cum: number
    }>
  }>> {
    const params: Record<string, string> = {}
    if (symbol) params.symbol = symbol
    return this.signedGet('/fapi/v1/leverageBracket', params)
  }

  // --------------------------------------------------------------------------
  // User data stream (listenKey for WS)
  // --------------------------------------------------------------------------

  async startUserDataStream(): Promise<string> {
    const r = await this.userDataPost<{ listenKey: string }>('/fapi/v1/listenKey')
    return r.listenKey
  }

  async keepaliveUserDataStream(): Promise<void> {
    await this.userDataPut('/fapi/v1/listenKey')
  }

  async closeUserDataStream(): Promise<void> {
    await this.userDataDelete('/fapi/v1/listenKey')
  }

  // ==========================================================================
  // HTTP plumbing
  // ==========================================================================

  private async publicGet<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    const qs = this.qs(params)
    return this.request<T>('GET', `${path}${qs ? '?' + qs : ''}`)
  }

  private async signedGet<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    return this.signed<T>('GET', path, params)
  }

  private async signedPost<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    return this.signed<T>('POST', path, params)
  }

  private async signedDelete<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    return this.signed<T>('DELETE', path, params)
  }

  /** USER_DATA endpoints (listenKey lifecycle): require X-MBX-APIKEY but NO signature. */
  private async userDataPost<T = any>(path: string): Promise<T> {
    return this.request<T>('POST', path, { 'X-MBX-APIKEY': this.apiKey })
  }
  private async userDataPut<T = any>(path: string): Promise<T> {
    return this.request<T>('PUT', path, { 'X-MBX-APIKEY': this.apiKey })
  }
  private async userDataDelete<T = any>(path: string): Promise<T> {
    return this.request<T>('DELETE', path, { 'X-MBX-APIKEY': this.apiKey })
  }

  private async signed<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any>): Promise<T> {
    const full = { ...params, timestamp: this.now(), recvWindow: 5000 }
    const query = this.qs(full)
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex')
    const url = `${path}?${query}&signature=${signature}`
    return this.request<T>(method, url, { 'X-MBX-APIKEY': this.apiKey })
  }

  private qs(params: Record<string, any>): string {
    const parts: string[] = []
    for (const k of Object.keys(params)) {
      const v = params[k]
      if (v === undefined || v === null) continue
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
    return parts.join('&')
  }

  private async request<T>(method: string, path: string, headers: Record<string, string> = {}): Promise<T> {
    // Ban-gate: if we're inside an active 418/-1003 window, refuse the call
    // BEFORE hitting the network. Each request during the window only convinces
    // Binance to extend it ("banned until X" increases on every violation).
    // The thrown error carries the SAME shape callers already handle for live
    // 418/-1003 responses, so all existing try/catches keep working.
    if (this.bannedUntilMs > Date.now()) {
      throw new BinanceApiError(
        418,
        -1003,
        `IP banned (local gate) until ${this.bannedUntilMs} — ${this.bannedReason}`,
      )
    }

    const url = `${this.base}${path}`
    const res = await fetch(url, { method, headers })

    // Capture rate-limit headers for monitoring.
    const w = res.headers.get('X-MBX-USED-WEIGHT-1M')
    if (w) this.lastUsedWeight1m = Number(w)
    const o = res.headers.get('X-MBX-ORDER-COUNT-1M')
    if (o) this.lastOrderCount1m = Number(o)

    const text = await res.text()
    if (!res.ok) {
      // Binance error shape: { code: number, msg: string }
      let code = -1
      let msg = text
      try {
        const j = JSON.parse(text)
        code = j.code ?? -1
        msg = j.msg ?? text
      } catch { /* non-JSON body */ }

      // 418/-1003: parse "banned until <ms>" and cache. Binance returns either
      //   "Way too many requests; IP(x.x.x.x) banned until 1779786659174."
      //   "Too many requests; current limit ... requests per minute. ..."
      // Only the first form pins a ban-until; the second is rate-limit (429)
      // without a hard ban. Honor both by setting a short cooldown.
      if (res.status === 418 || res.status === 429 || code === -1003) {
        const m = /banned until\s+(\d{10,16})/i.exec(msg)
        if (m) {
          const untilMs = Number(m[1])
          if (Number.isFinite(untilMs) && untilMs > this.bannedUntilMs) {
            this.bannedUntilMs = untilMs
            this.bannedReason = msg.slice(0, 200)
            const remaining = Math.max(0, untilMs - Date.now())
            console.warn(`[BinanceClient] ban gate ENGAGED for ${(remaining / 1000).toFixed(0)}s — ${msg.slice(0, 120)}`)
          }
        } else if (res.status === 429) {
          // Soft rate-limit without explicit ban-until — back off for 60s to
          // give the per-minute counter time to roll.
          const softUntil = Date.now() + 60_000
          if (softUntil > this.bannedUntilMs) {
            this.bannedUntilMs = softUntil
            this.bannedReason = '429 soft rate-limit (60s cooldown)'
            console.warn('[BinanceClient] soft rate-limit — 60s REST cooldown engaged')
          }
        }
      }

      throw new BinanceApiError(res.status, code, msg)
    }
    // Empty body (some POSTs return 200 + empty)
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }
}

// ============================================================================
// Singleton accessor — keyed by (net, apiKey) so testnet/prod can coexist.
// ============================================================================

const clients = new Map<string, BinanceFuturesClient>()

export function getBinanceClient(creds: BinanceCreds): BinanceFuturesClient {
  const key = `${creds.net}:${creds.apiKey.slice(0, 8)}`
  let c = clients.get(key)
  if (!c) {
    c = new BinanceFuturesClient(creds)
    clients.set(key, c)
  }
  return c
}

/**
 * Read creds from BotConfig (DB-backed, encrypted via services/encryption.ts).
 * Two key-pairs are stored on the BotConfig singleton (id=1):
 *   - binanceTestnetApiKey / binanceTestnetApiSecret
 *   - binanceLiveApiKey    / binanceLiveApiSecret
 *
 * The pair to use is selected by BreakoutLiveConfigC.useTestnet at runtime.
 * Returns null if the requested set is missing — caller must surface this as
 * "live disabled, missing credentials" rather than crash.
 *
 * Note: this is async because it touches the DB + AES-GCM decrypt. Callers
 * should cache the result for the duration of a single operation.
 */
export async function getBinanceCreds(useTestnet: boolean): Promise<BinanceCreds | null> {
  // Lazy imports to avoid circular dep with prisma/encryption modules.
  const { prisma } = await import('../../db/prisma')
  const { decrypt } = await import('../encryption')
  const cfg = await prisma.botConfig.findUnique({ where: { id: 1 } })
  if (!cfg) return null
  const encKey = useTestnet ? cfg.binanceTestnetApiKey : cfg.binanceLiveApiKey
  const encSecret = useTestnet ? cfg.binanceTestnetApiSecret : cfg.binanceLiveApiSecret
  if (!encKey || !encSecret) return null
  try {
    return {
      apiKey: decrypt(encKey),
      apiSecret: decrypt(encSecret),
      net: useTestnet ? 'testnet' : 'prod',
    }
  } catch (e: any) {
    console.error('[Binance] decrypt creds failed:', e.message)
    return null
  }
}

// ============================================================================
// Helpers: round to tick / step, format with precision.
// ============================================================================

/** Round price DOWN to nearest tick size for BUY-side maker, UP for SELL-side maker. */
export function roundPriceToTick(price: number, tickSize: number, side: OrderSide, mode: 'maker' | 'taker' = 'maker'): number {
  if (!tickSize) return price
  // For a maker BUY limit we want price <= target so it sits BELOW market without crossing.
  // For a maker SELL limit we want price >= target so it sits ABOVE market.
  const rounded = side === 'BUY'
    ? Math.floor(price / tickSize) * tickSize
    : Math.ceil(price / tickSize) * tickSize
  return Number(rounded.toFixed(12))
}

/** Round quantity DOWN to nearest step size (Binance rejects above-step qty). */
export function roundQtyToStep(qty: number, stepSize: number): number {
  if (!stepSize) return qty
  const rounded = Math.floor(qty / stepSize) * stepSize
  return Number(rounded.toFixed(12))
}

/** Format number to fixed precision string (Binance expects strings without scientific notation). */
export function fmt(n: number, precision: number): string {
  return n.toFixed(precision)
}
