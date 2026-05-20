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
import type { BinanceFuturesClient } from '../exchanges/binanceFutures'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, state } from './state'
import { getFilters } from './filters'
import { attachSlAfterEntry, cancelSlOnExchange } from './exchangeSl'
import { attachTpsAfterEntry, cancelAllTpsOnExchange } from './exchangeTp'

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
  const dbSymbolsOpen = new Set(dbOpen.map((t) => t.symbol))
  for (const [sym, pos] of positionsBySymbol) {
    if (pos.amt === 0) continue
    if (dbSymbolsOpen.has(sym)) continue
    report.details.untrackedPositions.push({ symbol: sym, amt: pos.amt })
    report.hasUntrackedPositions = true
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
 * Close any "dust" positions left on the exchange whose DB row is already
 * CLOSED. These appear when our planned close-qty was step-rounded DOWN
 * (e.g. step=1, remaining=4187.5 → we sent qty=4187, leaving 0.5 on the book).
 * Symptom: app shows N open while exchange shows N+1, and Binance's UI lists
 * a position with size <= minQty that the strategy will never touch again.
 *
 * Strategy: list exchange positions, look up the matching DB row; if row is
 * CLOSED/EXPIRED and exchange amt is non-zero, send a reduceOnly MARKET to
 * close it. If qty < minQty we can't close via order — the residual stays as
 * exchange dust but we at least log it so the operator can act.
 */
export async function sweepClosedRowDust(client: BinanceFuturesClient): Promise<{ swept: number; dust: number }> {
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch (e: any) {
    console.warn(`${LOG} sweepDust: getOpenPositions failed: ${e.message}`)
    return { swept: 0, dust: 0 }
  }
  let swept = 0
  let dust = 0
  const filtersMap = state.current ? await getFilters(state.current.client).catch(() => null) : null
  for (const p of positions) {
    const amt = Number(p.positionAmt)
    if (amt === 0) continue
    // Find the most recent DB row for this symbol that's CLOSED/EXPIRED. If
    // there's any OPEN/PENDING row for the same symbol, leave it alone — that
    // could be a re-entry from a fresh range.
    const activeRow = await prisma.breakoutLiveTradeC.findFirst({
      where: {
        symbol: p.symbol,
        OR: [
          { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
          { limitOrderState: 'PENDING_LIMIT' },
        ],
      },
    })
    if (activeRow) continue  // legit open position, not dust
    // Send MARKET reduceOnly for the remaining amt, step-rounded down.
    const f = filtersMap?.get(p.symbol)
    if (!f) {
      console.warn(`${LOG} sweepDust ${p.symbol} amt=${amt}: no filter — leaving as dust`)
      dust++
      continue
    }
    const closeSide: 'BUY' | 'SELL' = amt > 0 ? 'SELL' : 'BUY'
    const step = f.stepSize
    let qty = Math.floor(Math.abs(amt) / step) * step
    qty = Number(qty.toFixed(f.quantityPrecision))
    if (qty < f.minQty) {
      console.warn(`${LOG} sweepDust ${p.symbol} amt=${amt} < minQty ${f.minQty} — exchange dust, can't close via order`)
      dust++
      continue
    }
    try {
      if (state.current) {
        await state.current.client.placeOrder({
          symbol: p.symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: qty,
          reduceOnly: true,
        })
        console.log(`${LOG} sweepDust closed ${p.symbol} qty=${qty} (DB row is CLOSED)`)
        swept++
      }
    } catch (e: any) {
      if (e instanceof BinanceApiError && e.code === -2022) {
        // Already gone (someone closed between getOpenPositions and now). Fine.
        continue
      }
      console.warn(`${LOG} sweepDust ${p.symbol} qty=${qty} failed: ${e.message}`)
    }
  }
  return { swept, dust }
}

/**
 * Targeted dust sweep for a single symbol — call right after a terminal close
 * so any 1-step residue gets cleared immediately instead of waiting for the
 * boot/EOD sweep. Reads positionAmt from REST (snapshot may not have refreshed
 * the just-closed symbol yet) and fires a MARKET reduceOnly if anything > 0.
 *
 * Caller is expected to have already flipped the DB row to a terminal status.
 */
export async function sweepDustForSymbol(client: BinanceFuturesClient, symbol: string): Promise<void> {
  if (!state.current) return
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch (e: any) {
    console.warn(`${LOG} sweepDustForSymbol ${symbol}: getOpenPositions failed: ${e.message}`)
    return
  }
  const p = positions.find((pp) => pp.symbol === symbol)
  if (!p) return
  const amt = Number(p.positionAmt)
  if (amt === 0) return
  const filtersMap = await getFilters(client).catch(() => null)
  const f = filtersMap?.get(symbol)
  if (!f) {
    console.warn(`${LOG} sweepDustForSymbol ${symbol} amt=${amt}: no filter — leaving as dust`)
    return
  }
  const closeSide: 'BUY' | 'SELL' = amt > 0 ? 'SELL' : 'BUY'
  const step = f.stepSize
  let qty = Math.floor(Math.abs(amt) / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    console.warn(`${LOG} sweepDustForSymbol ${symbol} amt=${amt} < minQty ${f.minQty} — exchange dust, can't close via order`)
    return
  }
  try {
    await client.placeOrder({
      symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: qty,
      reduceOnly: true,
    })
    console.log(`${LOG} sweepDustForSymbol closed ${symbol} qty=${qty} (terminal close residue)`)
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2022) return  // already gone
    console.warn(`${LOG} sweepDustForSymbol ${symbol} qty=${qty} failed: ${e.message}`)
  }
}

/**
 * Cancel any stray algo orders (TP/SL) on the exchange whose owning trade is
 * already in a terminal status (CLOSED/SL_HIT/TP3_HIT/EXPIRED). Sister of
 * sweepClosedRowDust — that one closes phantom positions, this one cancels
 * phantom algo orders. Together they keep the exchange book in sync with DB.
 *
 * Identifies each algo order's owning trade by its clientAlgoId — our placement
 * code tags every algo with 'slL{id}' / 'tpL{id}_{idx}'. Any other cid is a
 * manual order we don't touch.
 */
export async function sweepStrayAlgoOrders(client: BinanceFuturesClient): Promise<{ cancelled: number; checked: number }> {
  let algoOrders: Awaited<ReturnType<typeof client.getOpenAlgoOrders>>
  try {
    algoOrders = await client.getOpenAlgoOrders()
  } catch (e: any) {
    console.warn(`${LOG} sweepStrayAlgos: getOpenAlgoOrders failed: ${e.message}`)
    return { cancelled: 0, checked: 0 }
  }
  let cancelled = 0
  let checked = 0
  for (const o of algoOrders) {
    const cid = o.clientAlgoId
    if (!cid) continue
    // Parse our cid format. slL{id} or tpL{id}_{idx}. Anything else = manual.
    let tradeId: number | null = null
    if (cid.startsWith('slL')) {
      tradeId = parseInt(cid.slice(3), 10)
    } else if (cid.startsWith('tpL')) {
      const rest = cid.slice(3)
      const underscore = rest.indexOf('_')
      if (underscore > 0) tradeId = parseInt(rest.slice(0, underscore), 10)
    }
    if (!Number.isFinite(tradeId) || tradeId === null) continue  // not our cid
    checked++
    const t = await prisma.breakoutLiveTradeC.findUnique({
      where: { id: tradeId },
      select: { status: true, symbol: true },
    })
    if (!t) continue
    // Terminal statuses → algo should already be gone. Cancel if it isn't.
    if (!['CLOSED', 'SL_HIT', 'TP3_HIT', 'EXPIRED', 'CANCELLED'].includes(t.status)) continue
    try {
      await client.cancelAlgoOrder(o.symbol, { algoId: o.algoId })
      console.log(`${LOG} sweepStrayAlgos cancelled ${o.symbol} ${cid} (#${tradeId} status=${t.status})`)
      cancelled++
    } catch (e: any) {
      if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) continue  // already gone
      console.warn(`${LOG} sweepStrayAlgos cancel ${o.symbol} ${cid} failed: ${e.message}`)
    }
  }
  return { cancelled, checked }
}
