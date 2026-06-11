/**
 * Market data WS — aggTrade safety net + virtual-limit fills.
 *
 * Each aggTrade tick on a tracked symbol with open positions runs trackLiveTrade()
 * to check if any TP/SL level has been crossed and sends MARKET reduceOnly when
 * so. (Entry fills still come from ORDER_TRADE_UPDATE on the user-data stream.)
 *
 * Virtual-limit fills also live here — when price crosses the stored
 * limitOrderPrice, we send MARKET reduceOnly=false to open the position.
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { computeSizing } from '../marginGuard'
import {
  LOG, state, snapshot, lastMarkPriceWs,
  lastAggTradeAt, lastTickProcessedAt, TICK_THROTTLE_MS, fillBusy, ACTIVE_STATUSES,
  fillRejectCount, MAX_FILL_REJECTS,
} from './state'
import { fmtPrice } from './formatters'
import { getFilters } from './filters'
import { sendLiveTelegram } from './telegram'
import { recordAttempt } from './attempts'
import { cancelPairOrder } from './wsHandlers'
import { attachSlAfterEntry } from './exchangeSl'
import { attachTpsAfterEntry } from './exchangeTp'
import { confirmExitsOnPrice } from './priceExit'
import { seedSnapshotFromRest } from './snapshot'
import { getLeverageBrackets, bracketMaxLeverageFor } from './brackets'

export function handleAggTrade(sym: string, price: number, ts: number): void {
  lastAggTradeAt.set(sym, ts)
  lastMarkPriceWs.set(sym, price)

  // Keep the snapshot's per-position markPrice in sync (no DB write — just
  // in-memory). Lets /status return current mark without a REST hit.
  if (snapshot.current) {
    const pos = snapshot.current.positions.find((p) => p.symbol === sym)
    if (pos) {
      pos.markPrice = price
      // Recompute unrealized for this position from the new mark.
      // Sign convention: long with markPrice > entry = positive.
      pos.unRealizedProfit = (price - pos.entryPrice) * pos.positionAmt
    }
  }

  const now = Date.now()
  const last = lastTickProcessedAt.get(sym) ?? 0
  if (now - last < TICK_THROTTLE_MS) return
  lastTickProcessedAt.set(sym, now)

  // Fire-and-forget, two independent jobs (both throttled by the tick gate above):
  //   1. ENTRY fills — cross of a PENDING_LIMIT level → MARKET open.
  //   2. EXIT confirm (variant C) — exchange SL/TP algo orders close the position
  //      by mark price, but on the prod Multi-Assets/BNFCR account the user-data
  //      WS delivers ZERO order events (proven 2026-06-08), so handleSlOrderUpdate
  //      / handleTpOrderUpdate never run. confirmExitsOnPrice uses this live
  //      bookTicker price as a TRIGGER: when it crosses a trade's SL or next TP,
  //      it spends one REST getOpenPositions to confirm + replays the exact same
  //      DB/trailing path (applyVirtualClose / finalizeOrphanRow). The exchange
  //      still does the actual close — this only confirms it in ~2s instead of
  //      the 60s reconcile, and revives SL→BE trailing. See priceExit.ts.
  void processAggTradeForSymbol(sym, price, ts)
  void confirmExitsOnPrice(sym, price).catch((e) =>
    console.warn(`${LOG} confirmExitsOnPrice ${sym} threw: ${e?.message ?? e}`))
}

async function processAggTradeForSymbol(sym: string, price: number, ts: number): Promise<void> {
  try {
    // Virtual limit fill — check PENDING_LIMIT rows; if price crossed the
    // limit level, send MARKET to open the position.
    const pending = await prisma.breakoutLiveTradeC.findMany({
      where: { symbol: sym, limitOrderState: 'PENDING_LIMIT' },
    })
    for (const t of pending) {
      await tryFillVirtualLimit(t, price, ts)
    }
  } catch (e: any) {
    console.warn(`${LOG} aggTrade entry-fill tracker ${sym} threw: ${e.message}`)
  }
}

/**
 * Try to fill a virtual PENDING_LIMIT row. Called from aggTrade WS handler.
 * For BUY: price must reach or exceed limitOrderPrice (= rangeHigh).
 * For SELL: price must drop to or below limitOrderPrice (= rangeLow).
 *
 * On cross:
 *   1. Atomic claim PENDING_LIMIT → FILLING via updateMany count check.
 *   2. Send MARKET reduceOnly=false for the stored qty.
 *   3. Move row to OPEN with the actual fill price from the MARKET response.
 *   4. Cancel the paired side (DB-only, mark CANCELLED_OTHER_SIDE).
 *   5. Place exchange-side STOP_MARKET safety-net (handled by attachSlAfterEntry).
 *
 * If MARKET placement fails (e.g. -2019 insufficient margin, -2027 max position),
 * we record the rejection and release the claim so a later tick can retry —
 * but if it's a structural rejection (sizing mismatch with current balance) the
 * retry will likely fail too. Mirrors paper C's fillLimitInner flow.
 */
async function tryFillVirtualLimit(trade: any, price: number, ts: number): Promise<void> {
  if (fillBusy.has(trade.id)) return
  if (!state.current) return

  const isLong = trade.side === 'BUY'
  const crossed = isLong ? price >= trade.limitOrderPrice : price <= trade.limitOrderPrice
  if (!crossed) return

  fillBusy.add(trade.id)
  try {
    // Atomic claim — prevent double-fill if two ticks fire concurrently.
    const claim = await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'PENDING_LIMIT' },
      data: { limitOrderState: 'FILLING' },
    })
    if (claim.count !== 1) return  // someone else got here first

    // Fill-time risk gates (moved here from placement 2026-05-21 — user wants
    // PENDING_LIMIT rows to NOT block other setups from being queued, only
    // check capacity when an actual fill is about to happen):
    //   1. maxConcurrentPositions (OPEN/TP1_HIT/TP2_HIT only — pendings excluded)
    //   2. Margin cap: locked + new ≤ 90% × walletBalance
    // If either gate fails, roll back to PENDING so the next tick can retry —
    // by then a different position may have closed and freed capacity.
    {
      const gateCfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
      const maxConcurrent = (gateCfg?.maxConcurrentPositions as number | undefined) ?? 20
      const activeRows = await prisma.breakoutLiveTradeC.findMany({
        where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
        select: { marginUsd: true, closes: true },
      })
      if (activeRows.length >= maxConcurrent) {
        console.log(`${LOG} fillVirtual #${trade.id} ${trade.symbol} — rolled back to PENDING: maxConcurrent ${activeRows.length}/${maxConcurrent}`)
        await prisma.breakoutLiveTradeC.updateMany({
          where: { id: trade.id, limitOrderState: 'FILLING' },
          data: { limitOrderState: 'PENDING_LIMIT' },
        })
        return
      }
      const lockedMargin = activeRows.reduce((sum, r) => {
        const closesArr = ((r.closes as any[]) ?? []) as Array<{ percent?: number }>
        const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
        return sum + (r.marginUsd ?? 0) * Math.max(0, 1 - closedFrac)
      }, 0)
      const walletTotal = snapshot.current?.total ?? gateCfg?.currentDepositUsd ?? 0
      const cap = walletTotal * 0.90
      const newMargin = trade.marginUsd ?? 0
      if (walletTotal > 0 && lockedMargin + newMargin > cap) {
        console.log(`${LOG} fillVirtual #${trade.id} ${trade.symbol} — rolled back to PENDING: margin cap ${lockedMargin.toFixed(2)}+${newMargin.toFixed(2)} > ${cap.toFixed(2)}`)
        await prisma.breakoutLiveTradeC.updateMany({
          where: { id: trade.id, limitOrderState: 'FILLING' },
          data: { limitOrderState: 'PENDING_LIMIT' },
        })
        return
      }
    }

    // Slippage / TP-cascade guard.
    //
    // If the trigger price is far above limitOrderPrice (LONG) or far below it
    // (SHORT) we'd open at a fill price that's already past one or more TP
    // levels. The exit tracker would then immediately register a TP hit on the
    // first tick after entry, trail SL to BE, and any pullback closes the
    // remainder at a loss after fees — the trade is "born dead" (observed
    // 2026-05-20 #4948 AVAX: limit $9.122, fill $9.281 — already past TP1
    // $9.186 and TP2 $9.250, instant TP1 → SL@BE → −$34 net).
    //
    // Two cumulative checks, whichever fires first cancels the trade:
    //   1. Slippage > 0.6% of limit price — much wider than normal MARKET
    //      execution; usually means the bot was offline through the breakout
    //      and the limit got triggered late.
    //   2. Trigger price already at/past TP1. tpLadder=[TP1,TP2,TP3], for
    //      LONG cancel if price >= TP1, for SHORT if price <= TP1.
    const tpLadder = (trade.tpLadder as number[]) ?? []
    const tp1 = tpLadder[0]
    const slippagePct = Math.abs(price - trade.limitOrderPrice) / trade.limitOrderPrice * 100
    const pastTp1 = tp1 !== undefined && (isLong ? price >= tp1 : price <= tp1)
    const SLIPPAGE_CAP_PCT = 0.6
    if (slippagePct > SLIPPAGE_CAP_PCT || pastTp1) {
      const reason = pastTp1
        ? `trigger price ${price} already at/past TP1 ${tp1}`
        : `slippage ${slippagePct.toFixed(2)}% > ${SLIPPAGE_CAP_PCT}% cap (limit ${trade.limitOrderPrice}, fill ref ${price})`
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} ${trade.side} — cancelling: ${reason}`)
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(ts),
        },
      })
      await recordAttempt({
        symbol: trade.symbol, side: trade.side,
        rangeDate: new Date(ts).toISOString().slice(0, 10),
        status: 'SKIPPED_FILTER',
        reasonCode: pastTp1 ? 'pastTp1' : 'slippage',
        reasonText: reason,
        limitPrice: trade.limitOrderPrice, markPrice: price,
      })
      return
    }

    const filters = await getFilters(state.current.client)
    const f = filters.get(trade.symbol)
    if (!f) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} — no symbol filter; rolling back to PENDING`)
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
      return
    }

    // Re-size at fill time using current deposit (paper C does this too — sizing
    // computed at placement may be stale if other C trades opened/closed since).
    // Use the limit level as the reference entry for risk calc — actual market
    // fill may be 0-2 ticks away.
    const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
    if (!cfg) {
      await prisma.breakoutLiveTradeC.updateMany({
        where: { id: trade.id, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
      return
    }
    // Sizing % basis = full wallet (walletBalance), not the shrinking available
    // balance. Same rule as placement.ts — keeps risk/margin a stable fraction
    // of total bankroll across the lifecycle of multiple concurrent positions.
    const sizingDeposit = snapshot.current?.total ?? cfg.currentDepositUsd
    const sizingAvailable = snapshot.current?.available ?? cfg.currentDepositUsd
    // Cap leverage by Binance's notional-tiered bracket for this symbol (same
    // logic as placement.ts). Without this, re-sizing at fill could pick a
    // leverage that the exchange refuses → -2027 → rate-limit storm.
    let exchangeMaxLev: number | undefined
    try {
      const brackets = await getLeverageBrackets(state.current.client)
      const slDist = Math.abs(trade.limitOrderPrice - trade.stopLoss)
      if (slDist > 0 && sizingDeposit > 0) {
        const riskUsdDry = (sizingDeposit * cfg.riskPctPerTrade) / 100
        const notionalDry = trade.limitOrderPrice * (riskUsdDry / slDist)
        exchangeMaxLev = bracketMaxLeverageFor(brackets.get(trade.symbol), notionalDry)
      }
    } catch (e: any) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol}: leverage brackets lookup failed: ${e.message}`)
    }
    const sizing = computeSizing({
      symbol: trade.symbol,
      deposit: sizingDeposit,
      riskPct: cfg.riskPctPerTrade,
      targetMarginPct: cfg.targetMarginPct,
      entry: trade.limitOrderPrice,
      sl: trade.stopLoss,
      exchangeMaxLeverage: exchangeMaxLev,
      availableUsd: sizingAvailable,
    })
    if (!sizing || sizing.positionUnits <= 0) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} sizing failed at fill — cancelling`)
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(ts),
        },
      })
      return
    }

    // Round qty DOWN to step (Binance rejects qty above step granularity).
    const step = f.stepSize
    let qtyPlanned = Math.floor(sizing.positionUnits / step) * step
    qtyPlanned = Number(qtyPlanned.toFixed(f.quantityPrecision))
    if (qtyPlanned < f.minQty) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} qty below minQty — cancelling`)
      await prisma.breakoutLiveTradeC.update({
        where: { id: trade.id },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: new Date(ts),
        },
      })
      return
    }

    const newLev = Math.max(1, Math.round(sizing.leverage))
    try {
      await state.current.client.setLeverage(trade.symbol, newLev)
    } catch (e: any) {
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} setLeverage(${newLev}) failed: ${e.message}`)
    }

    // Approximate fill — aggTrade tick price as the best initial guess. The
    // real avgPrice + commission arrives via ORDER_TRADE_UPDATE WS event for
    // this MARKET order, which handleEntryFillUpdate routes back into the row.
    // Binance's synchronous placeOrder response for MARKET returns avgPrice="0"
    // (the matching-engine fill hasn't been indexed yet), so we can't trust it.
    //
    // MARKET_LOT_SIZE cap: some low-cap perps have qty caps far below their
    // LIMIT cap (e.g. KAS LIMIT=1M but MARKET=10K, 1000BONK LIMIT=10M but
    // MARKET=100K). We split the requested qty into chunks of at most
    // marketMaxQty so the exchange doesn't reject -4005 "Quantity greater
    // than max quantity". Each chunk is its own MARKET; we tag them with
    // a suffix so handleEntryFillUpdate can still match them by the trade id
    // (it parses only the trade id from cid prefix 'enL{id}').
    let fillPrice = price
    let fillQty = qtyPlanned
    const entryCid = `enL${trade.id}`
    const marketCap = Math.max(f.minQty, f.marketMaxQty || qtyPlanned)
    const chunks: number[] = []
    if (qtyPlanned <= marketCap) {
      chunks.push(qtyPlanned)
    } else {
      let remaining = qtyPlanned
      while (remaining > 1e-9) {
        const chunk = Math.min(remaining, marketCap)
        // Round chunk down to step so each leg is a valid qty on its own.
        let qc = Math.floor(chunk / step) * step
        qc = Number(qc.toFixed(f.quantityPrecision))
        if (qc < f.minQty) break
        chunks.push(qc)
        remaining -= qc
      }
      console.log(`${LOG} fillVirtual #${trade.id} ${trade.symbol} qty ${qtyPlanned} > MARKET_LOT_SIZE.maxQty ${marketCap} — splitting into ${chunks.length} legs`)
    }

    try {
      let totalExecuted = 0
      for (let i = 0; i < chunks.length; i++) {
        const chunkQty = chunks[i]
        const cidForChunk = chunks.length === 1 ? entryCid : `${entryCid}_${i + 1}`
        const resp = await state.current.client.placeOrder({
          symbol: trade.symbol,
          side: trade.side,
          type: 'MARKET',
          quantity: chunkQty,
          newClientOrderId: cidForChunk,
          // No reduceOnly — this is the entry, opening a new position.
        })
        if (resp.executedQty && Number(resp.executedQty) > 0) {
          totalExecuted += Number(resp.executedQty)
        } else {
          totalExecuted += chunkQty
        }
      }
      if (totalExecuted > 0) {
        fillQty = totalExecuted
      }
      // Fee not estimated here — handleEntryFillUpdate writes the exact
      // commission from Binance's o.n into entryFeeUsd. Leaving feesPaidUsd=0
      // briefly until WS arrives is a tiny UI artifact vs the bigger problem
      // of mis-attributed fees the placeholder used to cause.
    } catch (e: any) {
      // Placement rejected. Structural rejections (sizing/leverage mismatch
      // with the symbol's bracket, MARKET_LOT_SIZE overflow that even chunking
      // can't fix) won't change on the next aggTrade tick — retrying just
      // hammers REST. Each rejected attempt = a signed POST, and at 50-500
      // ticks/sec on hot symbols this saturates the rate limit and triggers
      // IP bans (2026-05-20 AVAX: 2115 attempts in one day, all rejected with
      // -2027). Cancel the trade outright for any structural code; retry only
      // on transient ones.
      //
      //   -4005 Quantity greater than max quantity (MARKET_LOT_SIZE)
      //   -2027 Exceeded the maximum allowable position at current leverage
      //   -4131 Position size > position-bracket allowance
      //   -1111 Precision is over the maximum (sizing computed wrong qty)
      //   -1102 Mandatory parameter sent in wrong type
      //   -1106 Parameter sent when not required
      //
      // Other codes (-2019 insufficient margin, network glitches, etc.) stay
      // retry-able — those can clear by the next tick.
      const code = e instanceof BinanceApiError ? String(e.code) : 'unknown'
      console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} MARKET rejected (${code}): ${e.message}`)
      const STRUCTURAL_CODES = new Set(['-4005', '-2027', '-4131', '-1111', '-1102', '-1106'])
      const prevRejects = fillRejectCount.get(trade.id) ?? 0
      const nextRejects = prevRejects + 1
      fillRejectCount.set(trade.id, nextRejects)
      const exhaustedRetries = nextRejects >= MAX_FILL_REJECTS
      if (STRUCTURAL_CODES.has(code) || exhaustedRetries) {
        if (exhaustedRetries && !STRUCTURAL_CODES.has(code)) {
          console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} exhausted ${MAX_FILL_REJECTS} rejects on ${code} — cancelling to stop rate-limit storm`)
        }
        await prisma.breakoutLiveTradeC.update({
          where: { id: trade.id },
          data: {
            limitOrderState: 'CANCELLED_OTHER_SIDE',
            status: 'CANCELLED',
            closedAt: new Date(ts),
          },
        })
        fillRejectCount.delete(trade.id)
      } else {
        await prisma.breakoutLiveTradeC.updateMany({
          where: { id: trade.id, limitOrderState: 'FILLING' },
          data: { limitOrderState: 'PENDING_LIMIT' },
        })
      }
      await recordAttempt({
        symbol: trade.symbol, side: trade.side, rangeDate: new Date(ts).toISOString().slice(0, 10),
        status: 'REJECTED_EXCHANGE',
        reasonCode: code, reasonText: e.message,
        limitPrice: trade.limitOrderPrice, markPrice: price,
      })
      return
    }

    // REST refine of the exact avg fill. On the prod account the user-data WS
    // delivers ZERO ORDER_TRADE_UPDATE events (Multi-Assets mode, see
    // priceExit.ts), so handleEntryFillUpdate never refines entryPrice and it
    // would stay at the bookTicker trigger price forever. That shifted the
    // TP1→BE trail by the entry slippage (#49182 TRUMP 2026-06-11: trigger
    // 1.669, real avg fill 1.67 → "BE" stop one tick under true break-even).
    // The synchronous placeOrder response has avgPrice="0", but GET
    // /fapi/v1/order indexes the fill within ~1s — query each leg by its cid
    // and take the qty-weighted avg. Best-effort: on lookup failure we keep
    // the tick placeholder (boot reconcile heals it later).
    const legCids = chunks.length === 1 ? [entryCid] : chunks.map((_, i) => `${entryCid}_${i + 1}`)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise((res) => setTimeout(res, attempt === 1 ? 500 : 1000))
      if (!state.current) break
      let restQty = 0
      let restNotional = 0
      try {
        for (const cid of legCids) {
          const o = await state.current.client.getOrder(trade.symbol, { origClientOrderId: cid })
          const q = Number(o.executedQty)
          const ap = Number(o.avgPrice)
          if (q > 0 && ap > 0) {
            restQty += q
            restNotional += ap * q
          }
        }
      } catch (e: any) {
        console.warn(`${LOG} fillVirtual #${trade.id} ${trade.symbol} avgPrice lookup attempt ${attempt} failed: ${e?.message ?? e}`)
        continue
      }
      if (restQty > 0) {
        fillPrice = restNotional / restQty
        fillQty = restQty
        break
      }
    }

    const fillTime = new Date(ts)
    // Race protection: handleEntryFillUpdate can fire (via WS ORDER_TRADE_UPDATE)
    // before this row update completes — it sets binanceOrderId + exact entryPrice
    // from o.ap. Don't overwrite those exact fields with our aggTrade placeholder.
    // The updateMany only touches the trade row while binanceOrderId is still
    // null (WS hasn't refined yet); if WS already won, this is a no-op and the
    // exact avgPrice / qty / fee stay intact.
    //
    // No fees fields here — entry fee is owned by handleEntryFillUpdate
    // (writes entryFeeUsd from o.n, then recomputeTradeMoney rebuilds total).
    // The old `{ increment: feePaid }` placeholder caused race-dependent
    // double-charging / undercharging depending on WS event ordering.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, binanceOrderId: null },
      data: {
        entryPrice: fillPrice,
        positionUnits: fillQty,
        positionSizeUsd: fillPrice * fillQty,
        marginUsd: (fillPrice * fillQty) / newLev,
      },
    })

    // These fields are owned by the trader, not the WS refine — always set them.
    await prisma.breakoutLiveTradeC.update({
      where: { id: trade.id },
      data: {
        status: 'OPEN',
        limitOrderState: 'FILLED',
        limitFilledAt: fillTime,
        openedAt: fillTime,
        depositAtEntryUsd: sizingDeposit,
        riskUsd: sizing.riskUsd,
        leverage: newLev,
      },
    })

    fillRejectCount.delete(trade.id)
    console.log(`${LOG} ✓ virtual limit filled #${trade.id} ${trade.symbol} ${trade.side} @ ${fillPrice} (limit ${trade.limitOrderPrice}) qty ${fillQty}`)

    const sideText = trade.side === 'BUY' ? 'LONG' : 'SHORT'
    const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴'
    sendLiveTelegram([
      `${sideEmoji} <b>${trade.symbol}</b> <b>${sideText}</b>  · entry filled`,
      `━━━━━━━━━━━━━━━━━━`,
      `💰 Цена   <code>${fmtPrice(fillPrice)}</code>  · лимит <code>${fmtPrice(trade.limitOrderPrice)}</code>`,
      `📐 Размер <code>$${(fillPrice * fillQty).toFixed(2)}</code>  · ${fillQty} ед.`,
      `⚡ Плечо  <code>${newLev}x</code>`,
      `🛑 SL    <code>${fmtPrice(trade.stopLoss)}</code>`,
    ].join('\n'))

    // Cancel pair (DB-only).
    if (trade.pairOrderId) {
      await cancelPairOrder(trade.pairOrderId).catch(() => { /* noop */ })
    }

    // Subscribe aggTrade for this symbol (likely already subscribed via the
    // PENDING phase but idempotent) and attach safety-net SL on the exchange.
    await refreshAggTradeSubscriptions().catch(() => { /* noop */ })
    await attachSlAfterEntry(trade.id).catch((e) =>
      console.warn(`${LOG} attachSlAfterEntry threw: ${e?.message ?? e}`))
    await attachTpsAfterEntry(trade.id).catch((e) =>
      console.warn(`${LOG} attachTpsAfterEntry threw: ${e?.message ?? e}`))

    // Refresh balance — fee was just charged, margin was just locked, next
    // sizing cycle needs accurate currentDepositUsd.
    if (state.current) {
      await seedSnapshotFromRest(state.current.client, state.current.net, 'rest-refresh').catch((e) =>
        console.warn(`${LOG} post-fill balance refresh failed: ${e?.message ?? e}`))
    }
  } catch (e: any) {
    console.error(`${LOG} tryFillVirtualLimit threw for #${trade.id}: ${e.message}`)
    // Best-effort rollback so a stuck FILLING doesn't lock the trade forever.
    await prisma.breakoutLiveTradeC.updateMany({
      where: { id: trade.id, limitOrderState: 'FILLING' },
      data: { limitOrderState: 'PENDING_LIMIT' },
    }).catch(() => { /* noop */ })
  } finally {
    fillBusy.delete(trade.id)
  }
}

export function getLastAggTradeAt(symbol: string): number | undefined {
  return lastAggTradeAt.get(symbol)
}

/**
 * Diff aggTrade subscriptions to match the symbols with live activity.
 * Symbols with PENDING_LIMIT or OPEN/TP1_HIT/TP2_HIT rows get subscribed;
 * everything else gets unsubscribed. Idempotent — the WS layer's
 * setSubscriptions() handles the actual SUBSCRIBE/UNSUBSCRIBE diffing.
 */
export async function refreshAggTradeSubscriptions(): Promise<void> {
  if (!state.current) return
  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: {
      OR: [
        { limitOrderState: 'PENDING_LIMIT' },
        { status: { in: [...ACTIVE_STATUSES] } },
      ],
    },
    select: { symbol: true },
  })
  const symbols = Array.from(new Set(rows.map((r) => r.symbol)))
  state.current.marketDataWs.setSubscriptions(symbols)
}
