/**
 * Placement — pre-emptive limit pairs on rangeEdge (mirrors paper C, but real).
 *
 * For each enabled symbol with a formed 3h range today and no live row yet,
 * write ONE pair of virtual LIMIT rows: BUY @ rangeHigh + SELL @ rangeLow.
 * Each placement creates a BreakoutLiveTradeC row with status PENDING_LIMIT.
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
 * side), so even if the cycle runs twice within a day, P2002 unique-constraint
 * rejection prevents duplicates.
 */

import { prisma } from '../../db/prisma'
import {
  BinanceFuturesClient, BinanceApiError, type SymbolFilter,
} from '../exchanges/binanceFutures'
import { detectRange, BreakoutEngineConfig } from '../../scalper/dailyBreakoutEngine'
import { loadHistorical } from '../../scalper/historicalLoader'
import { computeSizing } from '../marginGuard'
import { DEFAULT_BREAKOUT_SETUPS } from '../dailyBreakoutLiveScanner'
import { LOG } from './state'
import { buildEntryCid } from './formatters'
import { getFilters } from './filters'
import { getLiveSnapshot } from './snapshot'
import { isLiveCircuitBreakerTripped, cancelAllPendingForBreaker, maybeNotifyBreaker } from './breaker'
import { recordAttempt } from './attempts'

export async function placeLimitsForRanges(
  cfg: any,
  client: BinanceFuturesClient,
  net: 'testnet' | 'prod',
): Promise<void> {
  // Daily circuit breaker. Per user decision 2026-05-17, live C in tripped state:
  //   - Blocks NEW limit placements
  //   - Also CANCELS any still-pending limits on the exchange
  // (Paper C only blocks new — live is stricter for real-money safety.)
  const cb = await isLiveCircuitBreakerTripped(cfg)
  if (cb.tripped) {
    console.warn(`${LOG} ${cb.reason} — blocking new placements + cancelling pending for the rest of UTC day`)
    await cancelAllPendingForBreaker(client, cb.reason)
    // One alert per UTC day — guarded by breakerGuard at module scope.
    await maybeNotifyBreaker(cb)
    return
  }

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

  // Pull available balance from the WS-driven snapshot. No REST call — the
  // snapshot is updated by ACCOUNT_UPDATE on every fill / TP / SL / funding.
  // getLiveSnapshot() will refresh from REST if older than the staleness
  // threshold (30s).
  const snap = await getLiveSnapshot()
  if (!snap || snap.total <= 0) {
    console.warn(`${LOG} skip cycle — no balance snapshot or zero USDT`)
    return
  }

  // Two-part risk gate, mirroring paper trader's invariants:
  //   1. Max concurrent OPEN positions ≤ cfg.maxConcurrentPositions (default 20)
  //   2. Total locked margin (existing + new) ≤ 90% × walletBalance
  // Both are evaluated against the DB rows so PENDING_LIMIT counts toward the
  // budget too — a pre-placed limit may fill in seconds and lock the margin.
  // Without that, the cycle would happily put more than 20 pair-limits on the
  // book and overshoot the cap on a fast-fill day.
  const maxConcurrent = (cfg.maxConcurrentPositions as number | undefined) ?? 20
  const activeRowsForBudget = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { status: { in: [...['OPEN', 'TP1_HIT', 'TP2_HIT']] } },
        { limitOrderState: 'PENDING_LIMIT' },
      ],
    },
    select: {
      status: true,
      limitOrderState: true,
      positionSizeUsd: true,
      marginUsd: true,
      leverage: true,
      closes: true,
    },
  })
  const openOrPendingCount = activeRowsForBudget.length
  const lockedMarginUsd = activeRowsForBudget.reduce((sum, r) => {
    // For active positions we discount the closed fraction (TP1/TP2 already
    // released that share of margin). For pending limits the full marginUsd
    // is the worst-case lock should they fill.
    const closesArr = ((r.closes as any[]) ?? []) as Array<{ percent?: number }>
    const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
    const remainingFrac = Math.max(0, 1 - closedFrac)
    return sum + (r.marginUsd ?? 0) * remainingFrac
  }, 0)
  // 90% of walletBalance is the hard ceiling; the remaining 10% is buffer
  // for funding, exit slippage, and the pair-fill race window.
  const totalBudget = snap.total * 0.90
  const remainingBudget = Math.max(0, totalBudget - lockedMarginUsd)

  if (openOrPendingCount >= maxConcurrent) {
    console.log(`${LOG} skip cycle — concurrent positions cap reached (${openOrPendingCount}/${maxConcurrent})`)
    return
  }
  if (remainingBudget <= 0) {
    console.log(`${LOG} skip cycle — margin budget exhausted (locked ${lockedMarginUsd.toFixed(2)} / ${totalBudget.toFixed(2)})`)
    return
  }

  // Pass the live budget down into placeOneSide so each placement checks
  // against the live cap. We mutate them as we go through the loop so the
  // count/budget update during the cycle (a placed pair locks margin
  // immediately).
  const budgetState = {
    placedCount: openOrPendingCount,
    locked: lockedMarginUsd,
    walletTotal: snap.total,
    maxConcurrent,
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

      // Live C trades on Binance — use Binance klines for range detection so
      // rangeHigh/rangeLow match the order book we're placing limits into.
      // (Paper variants use Bybit historical; live is exchange-aligned.)
      let candles: any[]
      try {
        // Binance USDT-M Futures — many perp-only pairs (FARTCOIN, KAS,
        // USELESS, SIREN, AERO, VVV, 1000BONK, UB, VANA) are not on the spot
        // endpoint at all and would 400 'Invalid symbol'. We trade on futures,
        // klines must come from there too.
        candles = await loadHistorical(symbol, '5m', 1, 'binance-futures')
      } catch (e: any) {
        // Not on Binance for this network (common on testnet for newer pairs),
        // or transient 400. Recorded as one SKIPPED_FILTER per cycle so the
        // user can see why those symbols never show up in Pending.
        console.warn(`${LOG} ${symbol} placement failed: ${e.message}`)
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'klines', reasonText: e.message,
        })
        continue
      }
      const range = detectRange(candles, utcDate, engineCfg)
      if (!range) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'noRange',
          reasonText: 'no 3h range detected for today yet',
        })
        continue
      }

      // SL distance guard — same as engine/paper.
      const slDistPct = (range.rangeSize / Math.min(range.rangeHigh, range.rangeLow)) * 100
      if (slDistPct < 0.4) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'slDist',
          reasonText: `range too tight: ${slDistPct.toFixed(2)}% < 0.4%`,
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }

      const f = filters.get(symbol)
      if (!f) {
        console.warn(`${LOG} ${symbol} — not on Binance Futures, skipping`)
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_FILTER',
          reasonCode: 'noFilter',
          reasonText: 'symbol not on Binance Futures',
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }

      // Virtual placement — DB only, no exchange order. We use markPrice purely
      // to skip the "price already broke out" case (paper wouldn't open either
      // since paper requires `candle.high >= rangeHigh` AFTER placement to fill).
      // We do NOT use it for marketable check — there's no exchange order to be
      // marketable against.
      let livePrice: number | null = null
      try {
        livePrice = await client.getMarkPrice(symbol)
      } catch {
        // markPrice unavailable — proceed anyway. Virtual placement doesn't
        // need price; the only risk is opening past a level that already broke
        // out far. Acceptable on the margin.
      }

      // Hopeless-chase skip: if price is more than 1× rangeSize past either
      // edge, this signal is already burnt — paper wouldn't open either since
      // the breakout candle has already closed beyond the level.
      if (livePrice != null && isFinite(livePrice) && livePrice > 0) {
        if (livePrice > range.rangeHigh + range.rangeSize) {
          await recordAttempt({
            symbol, side: 'BUY', rangeDate: utcDate,
            status: 'SKIPPED_GATE',
            reasonCode: 'farBreakout',
            reasonText: `price ${livePrice} > rangeHigh ${range.rangeHigh} + rangeSize ${range.rangeSize} — already broke out`,
            limitPrice: range.rangeHigh, markPrice: livePrice,
            rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
          })
          continue
        }
        if (livePrice < range.rangeLow - range.rangeSize) {
          await recordAttempt({
            symbol, side: 'SELL', rangeDate: utcDate,
            status: 'SKIPPED_GATE',
            reasonCode: 'farBreakout',
            reasonText: `price ${livePrice} < rangeLow ${range.rangeLow} - rangeSize ${range.rangeSize} — already broke out`,
            limitPrice: range.rangeLow, markPrice: livePrice,
            rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
          })
          continue
        }
      }

      // Set leverage + isolated margin ONCE per symbol per day. Even though
      // there's no order yet, the eventual MARKET fill will use these settings.
      // setLeverage / setMarginType are idempotent (swallow -4046 already-set).
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

      // Re-check the cap before EACH pair — earlier iterations of this loop
      // may have placed pairs that pushed us over. The remaining budget is
      // updated inside placeOneSide via budgetState mutations.
      if (budgetState.placedCount >= budgetState.maxConcurrent) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_GATE',
          reasonCode: 'maxConcurrent',
          reasonText: `${budgetState.placedCount} / ${budgetState.maxConcurrent} concurrent positions`,
          limitPrice: range.rangeHigh, markPrice: livePrice ?? range.rangeHigh,
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }
      const liveBudgetRemaining = budgetState.walletTotal * 0.90 - budgetState.locked
      if (liveBudgetRemaining <= 0) {
        await recordAttempt({
          symbol, side: 'BUY', rangeDate: utcDate,
          status: 'SKIPPED_GATE',
          reasonCode: 'margin',
          reasonText: `budget exhausted: locked ${budgetState.locked.toFixed(2)} / cap ${(budgetState.walletTotal * 0.90).toFixed(2)}`,
          limitPrice: range.rangeHigh, markPrice: livePrice ?? range.rangeHigh,
          rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        })
        continue
      }

      // Place BUY @ rangeHigh (virtual — DB only)
      const buyRow = await placeOneSide({
        client, net, cfg, f, symbol, side: 'BUY',
        entryPrice: range.rangeHigh, stopLoss: range.rangeLow,
        tpLadder: buyTpLadder, rangeDate: utcDate, placedAt,
        markPrice: livePrice ?? range.rangeHigh,
        rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        budgetState,
      })
      if (buyRow) placedRows.push(buyRow)

      // Place SELL @ rangeLow (virtual — DB only)
      const sellRow = await placeOneSide({
        client, net, cfg, f, symbol, side: 'SELL',
        entryPrice: range.rangeLow, stopLoss: range.rangeHigh,
        tpLadder: sellTpLadder, rangeDate: utcDate, placedAt,
        markPrice: livePrice ?? range.rangeLow,
        rangeHigh: range.rangeHigh, rangeLow: range.rangeLow,
        budgetState,
      })
      if (sellRow) placedRows.push(sellRow)

      // Link the pair so cancel cascade on fill works (one fill marks the
      // other CANCELLED_OTHER_SIDE in DB — no exchange call needed since the
      // pair is virtual).
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
        console.log(`${LOG} ${symbol} placed ${placedRows.length} virtual limit(s) [range ${range.rangeHigh}/${range.rangeLow}, slDist ${slDistPct.toFixed(2)}%, prec ${adjusted}]: ${sides}`)
      }
    } catch (e: any) {
      console.warn(`${LOG} ${symbol} placement failed: ${e.message}`)
    }
  }
}

interface BudgetState {
  placedCount: number   // total OPEN+TP1_HIT+TP2_HIT+PENDING_LIMIT rows so far
  locked: number        // total margin USD already committed
  walletTotal: number   // snap.total at start of cycle — used as 90% cap base
  maxConcurrent: number // cfg.maxConcurrentPositions
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
  // Audit context — passed through so attempt rows have full picture even
  // if the placement fails at a downstream step (sizing, exchange reject).
  markPrice: number
  rangeHigh: number
  rangeLow: number
  // Live budget state mutated by each successful placement so subsequent
  // attempts respect the cap in real-time within the same cycle.
  budgetState: BudgetState
}

/**
 * Virtual limit — writes a PENDING_LIMIT row to DB. No order is placed on the
 * exchange. The order is filled by the aggTrade WS watcher (tryFillVirtualLimit)
 * which sends MARKET reduceOnly=false when price crosses limitOrderPrice.
 *
 * This mirrors paper C 1:1: paper holds limits in DB and "fills" them when the
 * candle high/low crosses the level. We do the same with WS aggTrade for sub-
 * second latency. The previous design used GTX post-only on the exchange but
 * narrow ranges had book spread overlapping rangeEdge → 99%+ -5022 rejection.
 */
async function placeOneSide(a: PlaceOneSideArgs): Promise<any> {
  // Sizing — uses the configured risk/margin knobs and current balance.
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
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'sizing',
      reasonText: 'sizing returned zero units',
      limitPrice: a.entryPrice, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  // Two-part live budget gate (mirrors paper trader's invariants):
  //   1. Concurrent position cap (cfg.maxConcurrentPositions, default 20)
  //   2. Margin cap: locked + new ≤ 90% × walletBalance
  // Both are measured against walletBalance (not availableBalance), because
  // availableBalance already excludes locked margin — using it as the budget
  // base double-counts the lock and silently caps us at ~60% utilization
  // (bug report 2026-05-20 #3). 10% buffer covers funding, exit slippage,
  // and the pair-fill race window.
  const b = a.budgetState
  if (b.placedCount >= b.maxConcurrent) {
    const msg = `concurrent cap ${b.placedCount}/${b.maxConcurrent}`
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_GATE',
      reasonCode: 'maxConcurrent', reasonText: msg,
      limitPrice: a.entryPrice, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }
  const cap = b.walletTotal * 0.90
  const required = sizing.marginUsd
  if (b.locked + required > cap) {
    const msg = `margin cap: locked ${b.locked.toFixed(2)} + new ${required.toFixed(2)} > ${cap.toFixed(2)} (90% × wallet ${b.walletTotal.toFixed(2)})`
    console.log(`${LOG} ${a.symbol} ${a.side} — skip: ${msg}`)
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'margin', reasonText: msg,
      limitPrice: a.entryPrice, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  const targetLev = Math.max(1, Math.round(sizing.leverage))

  // Round price to tick (limitOrderPrice is the trigger level; we use exactly
  // rangeHigh/rangeLow, no offsets, no spread compensation — mirrors paper).
  const tick = a.f.tickSize
  const priceRounded = a.side === 'BUY'
    ? Math.floor(a.entryPrice / tick) * tick
    : Math.ceil(a.entryPrice / tick) * tick

  // Round qty DOWN to step.
  const step = a.f.stepSize
  let qty = Math.floor(sizing.positionUnits / step) * step
  qty = Number(qty.toFixed(a.f.quantityPrecision))

  const notional = qty * priceRounded
  const minNotional = Math.max(a.f.minNotional || 5, 5) + 1
  if (notional < minNotional || qty < a.f.minQty) {
    const msg = `qty ${qty} × ${priceRounded} = ${notional.toFixed(2)} below minNotional ${minNotional}`
    console.warn(`${LOG} ${a.symbol} ${a.side} — ${msg}`)
    await recordAttempt({
      symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
      status: 'SKIPPED_FILTER',
      reasonCode: 'minNotional', reasonText: msg,
      limitPrice: priceRounded, markPrice: a.markPrice,
      rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
    })
    return null
  }

  const cid = buildEntryCid(a.net, a.rangeDate, a.symbol, a.side)

  let row: any
  try {
    row = await prisma.breakoutLiveTradeC.create({
      data: {
        signalId: 0,
        symbol: a.symbol,
        side: a.side,
        entryPrice: priceRounded,
        stopLoss: a.stopLoss,
        initialStop: a.stopLoss,
        currentStop: a.stopLoss,
        tpLadder: a.tpLadder as any,
        depositAtEntryUsd: a.cfg.currentDepositUsd,
        riskUsd: sizing.riskUsd,
        positionSizeUsd: priceRounded * qty,
        positionUnits: qty,
        leverage: targetLev,
        marginUsd: (priceRounded * qty) / targetLev,
        status: 'PENDING_LIMIT',
        limitOrderState: 'PENDING_LIMIT',
        limitOrderPrice: priceRounded,
        limitPlacedAt: a.placedAt,
        openedAt: a.placedAt,
        feeTakerPct: a.cfg.feeTakerPct,
        feeMakerPct: a.cfg.feeMakerPct,
        slipTakerPct: a.cfg.slipTakerPct,
        autoTrailingSL: a.cfg.autoTrailingSL,
        binanceClientOrderId: cid,
        // binanceOrderId stays null — entry is filled via MARKET on aggTrade
        // crossing, not via a real LIMIT order on the exchange.
      },
    })
  } catch (e: any) {
    // Duplicate cID — row from prior cycle already exists. Skip silently.
    if (e.code === 'P2002') return null
    throw e
  }

  await recordAttempt({
    symbol: a.symbol, side: a.side, rangeDate: a.rangeDate,
    status: 'PLACED',
    reasonCode: null, reasonText: null,
    limitPrice: priceRounded, markPrice: a.markPrice,
    rangeHigh: a.rangeHigh, rangeLow: a.rangeLow,
  })

  // Update the live budget so the next iteration of the placement loop sees
  // this slot/margin as taken. Margin used is what we actually stored on the
  // row (could differ from sizing.marginUsd if qty got rounded down).
  b.placedCount += 1
  b.locked += (priceRounded * qty) / targetLev

  return row
}
