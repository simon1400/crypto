/**
 * Daily Breakout — Variant C LIVE trader (Binance Futures USDT-M, real money).
 *
 * Mirrors the paper C trader's mechanics 1:1 (pre-emptive limit on rangeEdge,
 * pair cancel on fill, real TP/SL ladders, full trailing, EOD-FLAT 23:55 UTC),
 * but every action that paper simulates this service executes on Binance:
 *   - Placement → POST /fapi/v1/order LIMIT GTC
 *   - Pair cancel → DELETE /fapi/v1/order on the other side's clientOrderId
 *     triggered by ORDER_TRADE_UPDATE WS event with X=FILLED
 *   - TP1/TP2/TP3 → 3× TAKE_PROFIT_MARKET reduceOnly placed after entry fill
 *   - SL → STOP_MARKET reduceOnly placed after entry fill, replaced on each
 *     trailing step (TP1 hit → SL → BE; TP2 hit → SL → TP1)
 *   - EOD-FLAT → cancel TP/SL children + MARKET reduceOnly on remaining qty
 *
 * Reads BreakoutLiveConfigC (cfg.enabled, useTestnet, killSwitchActive,
 * circuit breaker, sizing knobs) and the shared BreakoutConfig for the
 * universe + rangeBars / volumeMultiplier (same source as paper A/B/C).
 *
 * Writes BreakoutLiveTradeC rows with exchange identifiers:
 *   binanceClientOrderId — our deterministic ID, format: 'cL{net}_{rangeDate}_{symbol}_{side}'
 *   binanceOrderId       — exchange-assigned, captured from placement response
 *   binanceSlOrderId / binanceTpOrderIds — child reduceOnly orders, captured after fill
 *
 * This file is the skeleton — placement, fill handling, trailing, and EOD are
 * implemented in follow-up commits. For now it just owns the start/stop
 * lifecycle and exposes hooks the WS layer + index.ts will call into.
 */

import { prisma } from '../db/prisma'
import {
  getBinanceClient, getBinanceCreds, BinanceFuturesClient, BinanceApiError,
  type SymbolFilter,
} from './exchanges/binanceFutures'
import {
  BinanceUserDataStream, BinanceMarketDataStream,
  type OrderTradeUpdateEvent, type AccountUpdateEvent,
} from './exchanges/binanceFuturesWs'
import { detectRange, BreakoutEngineConfig } from '../scalper/dailyBreakoutEngine'
import { loadHistorical } from '../scalper/historicalLoader'
import { fetchPricesBatch } from './market'
import { computeSizing } from './marginGuard'
import { DEFAULT_BREAKOUT_SETUPS } from './dailyBreakoutLiveScanner'
import { refreshLiveBalance } from '../routes/_liveBalanceShared'

const LOG = '[BreakoutLiveC]'

// Cache exchangeInfo filters for 1h — they don't change intraday and we'd
// otherwise hit /fapi/v1/exchangeInfo (weight 1) on every placement cycle.
let filtersCache: { at: number; map: Map<string, SymbolFilter> } | null = null
const FILTERS_TTL_MS = 60 * 60 * 1000

async function getFilters(client: BinanceFuturesClient): Promise<Map<string, SymbolFilter>> {
  if (filtersCache && Date.now() - filtersCache.at < FILTERS_TTL_MS) return filtersCache.map
  const map = await client.getSymbolFilters()
  filtersCache = { at: Date.now(), map }
  return map
}

/**
 * Build deterministic clientOrderId for an entry limit. Same range edge → same
 * cID, so retrying the cycle within the same day won't double-place. Binance
 * caps cID at 36 chars — we keep our scheme short.
 *   cL{net[0]}_{YYYYMMDD}_{SYMBOL_no_USDT}_{B|S}
 * Examples: cLt_20260518_BTC_B, cLp_20260518_DOGE_S
 */
function buildEntryCid(net: 'testnet' | 'prod', rangeDate: string, symbol: string, side: 'BUY' | 'SELL'): string {
  const compactDate = rangeDate.replace(/-/g, '')
  const ticker = symbol.replace(/USDT$/, '')
  return `cL${net[0]}_${compactDate}_${ticker}_${side[0]}`
}

// ============================================================================
// Lifecycle
// ============================================================================

interface RunningState {
  client: BinanceFuturesClient
  userDataWs: BinanceUserDataStream
  marketDataWs: BinanceMarketDataStream
  tickTimer: NodeJS.Timeout | null
  net: 'testnet' | 'prod'
}

let state: RunningState | null = null
let startInFlight = false

/**
 * Start the live trader. Idempotent — if already running, returns the existing
 * connection. If Strategy is disabled in config, leaves state=null (the tick
 * checks cfg.enabled on each iteration; this start is for WS connectivity).
 *
 * We start the WS streams regardless of enabled flag so the UI/status endpoint
 * has live position/balance data even when Strategy isn't trading.
 */
export async function startBreakoutLiveTraderC(): Promise<void> {
  if (state || startInFlight) return
  startInFlight = true
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) {
      console.log(`${LOG} no config row yet — skip start`)
      return
    }

    const creds = await getBinanceCreds(cfg.useTestnet)
    if (!creds) {
      console.log(`${LOG} no Binance creds for ${cfg.useTestnet ? 'testnet' : 'prod'} — skip start (configure on /settings)`)
      return
    }

    const client = getBinanceClient(creds)
    try {
      await client.syncTime()
    } catch (e: any) {
      console.warn(`${LOG} time sync failed: ${e.message} — defer start`)
      return
    }

    const userDataWs = new BinanceUserDataStream({
      net: creds.net,
      client,
      onEvent: (ev) => handleUserDataEvent(ev),
      onDisconnect: (reason) => console.warn(`${LOG} user data WS disconnected: ${reason}`),
    })
    await userDataWs.start()

    const marketDataWs = new BinanceMarketDataStream({
      net: creds.net,
      onAggTrade: (sym, price, ts) => handleAggTrade(sym, price, ts),
    })
    marketDataWs.start()

    // Slow tick — every 5 min, mirrors paper C cycle (placement + safety net + EOD).
    // Implementation lands in follow-up commits; for now it just logs heartbeat.
    const tickTimer = setInterval(() => {
      runLiveCycle().catch((e) => console.error(`${LOG} cycle error:`, e.message))
    }, 5 * 60 * 1000)

    state = { client, userDataWs, marketDataWs, tickTimer, net: creds.net }
    console.log(`${LOG} started (${creds.net})`)

    // Kick off one immediate cycle so subscriptions/reconciliation happen now,
    // not 5 min from now.
    runLiveCycle().catch((e) => console.error(`${LOG} initial cycle error:`, e.message))
  } finally {
    startInFlight = false
  }
}

export function stopBreakoutLiveTraderC(): void {
  if (!state) return
  console.log(`${LOG} stopping`)
  if (state.tickTimer) clearInterval(state.tickTimer)
  state.userDataWs.stop()
  state.marketDataWs.stop()
  state = null
}

/**
 * Restart the trader — used when credentials change (saved/deleted on /settings)
 * or when the user toggles testnet/prod. Drops connections, picks up fresh
 * creds from DB.
 */
export async function restartBreakoutLiveTraderC(): Promise<void> {
  stopBreakoutLiveTraderC()
  await startBreakoutLiveTraderC()
}

export function isRunning(): boolean { return state !== null }
export function currentNet(): 'testnet' | 'prod' | null { return state?.net ?? null }

// ============================================================================
// Cycle (5 min) — placement / safety net / EOD
// ============================================================================

let cycleBusy = false

async function runLiveCycle(): Promise<void> {
  if (cycleBusy) {
    // Re-entrancy guard per feedback_setinterval_reentrancy_guard memory.
    return
  }
  cycleBusy = true
  try {
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) return
    if (cfg.killSwitchActive) {
      console.log(`${LOG} kill switch active — cycle no-op`)
      return
    }
    if (!cfg.enabled) {
      // WS streams stay up for UI, but no trading. Refresh subscriptions to the
      // symbols of any still-open positions (handled in follow-up commit).
      return
    }
    if (!state) return  // service stopped between schedule and tick

    // Pre-emptive limit placement: one BUY + one SELL on rangeEdge for each
    // tracked symbol that has a formed 3h range today and no open record yet.
    await placeLimitsForRanges(cfg, state.client, state.net)

    // TODO (next commits):
    // - safety net fill check (cross 5m candle against limit price — Binance
    //   delivers FILLED via ORDER_TRADE_UPDATE, but if WS misses the event we
    //   reconcile by REST openOrders + 5m candles)
    // - EOD-FLAT at 23:55 UTC
    // - market data WS subscription diff (which symbols need aggTrade)
  } catch (e: any) {
    console.error(`${LOG} cycle threw:`, e.message)
  } finally {
    cycleBusy = false
  }
}

// ============================================================================
// Placement — pre-emptive limit pairs on rangeEdge (mirrors paper C, but real)
// ============================================================================

/**
 * For each enabled symbol with a formed 3h range today and no live row yet,
 * place ONE pair of LIMIT GTC orders on Binance: BUY @ rangeHigh + SELL @
 * rangeLow. Each placement creates a BreakoutLiveTradeC row with status
 * PENDING_LIMIT and the exchange order id / clientOrderId captured.
 *
 * Sizing is done HERE (at placement time, not at fill) because Binance locks
 * the margin when the order hits the book — we need to know how much qty fits
 * within the available balance and leverage. This differs from paper C where
 * sizing was deferred to fill; for live we can't ask the exchange to "size at
 * fill", and trying to place an order without committed sizing would be racy.
 *
 * Pair linkage: both rows are written first, then pairOrderId is filled into
 * each pointing at the other. Cancel cascade on fill uses this linkage.
 *
 * Idempotency: clientOrderId is deterministic per (net, rangeDate, symbol,
 * side), so even if the cycle runs twice within a day, Binance rejects the
 * second placement with -2014 (duplicate cID) and we don't create a duplicate
 * BreakoutLiveTradeC row.
 */
async function placeLimitsForRanges(
  cfg: any,
  client: BinanceFuturesClient,
  net: 'testnet' | 'prod',
): Promise<void> {
  // Same universe + range params as paper variants (single source of truth).
  const dbCfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  if (!dbCfg) return
  const symbols = (dbCfg.symbolsEnabled as string[]).length > 0
    ? dbCfg.symbolsEnabled as string[]
    : DEFAULT_BREAKOUT_SETUPS
  const engineCfg: BreakoutEngineConfig = {
    rangeBars: dbCfg.rangeBars,
    volumeMultiplier: dbCfg.volumeMultiplier,
    tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
  }

  const utcDate = new Date().toISOString().slice(0, 10)
  const todayStartUtc = new Date(`${utcDate}T00:00:00.000Z`)

  // Fresh balance snapshot for sizing — pulled once per cycle, all symbols share it.
  let available: number
  try {
    const bal = await refreshLiveBalance(client)
    available = bal.available
  } catch (e: any) {
    console.warn(`${LOG} skip cycle — balance fetch failed: ${e.message}`)
    return
  }
  if (available <= 0) {
    console.warn(`${LOG} skip cycle — zero available USDT`)
    return
  }

  const filters = await getFilters(client)

  for (const symbol of symbols) {
    try {
      // Skip if we already have any C-live row for this symbol today (PENDING,
      // OPEN, CLOSED — doesn't matter, only one pair per symbol per day).
      const existing = await prisma.breakoutLiveTradeC.findFirst({
        where: { symbol, openedAt: { gte: todayStartUtc } },
      })
      if (existing) continue

      const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
      const range = detectRange(candles, utcDate, engineCfg)
      if (!range) continue

      // SL distance guard — same as engine/paper.
      const slDistPct = (range.rangeSize / Math.min(range.rangeHigh, range.rangeLow)) * 100
      if (slDistPct < 0.4) continue

      let livePrice: number | null = null
      try {
        const prices = await fetchPricesBatch([symbol])
        const live = prices[symbol]
        if (live && live > 0) livePrice = live
      } catch { /* ok — place both sides if live price unknown */ }

      const canPlaceBuy = livePrice == null || livePrice <= range.rangeHigh
      const canPlaceSell = livePrice == null || livePrice >= range.rangeLow
      if (!canPlaceBuy && !canPlaceSell) continue

      const f = filters.get(symbol)
      if (!f) {
        console.warn(`${LOG} ${symbol} — not on Binance Futures, skipping`)
        continue
      }

      // Ensure leverage + margin type per symbol. Idempotent: setMarginType
      // swallows -4046 (already isolated), setLeverage just returns ok if same.
      try {
        await client.setMarginType(symbol, 'ISOLATED')
      } catch (e: any) {
        if (!(e instanceof BinanceApiError) || e.code !== -4046) {
          console.warn(`${LOG} ${symbol} setMarginType failed: ${e.message}`)
        }
      }

      const buyTpLadder = [
        range.rangeHigh + range.rangeSize * engineCfg.tp1Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp2Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp3Mult,
      ]
      const sellTpLadder = [
        range.rangeLow - range.rangeSize * engineCfg.tp1Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp2Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp3Mult,
      ]

      const placedRows: any[] = []
      const placedAt = new Date()

      // Place BUY @ rangeHigh
      if (canPlaceBuy) {
        const row = await placeOneSide({
          client, net, cfg, f, symbol, side: 'BUY',
          entryPrice: range.rangeHigh, stopLoss: range.rangeLow,
          tpLadder: buyTpLadder, rangeDate: utcDate, placedAt,
        })
        if (row) placedRows.push(row)
      }

      // Place SELL @ rangeLow
      if (canPlaceSell) {
        const row = await placeOneSide({
          client, net, cfg, f, symbol, side: 'SELL',
          entryPrice: range.rangeLow, stopLoss: range.rangeHigh,
          tpLadder: sellTpLadder, rangeDate: utcDate, placedAt,
        })
        if (row) placedRows.push(row)
      }

      // Link the pair so cancel cascade on fill works (one fill triggers cancel
      // of the other via REST DELETE).
      if (placedRows.length === 2) {
        await prisma.breakoutLiveTradeC.update({
          where: { id: placedRows[0].id }, data: { pairOrderId: placedRows[1].id },
        })
        await prisma.breakoutLiveTradeC.update({
          where: { id: placedRows[1].id }, data: { pairOrderId: placedRows[0].id },
        })
      }

      if (placedRows.length > 0) {
        const sides = placedRows.map(r => `${r.side}@${r.limitOrderPrice}`).join(', ')
        const adjusted = filters.get(symbol)?.quantityPrecision
        console.log(`${LOG} ${symbol} placed ${placedRows.length} limit(s) [range ${range.rangeHigh}/${range.rangeLow}, slDist ${slDistPct.toFixed(2)}%, prec ${adjusted}]: ${sides}`)
      }
    } catch (e: any) {
      console.warn(`${LOG} ${symbol} placement failed: ${e.message}`)
    }
  }
}

interface PlaceOneSideArgs {
  client: BinanceFuturesClient
  net: 'testnet' | 'prod'
  cfg: any
  f: SymbolFilter
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  tpLadder: number[]
  rangeDate: string
  placedAt: Date
}

/**
 * Single-side placement helper. Computes sizing, rounds to tick/step, places
 * the LIMIT order on Binance, and writes a PENDING_LIMIT row with the captured
 * exchange identifiers. Returns the row or null if placement was rejected.
 */
async function placeOneSide(a: PlaceOneSideArgs): Promise<any> {
  // Sizing — uses the configured risk/margin knobs and current balance.
  // Balance has already been refreshed for this cycle (passed into the cfg by
  // refreshLiveBalance via currentDepositUsd cache).
  const sizing = computeSizing({
    symbol: a.symbol,
    deposit: a.cfg.currentDepositUsd,
    riskPct: a.cfg.riskPctPerTrade,
    targetMarginPct: a.cfg.targetMarginPct,
    entry: a.entryPrice,
    sl: a.stopLoss,
  })
  if (!sizing || sizing.positionUnits <= 0) {
    console.warn(`${LOG} ${a.symbol} ${a.side} — sizing failed`)
    return null
  }

  // Apply requested leverage. Cap at the exchange's maxLeverage for this
  // symbol — Binance rejects setLeverage above tier limits, and we'd rather
  // size down than have the placement fail. setLeverage is idempotent.
  const targetLev = Math.max(1, Math.round(sizing.leverage))
  try {
    await a.client.setLeverage(a.symbol, targetLev)
  } catch (e: any) {
    console.warn(`${LOG} ${a.symbol} setLeverage(${targetLev}) failed: ${e.message} — placement may use exchange default`)
  }

  // Round price to tick. For maker BUY we want price <= target (won't cross);
  // for maker SELL price >= target. Binance LIMIT GTC sits in the book and
  // pays maker fee on fill.
  const tick = a.f.tickSize
  const priceRounded = a.side === 'BUY'
    ? Math.floor(a.entryPrice / tick) * tick
    : Math.ceil(a.entryPrice / tick) * tick

  // Round qty DOWN to step (Binance rejects qty above step granularity).
  const step = a.f.stepSize
  let qty = Math.floor(sizing.positionUnits / step) * step
  qty = Number(qty.toFixed(a.f.quantityPrecision))

  // Enforce min notional with $1 margin above the published floor (some testnet
  // pairs enforce a stricter floor than the filter advertises).
  const notional = qty * priceRounded
  const minNotional = Math.max(a.f.minNotional || 5, 5) + 1
  if (notional < minNotional || qty < a.f.minQty) {
    console.warn(`${LOG} ${a.symbol} ${a.side} — qty ${qty} × ${priceRounded} = ${notional.toFixed(2)} below minNotional ${minNotional}`)
    return null
  }

  const cid = buildEntryCid(a.net, a.rangeDate, a.symbol, a.side)

  let orderId: number
  let exchangePrice: number
  let exchangeQty: number
  try {
    const order = await a.client.placeOrder({
      symbol: a.symbol,
      side: a.side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: qty,
      price: Number(priceRounded.toFixed(a.f.pricePrecision)),
      newClientOrderId: cid,
    })
    orderId = order.orderId
    exchangePrice = Number(order.price)
    exchangeQty = Number(order.origQty)
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2014) {
      // Duplicate cID — order from a prior tick already exists. Skip silently.
      return null
    }
    console.warn(`${LOG} ${a.symbol} ${a.side} placement REJECTED: ${e.message}`)
    return null
  }

  // Persist row. signalId=0 because pre-emptive — no upstream BreakoutSignal
  // when we place (scanner creates one later on actual breakout, see paper C).
  const row = await prisma.breakoutLiveTradeC.create({
    data: {
      signalId: 0,
      symbol: a.symbol,
      side: a.side,
      entryPrice: exchangePrice,
      stopLoss: a.stopLoss,
      initialStop: a.stopLoss,
      currentStop: a.stopLoss,
      tpLadder: a.tpLadder as any,
      depositAtEntryUsd: a.cfg.currentDepositUsd,
      riskUsd: sizing.riskUsd,
      positionSizeUsd: exchangePrice * exchangeQty,
      positionUnits: exchangeQty,
      leverage: targetLev,
      marginUsd: (exchangePrice * exchangeQty) / targetLev,
      status: 'PENDING_LIMIT',
      limitOrderState: 'PENDING_LIMIT',
      limitOrderPrice: exchangePrice,
      limitPlacedAt: a.placedAt,
      openedAt: a.placedAt,
      feeTakerPct: a.cfg.feeTakerPct,
      feeMakerPct: a.cfg.feeMakerPct,
      slipTakerPct: a.cfg.slipTakerPct,
      autoTrailingSL: a.cfg.autoTrailingSL,
      binanceClientOrderId: cid,
      binanceOrderId: BigInt(orderId),
    },
  })
  return row
}

// ============================================================================
// User data WS handlers
// ============================================================================

async function handleUserDataEvent(ev: any): Promise<void> {
  switch (ev.e) {
    case 'ORDER_TRADE_UPDATE':
      await handleOrderUpdate(ev as OrderTradeUpdateEvent)
      break
    case 'ACCOUNT_UPDATE':
      await handleAccountUpdate(ev as AccountUpdateEvent)
      break
    case 'listenKeyExpired':
      console.warn(`${LOG} listenKey expired — WS layer will reconnect`)
      break
    default:
      // Unknown event — ignore (Binance occasionally adds new event types).
      break
  }
}

/**
 * Route an ORDER_TRADE_UPDATE event to the right handler based on which trade
 * row owns the order. Three categories:
 *   1. Entry limit (binanceClientOrderId or binanceOrderId match)
 *   2. SL child (binanceSlOrderId match)
 *   3. TP child (binanceTpOrderIds array contains the orderId)
 *
 * We use clientOrderId where possible (text, deterministic) and fall back to
 * orderId (numeric, exchange-assigned) for children since we don't generate
 * cIDs for SL/TP children — Binance assigns them.
 */
async function handleOrderUpdate(ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  const cid = o.c
  const orderId = o.i
  const execStatus = o.X // NEW / PARTIALLY_FILLED / FILLED / CANCELED / EXPIRED

  // 1. Entry limit — match by clientOrderId (deterministic).
  if (cid && cid.startsWith('cL')) {
    const trade = await prisma.breakoutLiveTradeC.findUnique({
      where: { binanceClientOrderId: cid },
    })
    if (trade) {
      await handleEntryOrderUpdate(trade, ev)
      return
    }
  }

  // 2. SL child — match by binanceSlOrderId.
  const tradeBySl = await prisma.breakoutLiveTradeC.findFirst({
    where: { binanceSlOrderId: BigInt(orderId) },
  })
  if (tradeBySl) {
    await handleSlOrderUpdate(tradeBySl, ev)
    return
  }

  // 3. TP child — orderId stored in tpOrderIds JSON array.
  const tradeByTp = await prisma.breakoutLiveTradeC.findFirst({
    where: {
      binanceTpOrderIds: { array_contains: String(orderId) as any },
    },
  })
  if (tradeByTp) {
    await handleTpOrderUpdate(tradeByTp, ev)
    return
  }

  // Order doesn't belong to any tracked trade — could be manual, or a stale
  // event for a row we've already finalized. Log only on actual fills.
  if (execStatus === 'FILLED') {
    console.log(`${LOG} untracked FILLED order cid=${cid} id=${orderId} ${o.s} — manual or already reconciled`)
  }
}

/**
 * Handle update for the entry LIMIT order. We care primarily about FILLED
 * (mark trade OPEN, cancel pair, place SL+TPs) and CANCELED/EXPIRED (mark
 * trade as cancelled if it never filled).
 */
async function handleEntryOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  const X = o.X

  if (X === 'FILLED') {
    // Idempotency: if we've already processed this fill (status moved past
    // PENDING_LIMIT), don't re-place children. Binance can deliver the same
    // event twice on reconnects.
    if (trade.limitOrderState !== 'PENDING_LIMIT') {
      return
    }

    const fillPrice = Number(o.ap) || Number(o.L) || trade.entryPrice
    const fillTime = new Date(o.T || ev.E)
    const cumQty = Number(o.z) || trade.positionUnits
    const feePaid = Number(o.n) || 0

    // Atomic claim — flip PENDING_LIMIT → FILLING, then to OPEN. Without this,
    // a duplicate WS event could double-place TP/SL children.
    const claim = await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'PENDING_LIMIT' },
      data: { limitOrderState: 'FILLING' },
    })
    if (claim.count !== 1) return  // someone else handling

    try {
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          status: 'OPEN',
          limitOrderState: 'FILLED',
          limitFilledAt: fillTime,
          openedAt: fillTime,
          entryPrice: fillPrice,
          positionUnits: cumQty,
          positionSizeUsd: fillPrice * cumQty,
          feesPaidUsd: { increment: feePaid },
          netPnlUsd: { decrement: feePaid },
        },
      })

      console.log(`${LOG} ✓ entry filled #${trade.id} ${trade.symbol} ${trade.side} @ ${fillPrice} qty ${cumQty}`)

      // Cancel the pair limit (if any) — one side filled, other no longer needed.
      // Best-effort: if cancel fails (e.g. already filled itself), surface but don't crash.
      if (trade.pairOrderId) {
        await cancelPairOrder(trade.pairOrderId)
      }

      // Place SL + TPs as reduceOnly children.
      await placeSlAndTpsForTrade(trade.id)
    } catch (e: any) {
      console.error(`${LOG} entry fill handler failed for #${trade.id}: ${e.message}`)
      // Try to rollback claim so next event can retry.
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      }).catch(() => { /* noop */ })
    }
    return
  }

  if (X === 'CANCELED' || X === 'EXPIRED') {
    // Only finalize if we haven't already (cancel cascade from pair fill may
    // have moved us to CANCELLED_OTHER_SIDE already).
    if (trade.limitOrderState === 'PENDING_LIMIT') {
      const reason = X === 'EXPIRED' ? 'CANCELLED_EOD' : 'CANCELLED_OTHER_SIDE'
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: reason,
          status: 'CANCELLED',
          closedAt: new Date(),
        },
      })
      console.log(`${LOG} entry ${X.toLowerCase()} #${trade.id} ${trade.symbol} ${trade.side}`)
    }
    return
  }
}

/**
 * Cancel the paired entry LIMIT order on Binance. Uses the live trader's
 * client (state.client) — caller should ensure state is set.
 */
async function cancelPairOrder(pairTradeId: number): Promise<void> {
  if (!state) return
  const pair = await prisma.breakoutLiveTradeC.findUnique({ where: { id: pairTradeId } })
  if (!pair || pair.limitOrderState !== 'PENDING_LIMIT') return  // already gone or filled

  try {
    await state.client.cancelOrder(pair.symbol, {
      origClientOrderId: pair.binanceClientOrderId ?? undefined,
    })
    // WS will deliver the CANCELED event which finalizes the row; but we mark
    // it now optimistically so the UI catches up immediately.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: pairTradeId, limitOrderState: 'PENDING_LIMIT' },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: new Date(),
      },
    })
    console.log(`${LOG} cancelled pair #${pairTradeId} ${pair.symbol} ${pair.side}`)
  } catch (e: any) {
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) {
      // -2011 unknown order (already cancelled), -2013 order does not exist — ok
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: pairTradeId, limitOrderState: 'PENDING_LIMIT' },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(),
        },
      })
      return
    }
    console.warn(`${LOG} cancel pair #${pairTradeId} failed: ${e.message}`)
  }
}

/**
 * After an entry fills, place the four reduceOnly children on Binance:
 *   - STOP_MARKET on stopLoss (SL)
 *   - 3× TAKE_PROFIT_MARKET on tpLadder (TP1/TP2/TP3), split 50/30/20
 *
 * Splits are notional-proportional in qty terms with step-size rounding.
 * Any leftover qty from rounding goes to TP3 so we don't leave dust on the
 * book unmonitored.
 */
async function placeSlAndTpsForTrade(tradeId: number): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade || trade.status !== 'OPEN') return

  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) {
    console.warn(`${LOG} #${tradeId} cannot place SL/TPs — no filter for ${trade.symbol}`)
    return
  }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const totalQty = trade.positionUnits

  // Split 50/30/20 with step-size rounding. Last bucket absorbs the remainder.
  const step = f.stepSize
  let tp1Qty = Math.floor((totalQty * 0.5) / step) * step
  let tp2Qty = Math.floor((totalQty * 0.3) / step) * step
  let tp3Qty = totalQty - tp1Qty - tp2Qty  // remainder
  // Round tp3Qty down to step to keep all qty grids aligned.
  tp3Qty = Math.floor(tp3Qty / step) * step
  tp1Qty = Number(tp1Qty.toFixed(f.quantityPrecision))
  tp2Qty = Number(tp2Qty.toFixed(f.quantityPrecision))
  tp3Qty = Number(tp3Qty.toFixed(f.quantityPrecision))

  const tpLadder = trade.tpLadder as number[]
  const tick = f.tickSize
  const roundStop = (p: number): number => Math.round(p / tick) * tick

  // SL — STOP_MARKET reduceOnly, closePosition=false (we explicitly set qty).
  // Using stopPrice = trade.currentStop (initially equals stopLoss).
  let slOrderId: bigint | null = null
  try {
    const slOrder = await state.client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: Number(roundStop(trade.currentStop).toFixed(f.pricePrecision)),
      quantity: totalQty,
      reduceOnly: true,
      workingType: 'MARK_PRICE',
    })
    slOrderId = BigInt(slOrder.orderId)
  } catch (e: any) {
    console.error(`${LOG} #${tradeId} SL placement failed: ${e.message}`)
  }

  // TPs — TAKE_PROFIT_MARKET reduceOnly, one per ladder level.
  const tpOrderIds: string[] = []
  const tpBuckets = [
    { price: tpLadder[0], qty: tp1Qty },
    { price: tpLadder[1], qty: tp2Qty },
    { price: tpLadder[2], qty: tp3Qty },
  ]
  for (let i = 0; i < tpBuckets.length; i++) {
    const bucket = tpBuckets[i]
    if (bucket.qty <= 0) continue
    try {
      const tpOrder = await state.client.placeOrder({
        symbol: trade.symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: Number(roundStop(bucket.price).toFixed(f.pricePrecision)),
        quantity: bucket.qty,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
      })
      tpOrderIds.push(String(tpOrder.orderId))
    } catch (e: any) {
      console.error(`${LOG} #${tradeId} TP${i + 1} placement failed: ${e.message}`)
    }
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      binanceSlOrderId: slOrderId,
      binanceTpOrderIds: tpOrderIds as any,
    },
  })
  console.log(`${LOG} #${tradeId} ${trade.symbol} children placed: SL=${slOrderId} TPs=${tpOrderIds.length}`)
}

/**
 * Handle SL order update — when STOP_MARKET fills, position is fully closed
 * (or partially if SL trailed up after TP1/TP2 and only the trailing slice
 * triggered). Records close and finalizes if no remaining qty.
 */
async function handleSlOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return  // ignore intermediate NEW/CANCELED

  const fillPrice = Number(o.ap) || Number(o.L) || trade.currentStop
  const fillQty = Number(o.z) || trade.positionUnits
  const realizedPnl = Number(o.rp) || 0
  const feePaid = Number(o.n) || 0
  const fillTime = new Date(o.T || ev.E)

  const closesArr = ((trade.closes as any[]) ?? []).slice()
  const totalClosedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0)
  const remainingPct = Math.max(0, 100 - totalClosedFrac)

  closesArr.push({
    price: fillPrice,
    percent: remainingPct,
    pnlUsd: realizedPnl,
    closedAt: fillTime.toISOString(),
    reason: 'SL',
  })

  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      closes: closesArr as any,
      realizedPnlUsd: { increment: realizedPnl },
      feesPaidUsd: { increment: feePaid },
      netPnlUsd: { increment: realizedPnl - feePaid },
      status: 'SL_HIT',
      closedAt: fillTime,
    },
  })

  // Cancel any remaining TP children so they don't fire and reopen exposure.
  await cancelRemainingChildren(trade.id, 'sl filled')

  console.log(`${LOG} ✗ SL hit #${trade.id} ${trade.symbol} @ ${fillPrice} pnl ${realizedPnl.toFixed(4)}`)
}

/**
 * Handle TP order update — when TAKE_PROFIT_MARKET fills, record partial close
 * and trail the SL: TP1 → SL to entry (BE), TP2 → SL to TP1.
 * After TP3 the position is fully out — cancel SL.
 */
async function handleTpOrderUpdate(trade: any, ev: OrderTradeUpdateEvent): Promise<void> {
  const o = ev.o
  if (o.X !== 'FILLED') return

  const fillPrice = Number(o.ap) || Number(o.L)
  const fillQty = Number(o.z) || 0
  const realizedPnl = Number(o.rp) || 0
  const feePaid = Number(o.n) || 0
  const fillTime = new Date(o.T || ev.E)

  // Figure out which TP this was (1/2/3) by matching orderId against the array.
  const tpIds = (trade.binanceTpOrderIds as string[]) ?? []
  const tpIndex = tpIds.indexOf(String(o.i))
  if (tpIndex === -1) {
    console.warn(`${LOG} TP fill for #${trade.id} but orderId ${o.i} not in tpOrderIds — drift`)
    return
  }
  const tpLabel = `TP${tpIndex + 1}`

  // Idempotency — don't double-record same TP.
  const closesArr = ((trade.closes as any[]) ?? []).slice()
  if (closesArr.some((c: any) => c.reason === tpLabel)) return

  // Calculate percent share of this TP (50/30/20 nominal). Use actual fillQty /
  // positionUnits in case rounding made it different.
  const percent = trade.positionUnits > 0
    ? Math.round((fillQty / trade.positionUnits) * 100)
    : (tpIndex === 0 ? 50 : tpIndex === 1 ? 30 : 20)

  closesArr.push({
    price: fillPrice,
    percent,
    pnlUsd: realizedPnl,
    closedAt: fillTime.toISOString(),
    reason: tpLabel,
  })

  // Trailing SL: after TP1 → SL to entry; after TP2 → SL to TP1 level.
  const tpLadder = trade.tpLadder as number[]
  let newStop = trade.currentStop
  let newStatus = trade.status
  if (tpIndex === 0) {
    newStop = trade.entryPrice  // BE
    newStatus = 'TP1_HIT'
  } else if (tpIndex === 1) {
    newStop = tpLadder[0]  // TP1 level
    newStatus = 'TP2_HIT'
  } else if (tpIndex === 2) {
    // TP3 — position fully out. Mark CLOSED, cancel any remaining children.
    newStatus = 'TP3_HIT'
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      closes: closesArr as any,
      realizedR: { increment: tpIndex === 0 ? 0.5 : tpIndex === 1 ? 0.6 : 0.6 }, // 50% × 1R, 30% × 2R, 20% × 3R
      realizedPnlUsd: { increment: realizedPnl },
      feesPaidUsd: { increment: feePaid },
      netPnlUsd: { increment: realizedPnl - feePaid },
      currentStop: newStop,
      status: newStatus,
      ...(tpIndex === 2 ? { closedAt: fillTime } : {}),
    },
  })

  console.log(`${LOG} ✓ ${tpLabel} hit #${trade.id} ${trade.symbol} @ ${fillPrice} pnl ${realizedPnl.toFixed(4)} → SL to ${newStop}`)

  if (tpIndex === 2) {
    // Full exit — cancel SL (no remaining qty for it to close).
    await cancelRemainingChildren(trade.id, 'tp3 filled')
  } else {
    // Trailing: replace the SL order at the new stop level.
    await replaceSlOrder(trade.id, newStop)
  }
}

/**
 * Replace the existing SL STOP_MARKET with a new one at a different stopPrice
 * (trailing). Cancels the old one first, places new, updates binanceSlOrderId.
 */
async function replaceSlOrder(tradeId: number, newStopPrice: number): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return

  // Compute remaining qty (positionUnits - already closed).
  const closesArr = ((trade.closes as any[]) ?? [])
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingQty = trade.positionUnits * (1 - closedFrac)
  if (remainingQty <= 0) return

  const filters = await getFilters(state.client)
  const f = filters.get(trade.symbol)
  if (!f) return

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const step = f.stepSize
  let qty = Math.floor(remainingQty / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) return

  const tick = f.tickSize
  const stopPriceRounded = Math.round(newStopPrice / tick) * tick

  // Cancel old SL (best-effort).
  if (trade.binanceSlOrderId) {
    try {
      await state.client.cancelOrder(trade.symbol, { orderId: Number(trade.binanceSlOrderId) })
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} #${tradeId} cancel old SL failed: ${e.message}`)
      }
    }
  }

  // Place new SL at trailing stop.
  let newSlOrderId: bigint | null = null
  try {
    const order = await state.client.placeOrder({
      symbol: trade.symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: Number(stopPriceRounded.toFixed(f.pricePrecision)),
      quantity: qty,
      reduceOnly: true,
      workingType: 'MARK_PRICE',
    })
    newSlOrderId = BigInt(order.orderId)
  } catch (e: any) {
    console.error(`${LOG} #${tradeId} replace SL failed at ${stopPriceRounded}: ${e.message}`)
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: {
      binanceSlOrderId: newSlOrderId,
      currentStop: stopPriceRounded,
    },
  })
}

/**
 * Cancel any still-open SL/TP children for a trade. Used when the trade is
 * fully closed (SL hit or TP3 hit) so leftover orders don't sit on the book
 * waiting to fire on a stale stop level.
 */
async function cancelRemainingChildren(tradeId: number, reason: string): Promise<void> {
  if (!state) return
  const trade = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!trade) return

  const toCancel: Array<{ id: number; kind: string }> = []
  if (trade.binanceSlOrderId) toCancel.push({ id: Number(trade.binanceSlOrderId), kind: 'SL' })
  for (const tpIdStr of ((trade.binanceTpOrderIds as string[]) ?? [])) {
    toCancel.push({ id: Number(tpIdStr), kind: 'TP' })
  }

  for (const c of toCancel) {
    try {
      await state.client.cancelOrder(trade.symbol, { orderId: c.id })
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        // -2011 / -2013: already cancelled or doesn't exist — ok.
        console.warn(`${LOG} #${tradeId} cancel ${c.kind} ${c.id} failed: ${e.message}`)
      }
    }
  }
  console.log(`${LOG} #${tradeId} ${trade.symbol} cancelled ${toCancel.length} children (${reason})`)
}

async function handleAccountUpdate(ev: AccountUpdateEvent): Promise<void> {
  // FUNDING_FEE → log to BreakoutLiveFundingC.
  if (ev.a?.m === 'FUNDING_FEE') {
    // TODO (funding logging commit): write BreakoutLiveFundingC rows
    return
  }
  // Position/balance updates feed reconciliation; for now we only consume them
  // implicitly via REST when the cycle/status endpoint queries.
}

// ============================================================================
// Market data WS — aggTrade safety net
// ============================================================================

function handleAggTrade(_sym: string, _price: number, _ts: number): void {
  // TODO (next commit): safety net for entry limit fill detection — Binance
  // fills the order on its side authoritatively, and ORDER_TRADE_UPDATE WS will
  // deliver the event. This aggTrade handler is reserved for virtual TP/SL
  // trigger logic that we won't use (we use real reduceOnly orders), but the
  // stream still gives us a fast freshness signal for the UI / cycle.
}
