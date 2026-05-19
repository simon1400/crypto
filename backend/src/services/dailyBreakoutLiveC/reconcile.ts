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
import { LOG } from './state'
import { attachSlAfterEntry } from './exchangeSl'

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
    // Position closed externally — finalize the row. Exact P&L will be inferred
    // later from userTrades; for now, just close.
    await prisma.breakoutLiveTradeC.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closes: [
          ...((t.closes as any[]) ?? []),
          {
            price: 0,
            percent: Math.max(0, 100 - ((t.closes as any[]) ?? []).reduce((a, c: any) => a + (c.percent ?? 0), 0)),
            pnlUsd: 0,
            closedAt: new Date().toISOString(),
            reason: 'RECONCILED',
          },
        ] as any,
      },
    })
    console.log(`${LOG} reconcile: #${t.id} ${t.symbol} position gone — closed`)
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
