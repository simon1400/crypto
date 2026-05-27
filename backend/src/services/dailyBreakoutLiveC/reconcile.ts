/**
 * Reconciliation — sync DB ↔ exchange on startup.
 *
 * Compare DB BreakoutLiveTradeC rows against the exchange. Detects drift
 * caused by:
 *   - Process down while positions closed (DB still says OPEN)
 *   - Manual trading on the same account (positions/orders we never placed)
 *   - Pre-virtual-limit refactor leftover orders ('cL' LIMITs still on book)
 *
 * Policy:
 *   - Migration: cancel any pre-existing 'cL' LIMIT exchange orders + mark
 *     their DB rows CANCELLED so the new virtual cycle places fresh pairs.
 *   - DB OPEN with no matching exchange position → mark CLOSED (filled by
 *     SL/TP while we were down); exact P&L will be reconciled later.
 *   - Exchange position without matching DB row → flag as untracked, caller
 *     decides what to do (typically: kill switch + manual review).
 */

import { prisma } from '../../db/prisma'
import type { BinanceFuturesClient, UserTrade } from '../exchanges/binanceFutures'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, state, ACTIVE_STATUSES } from './state'
import { getFilters } from './filters'
import { attachSlAfterEntry, cancelSlOnExchange } from './exchangeSl'
import { attachTpsAfterEntry, cancelAllTpsOnExchange } from './exchangeTp'
import { sendLiveTelegram } from './telegram'
import { closeFullPositionMarket } from './closeHelper'

export interface ReconcileReport {
  hasUntrackedPositions: boolean
  hasUntrackedOrders: boolean
  summary: string
  details: {
    untrackedPositions: Array<{ symbol: string; amt: number }>
    untrackedOrders: Array<{ symbol: string; orderId: number; cid: string; type: string }>
    missingPositionsForDbOpen: number
  }
}

export async function reconcileWithExchange(client: BinanceFuturesClient): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    hasUntrackedPositions: false,
    hasUntrackedOrders: false,
    summary: '',
    details: {
      untrackedPositions: [],
      untrackedOrders: [],
      missingPositionsForDbOpen: 0,
    },
  }

  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  let openOrders: Awaited<ReturnType<typeof client.getOpenOrders>>
  try {
    [positions, openOrders] = await Promise.all([
      client.getOpenPositions(),
      client.getOpenOrders(),
    ])
  } catch (e: any) {
    console.error(`${LOG} reconcile: exchange query failed: ${e.message} — skipping`)
    return report
  }

  // --- DB side ---
  const dbOpen = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })

  const positionsBySymbol = new Map<string, { amt: number; entryPrice: number }>()
  for (const p of positions) {
    positionsBySymbol.set(p.symbol, {
      amt: Number(p.positionAmt),
      entryPrice: Number(p.entryPrice),
    })
  }

  // --- Migration cleanup: cancel any leftover 'cL' LIMIT entry orders on the
  // exchange (from the pre-virtual-limit version) and finalize their DB rows.
  // Virtual-limit refactor 2026-05-19: entries no longer publish to the book.
  // Any 'cL' order found on the exchange is a relic of the prior code path —
  // safe to cancel without checking DB state because we don't open new ones.
  let migrationCancelled = 0
  for (const o of openOrders) {
    if (!o.clientOrderId?.startsWith('cL')) continue
    if (o.type !== 'LIMIT') continue  // safety check; cL* is only used for LIMIT entries
    try {
      await client.cancelOrder(o.symbol, { orderId: o.orderId })
      migrationCancelled++
    } catch (e: any) {
      if (!(e instanceof BinanceApiError) || (e.code !== -2011 && e.code !== -2013)) {
        console.warn(`${LOG} migration cancel ${o.symbol} cid=${o.clientOrderId} failed: ${e.message}`)
      }
    }
  }
  if (migrationCancelled > 0) {
    console.log(`${LOG} migration: cancelled ${migrationCancelled} leftover exchange LIMIT order(s) from pre-virtual era`)
  }

  // Finalize any DB PENDING_LIMIT row that has binanceOrderId set (i.e. was
  // placed on the exchange under the old model). Mark them CANCELLED so the
  // new virtual cycle places a fresh pair on its next tick.
  const oldPlaced = await prisma.breakoutLiveTradeC.updateMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      binanceOrderId: { not: null },
    },
    data: {
      limitOrderState: 'CANCELLED_OTHER_SIDE',
      status: 'CANCELLED',
      closedAt: new Date(),
    },
  })
  if (oldPlaced.count > 0) {
    console.log(`${LOG} migration: marked ${oldPlaced.count} stale exchange-backed PENDING rows as CANCELLED`)
  }

  // --- DB OPEN vs exchange positions ---
  // Our DB says we're in a position. If exchange has zero amt for the symbol,
  // SL or TP fully closed it while we were down.
  // Also: if position is still there, make sure the safety-net SL exists on
  // the exchange — bot restart shouldn't leave positions exposed.
  for (const t of dbOpen) {
    const exchangePos = positionsBySymbol.get(t.symbol)
    if (exchangePos && exchangePos.amt !== 0) {
      // Position alive — ensure the safety-net SL is in place.
      if (!t.binanceSlOrderId) {
        await attachSlAfterEntry(t.id).catch((e) =>
          console.warn(`${LOG} reconcile: attachSl #${t.id} threw: ${e?.message ?? e}`))
      }

      // Ensure exchange-side TP ladder is in place for fresh OPEN positions
      // that don't have it yet (typically: post-migration or restart between
      // entry-fill and attachTpsAfterEntry). Only place when status === 'OPEN'
      // AND binanceTpOrderIds is empty — for TP1_HIT/TP2_HIT, partial TPs
      // were already executed and re-placing them would double-close on the
      // next price touch. Those continue to exit via the virtual tracker.
      const tpAlgos = ((t.binanceTpOrderIds as any[]) ?? []) as Array<unknown>
      if (t.status === 'OPEN' && tpAlgos.length === 0) {
        await attachTpsAfterEntry(t.id).catch((e) =>
          console.warn(`${LOG} reconcile: attachTps #${t.id} threw: ${e?.message ?? e}`))
      }

      // Heal entryPrice drift. Earlier rows may have been written with the
      // aggTrade placeholder price (rangeEdge) when ORDER_TRADE_UPDATE was
      // missed or lost the race to tryFillVirtualLimit's update. The exchange
      // has the authoritative avg fill — copy it in so UI / trackers stop
      // showing the wrong entry. Threshold 0.05% to ignore rounding noise.
      if (exchangePos.entryPrice > 0 && t.entryPrice > 0) {
        const driftPct = Math.abs(exchangePos.entryPrice - t.entryPrice) / t.entryPrice
        if (driftPct > 0.0005) {
          const newSize = exchangePos.entryPrice * t.positionUnits
          const newMargin = t.leverage ? newSize / t.leverage : t.marginUsd
          await prisma.breakoutLiveTradeC.update({
            where: { id: t.id },
            data: {
              entryPrice: exchangePos.entryPrice,
              positionSizeUsd: newSize,
              marginUsd: newMargin,
            },
          }).catch((e) => console.warn(`${LOG} reconcile: heal entryPrice #${t.id} failed: ${e?.message ?? e}`))
          console.log(`${LOG} reconcile: #${t.id} ${t.symbol} entryPrice drift ${t.entryPrice} → ${exchangePos.entryPrice} (${(driftPct * 100).toFixed(2)}%) — healed`)
        }
      }
      continue
    }

    report.details.missingPositionsForDbOpen++
    // Position closed externally — finalize the row. If there's a remaining
    // (un-closed) fraction, append a single RECONCILED entry with a non-zero
    // P&L estimate from markPrice so the equity curve doesn't drop to 0 for
    // the residual share. The exact P&L will be inferred later from userTrades
    // (if we ever wire that up) — for now, the estimate keeps the curve sane.
    const priorCloses = ((t.closes as any[]) ?? []) as Array<{ percent?: number; price?: number }>
    const priorPercent = priorCloses.reduce((a, c) => a + (c.percent ?? 0), 0)
    const residualPercent = Math.max(0, 100 - priorPercent)
    const updateData: any = {
      status: 'CLOSED',
      closedAt: new Date(),
      // Clear stored algo refs — any still-active TP/SL on the exchange gets
      // cancelled below, and a NULL/[] field prevents subsequent reconcile or
      // sweep cycles from trying to operate on them again.
      binanceSlOrderId: null,
      binanceTpOrderIds: [] as any,
    }
    if (residualPercent > 1e-6) {
      // Best-effort P&L estimate: use the last seen mark price for this row's
      // symbol. If none, leave at 0 — caller can rely on userTrades reconciliation
      // when we add it.
      const refPrice = priorCloses.length > 0 ? Number(priorCloses[priorCloses.length - 1].price) || 0 : 0
      const isLong = t.side === 'BUY'
      const residualUnits = t.positionUnits * (residualPercent / 100)
      const grossPnl = refPrice > 0 ? (isLong ? refPrice - t.entryPrice : t.entryPrice - refPrice) * residualUnits : 0
      updateData.closes = [
        ...priorCloses,
        {
          price: refPrice,
          percent: residualPercent,
          pnlUsd: grossPnl,
          closedAt: new Date().toISOString(),
          reason: 'RECONCILED',
        },
      ] as any
    }
    // Cancel any still-active TP/SL algo orders BEFORE flipping the row to
    // CLOSED. Without this, dust algo orders stayed on the exchange forever
    // (we found 3 such orphans 2026-05-20: SIREN tpL4938_1 and ENA tpL4905_3
    // + slL4905). Best-effort — -2011/-2013 already-gone is fine.
    await cancelSlOnExchange(t).catch(() => { /* best-effort */ })
    await cancelAllTpsOnExchange(t).catch(() => { /* best-effort */ })
    await prisma.breakoutLiveTradeC.update({ where: { id: t.id }, data: updateData })
    console.log(`${LOG} reconcile: #${t.id} ${t.symbol} position gone — closed (residual ${residualPercent.toFixed(1)}%, algos cancelled)`)
  }

  // --- Exchange positions without DB row ---
  // Symbols where we have a non-zero position on exchange but no OPEN row.
  // First try to AUTO-CLOSE them — they're almost always zombie residuals
  // from incomplete terminal closes (step-rounding remainders that piled up).
  // Only flag → kill-switch the ones that survive the close attempt (e.g. a
  // genuinely foreign position whose reduceOnly close fails). Previously ANY
  // untracked position tripped the kill-switch, which on a tiny dust residual
  // (AAVEUSDT=0.1 2026-05-27) silently froze the whole trader until manual
  // release — and the dust would've been swept on the next cycle anyway.
  const dbSymbolsOpen = new Set(dbOpen.map((t) => t.symbol))
  const untrackedCandidates = Array.from(positionsBySymbol.entries())
    .filter(([sym, pos]) => pos.amt !== 0 && !dbSymbolsOpen.has(sym))
    .map(([sym, pos]) => ({ symbol: sym, amt: pos.amt }))

  if (untrackedCandidates.length > 0) {
    console.warn(`${LOG} reconcile: ${untrackedCandidates.length} untracked position(s) — attempting auto-close: ${untrackedCandidates.map((u) => `${u.symbol}=${u.amt}`).join(', ')}`)
    await closeUntrackedPositions(client).catch((e) =>
      console.warn(`${LOG} reconcile: closeUntrackedPositions threw: ${e?.message ?? e}`))

    // Re-query — anything still open is a true drift that needs manual review.
    let survivors: typeof untrackedCandidates = []
    try {
      const after = await client.getOpenPositions()
      const afterBySymbol = new Map(after.map((p) => [p.symbol, Number(p.positionAmt)]))
      survivors = untrackedCandidates.filter((u) => {
        const amt = afterBySymbol.get(u.symbol) ?? 0
        return amt !== 0
      })
    } catch (e: any) {
      // Couldn't re-verify — be conservative, treat all as survivors so we
      // flag for manual review rather than silently assume they closed.
      survivors = untrackedCandidates
      console.warn(`${LOG} reconcile: post-close re-query failed: ${e.message} — flagging all untracked for review`)
    }
    for (const s of survivors) {
      report.details.untrackedPositions.push(s)
      report.hasUntrackedPositions = true
    }
    if (survivors.length === 0) {
      console.log(`${LOG} reconcile: all untracked positions auto-closed — no kill-switch needed`)
    }
  }

  // (Exchange-orders-without-DB-row check removed 2026-05-19 — entry orders
  // are no longer placed on the exchange. The migration block above already
  // cancels any pre-existing 'cL' relics. Algo SL orders are tracked via
  // attachSlAfterEntry / cancelSlOnExchange which are id-based.)

  // Build human-readable summary for the kill-switch reason.
  const parts: string[] = []
  if (report.details.untrackedPositions.length > 0) {
    parts.push(`${report.details.untrackedPositions.length} untracked position(s): ${report.details.untrackedPositions.map((p) => `${p.symbol}=${p.amt}`).join(', ')}`)
  }
  if (migrationCancelled > 0 || oldPlaced.count > 0) {
    parts.push(`migration: cancelled ${migrationCancelled} exchange order(s), ${oldPlaced.count} stale DB PENDING`)
  }
  if (report.details.missingPositionsForDbOpen > 0) {
    parts.push(`${report.details.missingPositionsForDbOpen} OPEN reconciled to closed`)
  }
  report.summary = parts.join('; ') || 'no drift'
  console.log(`${LOG} reconcile: ${report.summary}`)

  return report
}

/**
 * Close exchange-side dust positions whose isolated margin dropped below $1.
 *
 * Scenario: DB row already CLOSED (TP3 fully filled, or SL hit, or manual
 * close), but Binance UI still shows a tiny residual position on the symbol
 * with "Margin 0.00 USDT (Isolated)" — leftover after step-rounding pushed
 * the close qty 1-2 lot sizes below the actual fill amount. The MARKET
 * reduceOnly at terminal close emptied 99.99% of the position; the remainder
 * sits at sub-dollar margin and just clutters the position tab.
 *
 * Only touches positions WITHOUT an active DB row — closes the exchange-side
 * remainder. Doesn't try to finalize DB (DB is already final).
 */
export async function closeLowMarginPositions(client: BinanceFuturesClient, marginFloorUsd = 1): Promise<{ closed: number }> {
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch (e: any) {
    console.warn(`${LOG} closeLowMarginPositions: getOpenPositions failed: ${e.message}`)
    return { closed: 0 }
  }
  let closed = 0
  const filtersMap = state.current ? await getFilters(state.current.client).catch(() => null) : null
  for (const p of positions) {
    const amt = Number(p.positionAmt)
    if (amt === 0) continue
    // isolatedMargin is the field Binance UI shows as "Margin (Isolated)".
    // For cross-margin positions it may be undefined — skip those (they share
    // the wallet, not a per-position margin to compare against).
    const isoMargin = Number((p as any).isolatedMargin ?? 0)
    if (!isoMargin || isoMargin >= marginFloorUsd) continue

    // Only act when DB has NO active row for this symbol. If there's still an
    // OPEN/TP*_HIT/PENDING row, the small margin is intentional (e.g. just
    // after entry on a 50x position the iso margin is tiny by design) — don't
    // touch a live trade.
    const activeRow = await prisma.breakoutLiveTradeC.findFirst({
      where: {
        symbol: p.symbol,
        OR: [
          { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
          { limitOrderState: 'PENDING_LIMIT' },
        ],
      },
    })
    if (activeRow) continue

    const f = filtersMap?.get(p.symbol)
    if (!f) {
      console.warn(`${LOG} closeLowMargin ${p.symbol} amt=${amt} isoMargin=${isoMargin.toFixed(4)}: no filter — skipping`)
      continue
    }
    const closeSide: 'BUY' | 'SELL' = amt > 0 ? 'SELL' : 'BUY'
    const step = f.stepSize
    let qty = Math.floor(Math.abs(amt) / step) * step
    qty = Number(qty.toFixed(f.quantityPrecision))
    if (qty < f.minQty) {
      console.warn(`${LOG} closeLowMargin ${p.symbol} amt=${amt} < minQty ${f.minQty} — exchange dust, can't close via order`)
      continue
    }
    try {
      await client.placeOrder({
        symbol: p.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: qty,
        reduceOnly: true,
      })
      console.log(`${LOG} closeLowMargin closed exchange-side dust ${p.symbol} qty=${qty} isoMargin=$${isoMargin.toFixed(4)} (< $${marginFloorUsd})`)
      closed++
    } catch (e: any) {
      if (e instanceof BinanceApiError && e.code === -2022) continue  // already gone
      console.warn(`${LOG} closeLowMargin ${p.symbol} qty=${qty} failed: ${e.message}`)
    }
  }
  return { closed }
}

/**
 * Close "zombie" exchange positions — any non-zero position whose symbol has
 * NO active DB row. Unlike closeLowMarginPositions (isolated margin < $1 only,
 * skips cross), this handles ANY size and ANY margin mode.
 *
 * Root case 2026-05-27: SEIUSDT 84096 (+$546) and ORDIUSDT 1822 (-$303)
 * cross-margin LONGs accumulated over ~3 days from incomplete LONG terminal
 * closes (reduceOnly TP/SL qty rounded DOWN at each rung → residual remained;
 * cross-margin so closeLowMarginPositions skipped it). They sat naked (no
 * SL/TP), distorting wallet vs DB-tracked P&L (the "прочее +$3883" residual)
 * and carrying uncovered directional risk.
 *
 * Safety — never touch a live/just-opened trade:
 *   - Skip symbol if it has an active DB row (OPEN/TP1_HIT/TP2_HIT) OR a
 *     PENDING_LIMIT row OR any row opened in the last 5 min. The 5-min window
 *     covers the gap between an entry MARKET fill landing on the exchange and
 *     tryFillVirtualLimit writing the OPEN row (and any WS-race during it).
 *
 * Chunks the close if remaining qty exceeds MARKET_LOT_SIZE.maxQty (symmetric
 * with flatten.ts / aggTrade.ts entry chunking — KAS-class large positions).
 *
 * Sends a Telegram alert per closed zombie so the operator knows it happened
 * (these are abnormal — a healthy bot shouldn't accumulate them).
 */
export async function closeUntrackedPositions(
  client: BinanceFuturesClient,
  prefetched?: Awaited<ReturnType<typeof client.getOpenPositions>>,
): Promise<{ closed: number; checked: number }> {
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  if (prefetched) {
    // Reuse positions already fetched by the caller (reconcileClosedPositionsLiveC
    // in the 60s cycle) — zero extra REST for the periodic naked-zombie sweep.
    positions = prefetched
  } else {
    try {
      positions = await client.getOpenPositions()
    } catch (e: any) {
      console.warn(`${LOG} closeUntrackedPositions: getOpenPositions failed: ${e.message}`)
      return { closed: 0, checked: 0 }
    }
  }
  const nonZero = positions.filter((p) => Number(p.positionAmt) !== 0)
  if (nonZero.length === 0) return { closed: 0, checked: 0 }

  const filtersMap = state.current ? await getFilters(state.current.client).catch(() => null) : null
  const freshCutoff = new Date(Date.now() - 5 * 60 * 1000)
  let closed = 0
  let checked = 0

  for (const p of nonZero) {
    const amt = Number(p.positionAmt)
    // Tracked or too-fresh → leave alone.
    const guardRow = await prisma.breakoutLiveTradeC.findFirst({
      where: {
        symbol: p.symbol,
        OR: [
          { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
          { limitOrderState: 'PENDING_LIMIT' },
          { openedAt: { gte: freshCutoff } },
        ],
      },
      select: { id: true },
    })
    if (guardRow) continue
    checked++

    const f = filtersMap?.get(p.symbol)
    if (!f) {
      console.warn(`${LOG} closeUntracked ${p.symbol} amt=${amt}: no filter — skipping`)
      continue
    }
    const uPnl = Number((p as any).unRealizedProfit ?? 0)
    // Safe close: reduceOnly first, plain-MARKET fallback (≤ live amt) on the
    // testnet -2022 reduceOnly rejection. Without the fallback this used to just
    // `continue` on -2022 — which is exactly why naked zombies survived every
    // boot/EOD sweep and ran for days (2026-05-27 root cause).
    const cr = await closeFullPositionMarket(client, p.symbol, amt, f)
    if (!cr.ok) {
      console.warn(`${LOG} closeUntracked ${p.symbol} amt=${amt} close failed: ${cr.reason}`)
      continue
    }
    if (cr.closedQty <= 0) continue  // sub-min dust — nothing actionable
    console.log(`${LOG} 🧟 closeUntracked closed zombie ${p.symbol} amt=${amt} uPnl=$${uPnl.toFixed(2)} (${(p as any).marginType ?? '?'} margin, no DB row)${cr.usedPlainFallback ? ' [plain-fallback]' : ''}`)
    closed++
    const sign = uPnl >= 0 ? '+' : '−'
    await sendLiveTelegram([
      `🧟 <b>Закрыта untracked-позиция</b>  · ${p.symbol}`,
      `━━━━━━━━━━━━━━━━━━`,
      `Позиция на бирже без DB-строки (наведённая/перевёрнутая). Закрыта MARKET.`,
      `Кол-во: <code>${Math.abs(amt)}</code> · реализ. ${sign}$${Math.abs(uPnl).toFixed(2)}`,
    ].join('\n')).catch(() => { /* best-effort */ })
  }
  return { closed, checked }
}

/**
 * Cancel any stray algo orders (TP/SL) on the exchange. Two paths:
 *   A) cid matches our format (slL{id} / tpL{id}_{idx}) AND owning trade is
 *      in a terminal status → cancel.
 *   B) cid not our format BUT reduce-only STOP_MARKET/TAKE_PROFIT_MARKET on a
 *      symbol where the algo qty exceeds live positionAmt, OR there's no
 *      live position at all → cancel (random-cid orphan from a rate-limit
 *      retry that dropped our clientAlgoId).
 *
 * Together with closeLowMarginPositions keeps the exchange book in sync with
 * DB after exit events.
 */
export async function sweepStrayAlgoOrders(client: BinanceFuturesClient): Promise<{ cancelled: number; checked: number }> {
  let algoOrders: Awaited<ReturnType<typeof client.getOpenAlgoOrders>>
  try {
    algoOrders = await client.getOpenAlgoOrders()
  } catch (e: any) {
    console.warn(`${LOG} sweepStrayAlgos: getOpenAlgoOrders failed: ${e.message}`)
    return { cancelled: 0, checked: 0 }
  }
  // Pull live positions to detect orphans whose owner can't be parsed from
  // cid. Binance auto-generates a random alphanumeric clientOrderId when our
  // signed POST drops the cid field (some rate-limit retry paths used to do
  // this). Those algos look like rogue orders to the cid parser but they're
  // still our SL/TP for some prior position size — observed 2026-05-20 on
  // AAVE (qty=45 @ 87.569) and LINK (qty=410 @ 9.552) still alive after
  // retrail moved the real SL to BE on the smaller remaining qty.
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch {
    positions = []
  }
  const posBySymbol = new Map<string, number>()
  for (const p of positions) {
    const amt = Math.abs(Number(p.positionAmt))
    if (amt > 0) posBySymbol.set(p.symbol, amt)
  }

  let cancelled = 0
  let checked = 0
  for (const o of algoOrders) {
    const cid = o.clientAlgoId || ''
    // Path A: cid matches our format — cancel if owning trade is terminal.
    let tradeId: number | null = null
    if (cid.startsWith('slL')) {
      tradeId = parseInt(cid.slice(3), 10)
    } else if (cid.startsWith('tpL')) {
      const rest = cid.slice(3)
      const underscore = rest.indexOf('_')
      if (underscore > 0) tradeId = parseInt(rest.slice(0, underscore), 10)
    }
    if (Number.isFinite(tradeId) && tradeId !== null) {
      checked++
      const t = await prisma.breakoutLiveTradeC.findUnique({
        where: { id: tradeId },
        select: { status: true, symbol: true },
      })
      if (!t) continue
      if (!['CLOSED', 'SL_HIT', 'TP3_HIT', 'EXPIRED', 'CANCELLED'].includes(t.status)) continue
      try {
        await client.cancelAlgoOrder(o.symbol, { algoId: o.algoId })
        console.log(`${LOG} sweepStrayAlgos cancelled ${o.symbol} ${cid} (#${tradeId} status=${t.status})`)
        cancelled++
      } catch (e: any) {
        if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) continue
        console.warn(`${LOG} sweepStrayAlgos cancel ${o.symbol} ${cid} failed: ${e.message}`)
      }
      continue
    }

    // Path B: cid not our format. Treat as orphan only if it's a reduce-only
    // exit algo AND either:
    //   - no live position on the symbol (zombie reduceOnly), OR
    //   - algo qty > live positionAmt (size-stale, e.g. from before a TP1
    //     partial close reduced position to ~50%)
    // Both conditions are safe to cancel — a reduceOnly STOP_MARKET on top of
    // the proper one is at best redundant and at worst would fire on a future
    // re-entry into the same symbol at an unexpected level.
    if (!o.reduceOnly) continue
    const orderType = String((o as any).type ?? (o as any).orderType ?? '')
    if (orderType !== 'STOP_MARKET' && orderType !== 'TAKE_PROFIT_MARKET') continue
    const algoQty = Number((o as any).quantity ?? (o as any).origQty ?? 0)
    const livePosAmt = posBySymbol.get(o.symbol) ?? 0
    const isPositionless = livePosAmt === 0
    const isSizeStale = algoQty > livePosAmt + 1e-8
    if (!isPositionless && !isSizeStale) continue
    checked++
    try {
      await client.cancelAlgoOrder(o.symbol, { algoId: o.algoId })
      const reason = isPositionless ? 'no live position' : `qty ${algoQty} > positionAmt ${livePosAmt}`
      console.log(`${LOG} sweepStrayAlgos cancelled orphan ${o.symbol} cid=${cid} ${orderType} (${reason})`)
      cancelled++
    } catch (e: any) {
      if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) continue
      console.warn(`${LOG} sweepStrayAlgos cancel orphan ${o.symbol} cid=${cid} failed: ${e.message}`)
    }
  }
  return { cancelled, checked }
}

/**
 * Targeted version of sweepStrayAlgoOrders: cancels every algo order on the
 * exchange whose clientAlgoId belongs to a specific tradeId — slL{tradeId} or
 * tpL{tradeId}_*. Used as a defensive net on terminal close so TPs/SL don't
 * outlive the trade even if binanceTpOrderIds/binanceSlOrderId in DB drifted
 * (e.g. after a reconcile that nulled them, or a missed WS write).
 *
 * Safer than cancelAllTpsOnExchange(t) alone — that one trusts the DB array;
 * this one trusts the exchange. We run both for belt-and-braces.
 */
export async function cancelAllExchangeOrdersForTrade(
  client: BinanceFuturesClient,
  tradeId: number,
  symbol: string,
): Promise<{ cancelled: number }> {
  let algoOrders: Awaited<ReturnType<typeof client.getOpenAlgoOrders>>
  try {
    algoOrders = await client.getOpenAlgoOrders()
  } catch (e: any) {
    console.warn(`${LOG} cancelAllExchangeOrdersForTrade #${tradeId}: getOpenAlgoOrders failed: ${e.message}`)
    return { cancelled: 0 }
  }
  let cancelled = 0
  const slPrefix = `slL${tradeId}`
  const tpPrefix = `tpL${tradeId}_`
  for (const o of algoOrders) {
    if (o.symbol !== symbol) continue
    const cid = o.clientAlgoId || ''
    if (cid !== slPrefix && !cid.startsWith(tpPrefix)) continue
    try {
      await client.cancelAlgoOrder(o.symbol, { algoId: o.algoId })
      console.log(`${LOG} cancelAllExchangeOrdersForTrade cancelled ${o.symbol} ${cid} (#${tradeId})`)
      cancelled++
    } catch (e: any) {
      if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) continue
      console.warn(`${LOG} cancelAllExchangeOrdersForTrade cancel ${o.symbol} ${cid} failed: ${e.message}`)
    }
  }
  return { cancelled }
}

/**
 * Periodic safety-net: find DB rows still marked OPEN/TP1_HIT/TP2_HIT for which
 * the exchange has no position, and finalize them by reading the actual fill(s)
 * from /fapi/v1/userTrades.
 *
 * Why this exists: handleSlOrderUpdate / handleTpOrderUpdate rely on the
 * ORDER_TRADE_UPDATE event's `clientOrderId` matching our `slL{id}` / `tpL{id}_{n}`
 * convention. Binance preserves clientAlgoId on the resulting MARKET fill MOST
 * of the time — but not always. We've observed cases (e.g. SEIUSDT #14050,
 * 2026-05-23) where the SL on the exchange triggered, the position closed, but
 * no `slL...` event was processed (cid was rewritten by Binance or the event
 * was lost during a brief WS hiccup). The row sits OPEN in DB while the
 * position is gone on the exchange; manual MARKET reduceOnly close then fails
 * with -2022 "ReduceOnly Order is rejected".
 *
 * This function runs every cycle tick (60s) and self-heals such drift using
 * the authoritative fill data from REST userTrades.
 *
 * Guarded by:
 *   - "openedAt > 2 minutes ago" — fresh positions might not be visible in
 *     getOpenPositions() yet right after a MARKET fill races the snapshot
 *     refresh; skip them on this tick, catch on the next.
 *   - Only one getOpenPositions() call per invocation; userTrades is queried
 *     only for symbols that need finalization.
 */
export async function reconcileClosedPositionsLiveC(
  client: BinanceFuturesClient,
): Promise<{ finalized: number; checked: number }> {
  const dbOpen = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
  })
  if (dbOpen.length === 0) return { finalized: 0, checked: 0 }

  // Skip rows opened in the last 2 minutes — Binance can briefly show
  // positionAmt=0 between the entry MARKET response and the position taking
  // effect on the account snapshot. We don't want to false-finalize a trade
  // that just opened.
  const freshCutoff = Date.now() - 2 * 60 * 1000
  const ripeRows = dbOpen.filter((t) => t.openedAt.getTime() < freshCutoff)
  if (ripeRows.length === 0) return { finalized: 0, checked: 0 }

  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch (e: any) {
    console.warn(`${LOG} reconcileClosed: getOpenPositions failed: ${e.message}`)
    return { finalized: 0, checked: 0 }
  }
  const positionsBySymbol = new Map<string, number>()
  for (const p of positions) positionsBySymbol.set(p.symbol, Number(p.positionAmt))

  let finalized = 0
  let checked = 0
  for (const t of ripeRows) {
    const amt = positionsBySymbol.get(t.symbol)
    const dbLong = t.side === 'BUY'
    const aligned = amt !== undefined && amt !== 0 && (amt > 0) === dbLong
    if (aligned) continue  // position alive AND correct direction — nothing to do
    checked++

    // Direction mismatch: DB says short but exchange holds a long (or vice
    // versa). The tracked position is GONE and a naked, wrong-side position sits
    // on the book — the 2026-05-27 testnet reduceOnly-STOP flip. finalizeOrphanRow
    // can't handle this (it looks for a clean closing fill; a flip has none, so
    // it would skip and strand the row OPEN forever in a retrail→-2021→-2022
    // loop). Close the wrong-side position and finalize the row directly.
    if (amt !== undefined && amt !== 0 && (amt > 0) !== dbLong) {
      await handleFlippedPosition(client, t, amt).catch((e) =>
        console.warn(`${LOG} reconcileClosed flip #${t.id} ${t.symbol} failed: ${e?.message ?? e}`))
      finalized++
      continue
    }

    try {
      await finalizeOrphanRow(client, t)
      finalized++
    } catch (e: any) {
      console.warn(`${LOG} reconcileClosed #${t.id} ${t.symbol} failed: ${e?.message ?? e}`)
    }
  }

  // Periodic naked-zombie sweep — reuse the positions already fetched above
  // (zero extra REST). Closes any non-zero position with NO active DB row (the
  // residue of a flip whose DB row was already finalized, or a foreign/manual
  // position). This is the safety-critical EXCEPTION to "no periodic cleanup":
  // a naked position carries uncovered directional risk and must die within one
  // 60s cycle, not wait for the next boot/EOD. With closePosition-SL preventing
  // flips at the source, this should almost never find anything to do.
  await closeUntrackedPositions(client, positions).catch((e) =>
    console.warn(`${LOG} reconcileClosed: periodic untracked sweep threw: ${e?.message ?? e}`))

  if (finalized > 0) {
    // Roll up aggregate stats (totalTrades/totalPnLUsd/peakDeposit/maxDD) after
    // the per-row recomputeTradeMoney calls inside finalizeOrphanRow. Lazy
    // import to break the reconcile ↔ virtualSltp cycle.
    try {
      const { recomputeLiveCStats } = await import('./virtualSltp')
      await recomputeLiveCStats()
    } catch (e: any) {
      console.warn(`${LOG} reconcileClosed: recomputeLiveCStats failed: ${e?.message ?? e}`)
    }
  }

  return { finalized, checked }
}

/**
 * Finalize one DB row whose exchange position is gone. Read all userTrades
 * since openedAt, sum the closing-side fills, and persist as a single
 * RECONCILED close entry. Cancel any leftover SL/TP algo orders best-effort.
 */
async function finalizeOrphanRow(
  client: BinanceFuturesClient,
  trade: any,
): Promise<void> {
  // Tolerate clock skew + funding events around openedAt; cap at 7 days to
  // bound the response size (Binance returns up to 1000 fills per call).
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const startTime = Math.max(sevenDaysAgo, trade.openedAt.getTime() - 60 * 1000)

  let userTrades: UserTrade[] = []
  try {
    userTrades = await client.getUserTrades(trade.symbol, { startTime, limit: 1000 })
  } catch (e: any) {
    console.warn(`${LOG} reconcileClosed: getUserTrades ${trade.symbol} failed: ${e.message}`)
    return
  }

  // Closing fills = opposite side, time strictly after the entry fill.
  // We deliberately don't trust openedAt as the entry-fill timestamp (it's the
  // row insertion time, not necessarily the fill time) — instead we anchor on
  // the entry orderId(s) we stored at fill time.
  const entryOrderIds = new Set<string>(
    ((trade.entryFillOrderIds as any[]) ?? []).map(String).concat(
      trade.binanceOrderId !== null && trade.binanceOrderId !== undefined ? [String(trade.binanceOrderId)] : [],
    ),
  )
  const closingSide = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const closingFills = userTrades.filter(
    (f) => f.side === closingSide && !entryOrderIds.has(String(f.orderId)),
  )

  if (closingFills.length === 0) {
    console.warn(`${LOG} reconcileClosed #${trade.id} ${trade.symbol}: no closing fills found in userTrades — skipping`)
    return
  }

  // Aggregate.
  let totQty = 0
  let totQuote = 0
  let totCommission = 0
  let totRealizedPnl = 0
  let lastTime = 0
  let firstOrderId = ''
  for (const f of closingFills) {
    const q = Number(f.qty)
    const p = Number(f.price)
    const c = Number(f.commission)
    const rp = Number(f.realizedPnl)
    totQty += q
    totQuote += q * p
    totCommission += c
    totRealizedPnl += rp
    if (f.time > lastTime) lastTime = f.time
    if (!firstOrderId) firstOrderId = String(f.orderId)
  }
  const avgFillPrice = totQty > 0 ? totQuote / totQty : trade.entryPrice
  const priorCloses = ((trade.closes as any[]) ?? []).slice()
  const priorPercent = priorCloses.reduce((a: number, c: any) => a + (c?.percent ?? 0), 0)
  const residualPercent = Math.max(0, 100 - priorPercent)

  // If priorPercent > 0 (TP1_HIT / TP2_HIT case), the userTrades query also
  // returned the earlier TP fills. We've intentionally NOT deduplicated by
  // close timestamp because we'd then need to reconstruct which fill belongs
  // to which TP — too brittle. Instead: trust the existing closes[] entries
  // (already refined by the WS handler if it caught them) and ONLY append a
  // single RECONCILED close for the remaining residualPercent share. Use the
  // userTrades realizedPnl SUM minus what's already accounted for in closes[].
  // This converges to the right total whether the prior TP fills were caught
  // by WS or not.
  const priorRealized = priorCloses.reduce((a: number, c: any) => a + (Number(c?.pnlUsd) || 0), 0)
  const priorFees = priorCloses.reduce((a: number, c: any) => a + (Number(c?.feePaidUsd) || 0), 0)
  const residualRealizedPnl = totRealizedPnl - priorRealized
  const residualFees = Math.max(0, totCommission - priorFees)

  // Best-effort: cancel any algo orders still on the exchange (Binance auto-
  // cancels reduceOnly STOP_MARKET/TAKE_PROFIT_MARKET when position hits 0,
  // but our DB array may still reference them — clean up so /Биржа tab and
  // future sweeps don't act on stale ids).
  await cancelSlOnExchange(trade).catch(() => { /* best-effort */ })
  await cancelAllTpsOnExchange(trade).catch(() => { /* best-effort */ })

  // Infer the close reason from realizedPnl + direction. The OLD code
  // hard-coded reason='SL' which mislabelled profitable reconciles as SL_HIT
  // (DOGE #25989: SHORT closed at +$25 within 2s of open, marked as SL — UI
  // showed "SL" with positive P&L, contradictory).
  //
  // Rules:
  //   - residualRealizedPnl > 0 AND avgFillPrice is on the profit side of
  //     entry for this trade.side → label as TPn (pick the ladder rung
  //     closest to avgFillPrice; reconciled rows are always 100% closures
  //     so "which TP fired" is best-guess).
  //   - Otherwise → SL (loss or zero P&L, or weird mid-range fill that
  //     wasn't a clean TP).
  //
  // Status: terminal close that came through a TP-direction fill maps to
  // CLOSED (not TP3_HIT — TP3_HIT implies the full ladder fired and we
  // can't confirm that from a single reconciled fill). buildOutcomeLabel
  // renders status='CLOSED' + reason='TPn' as just "TPn" — readable.
  const isLong = trade.side === 'BUY'
  const isTpDirection = isLong
    ? avgFillPrice > trade.entryPrice
    : avgFillPrice < trade.entryPrice
  const ladder = ((trade.tpLadder as number[]) ?? []) as number[]
  let inferredReason: 'SL' | 'TP1' | 'TP2' | 'TP3' = 'SL'
  if (residualRealizedPnl > 0 && isTpDirection && ladder.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - avgFillPrice)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    inferredReason = (`TP${bestIdx + 1}` as 'TP1' | 'TP2' | 'TP3')
  }

  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(lastTime || Date.now()),
      closes: [
        ...priorCloses,
        {
          price: avgFillPrice,
          percent: residualPercent > 1e-6 ? residualPercent : 100,
          pnlUsd: residualRealizedPnl,
          feePaidUsd: residualFees,
          closedAt: new Date(lastTime || Date.now()).toISOString(),
          reason: inferredReason,
          reasonNote: 'reconciled-from-binance',
          binanceOrderId: firstOrderId,
        },
      ] as any,
      binanceSlOrderId: null,
      binanceTpOrderIds: [] as any,
    },
  })

  // Lazy import to avoid circular dependency with virtualSltp → reconcile.
  const { recomputeTradeMoney } = await import('./virtualSltp')
  await recomputeTradeMoney(trade.id)

  console.log(`${LOG} reconcileClosed: finalized #${trade.id} ${trade.symbol} via Binance userTrades — closing qty=${totQty} avgPx=${avgFillPrice} commission=${totCommission.toFixed(4)} realizedPnl=${totRealizedPnl.toFixed(4)}`)

  // Telegram notify so the user sees the recovery happened. Mirrors the format
  // notifyExitTelegram uses but with a reconcile badge so it's clear this
  // wasn't a real-time WS-driven close.
  const netPnl = residualRealizedPnl - residualFees
  const sign = netPnl >= 0 ? '+' : '−'
  await sendLiveTelegram([
    `♻ <b>Reconciled exit</b>  · #${trade.id} ${trade.symbol} ${trade.side}`,
    `━━━━━━━━━━━━━━━━━━`,
    `Биржа закрыла позицию (${inferredReason}); WS-событие не пришло, восстановлено по userTrades.`,
    `Цена: <code>${avgFillPrice.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}</code>`,
    `P&L: <b>${sign}$${Math.abs(netPnl).toFixed(2)}</b>  (комиссия ${residualFees.toFixed(2)}$)`,
  ].join('\n')).catch(() => { /* best-effort */ })
}

/**
 * Handle a flipped position — DB row is still OPEN/TP*_HIT for one side while the
 * exchange holds a non-zero position on the OPPOSITE side. Root cause 2026-05-27:
 * a reduceOnly STOP_MARKET on testnet, when triggered, flipped the short into an
 * equal-size long instead of closing it (reduceOnly silently ignored). The
 * original tracked position never realized a clean close, so finalizeOrphanRow's
 * userTrades path can't categorize it — we finalize directly here.
 *
 * Steps: cancel any stale algos for the trade, close the naked wrong-side
 * position at MARKET (safe reduceOnly→plain fallback), then finalize the DB row
 * CLOSED. The original entry's P&L is recorded as 0 — it flipped, it never
 * realized; the naked-leg loss is exchange-side noise not attributable to the
 * strategy row. (closePosition-SL now prevents the flip; this is the recovery
 * net for anything already flipped or a TP-side flip that slips through.)
 */
async function handleFlippedPosition(
  client: BinanceFuturesClient,
  trade: any,
  amt: number,
): Promise<void> {
  // Cancel stale algos (all now wrong-side for the flipped position).
  await cancelSlOnExchange(trade).catch(() => { /* best-effort */ })
  await cancelAllTpsOnExchange(trade).catch(() => { /* best-effort */ })

  const filtersMap = state.current ? await getFilters(state.current.client).catch(() => null) : null
  const f = filtersMap?.get(trade.symbol)
  let closedOk = false
  if (f) {
    const cr = await closeFullPositionMarket(client, trade.symbol, amt, f)
    closedOk = cr.ok && cr.closedQty > 0
  } else {
    console.warn(`${LOG} flip #${trade.id} ${trade.symbol}: no filter — can't close naked leg`)
  }

  const priorCloses = ((trade.closes as any[]) ?? []) as Array<{ percent?: number }>
  const priorPercent = priorCloses.reduce((a, c) => a + (c?.percent ?? 0), 0)
  const residualPercent = Math.max(0, 100 - priorPercent)
  await prisma.breakoutLiveTradeC.update({
    where: { id: trade.id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      binanceSlOrderId: null,
      binanceTpOrderIds: [] as any,
      closes: residualPercent > 1e-6
        ? [
            ...priorCloses,
            {
              price: trade.entryPrice,
              percent: residualPercent,
              pnlUsd: 0,
              feePaidUsd: 0,
              reason: 'SL',
              reasonNote: 'flip-auto-cleanup',
              closedAt: new Date().toISOString(),
            },
          ] as any
        : (priorCloses as any),
    },
  })

  const { recomputeTradeMoney } = await import('./virtualSltp')
  await recomputeTradeMoney(trade.id).catch(() => { /* noop */ })

  console.log(`${LOG} ⚠ flip auto-cleanup #${trade.id} ${trade.symbol}: DB ${trade.side} vs exchange amt=${amt} — ${closedOk ? 'closed wrong-side leg + ' : 'close FAILED, '}finalized row`)
  await sendLiveTelegram([
    `🔀 <b>Flip auto-cleanup</b>  · #${trade.id} ${trade.symbol} ${trade.side}`,
    `━━━━━━━━━━━━━━━━━━`,
    `Позиция перевернулась на бирже (DB ${trade.side}, биржа amt=${amt}). ${closedOk ? 'Встречная нога закрыта' : '⚠ закрыть ногу не удалось'}, строка финализирована.`,
  ].join('\n')).catch(() => { /* best-effort */ })
}
