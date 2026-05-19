/**
 * Repair helpers — manual recovery for drifted state.
 *
 * Used by the /repair-sltp admin endpoint to backfill missing exchange-side
 * SL / TP algo orders on already-open positions. Idempotent: re-running it
 * after everything is in place is a no-op (attachSlAfterEntry / attachTpsAfterEntry
 * both bail when binanceSlOrderId / binanceTpOrderIds[] is already set).
 *
 * The original use case (2026-05-19): hybrid TP shipped after some positions
 * were already open via the pre-hybrid code path. Those rows had SL on
 * exchange but no TPs. This function lets the operator backfill without
 * waiting for the next reconcile cycle on restart.
 */

import { prisma } from '../../db/prisma'
import { LOG, state, ACTIVE_STATUSES } from './state'
import { attachSlAfterEntry } from './exchangeSl'
import { attachTpsAfterEntry } from './exchangeTp'

export interface RepairReport {
  scanned: number
  slAttached: number
  tpAttached: number
  errors: Array<{ tradeId: number; symbol: string; error: string }>
  perTrade: Array<{
    tradeId: number
    symbol: string
    side: string
    status: string
    hadSl: boolean
    hadTps: number
    actions: string[]
  }>
}

/**
 * Scan all active LIVE-C trades and ensure each has SL + TP ladder on exchange.
 *
 * For each trade where status === 'OPEN' and exchange-position-amt > 0:
 *   - Missing binanceSlOrderId → attachSlAfterEntry
 *   - Empty binanceTpOrderIds → attachTpsAfterEntry
 *
 * For TP1_HIT / TP2_HIT we do NOT touch TPs — partial closes already executed
 * and re-placing would double-close on the next price touch. Reconcile applies
 * the same rule on boot.
 *
 * For positions without a matching exchange-side amt (closed externally) we
 * leave the row alone — the regular reconcile flow handles drift on restart.
 */
export async function attachMissingSlTp(): Promise<RepairReport> {
  const report: RepairReport = {
    scanned: 0,
    slAttached: 0,
    tpAttached: 0,
    errors: [],
    perTrade: [],
  }

  if (!state.current) {
    report.errors.push({ tradeId: 0, symbol: '*', error: 'Live trader is not running' })
    return report
  }

  const positions = await state.current.client.getOpenPositions().catch(() => [])
  const posBySymbol = new Map<string, number>()
  for (const p of positions) {
    const amt = Number(p.positionAmt)
    if (amt !== 0) posBySymbol.set(p.symbol, amt)
  }

  const trades = await prisma.breakoutLiveTradeC.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] } },
  })

  for (const t of trades) {
    report.scanned++
    const actions: string[] = []
    const hadSl = !!t.binanceSlOrderId
    const tpAlgos = ((t.binanceTpOrderIds as any[]) ?? []) as Array<unknown>
    const hadTps = tpAlgos.length

    const exchangeAmt = posBySymbol.get(t.symbol)
    if (!exchangeAmt) {
      actions.push('no-exchange-position — skipped (will be reconciled on restart)')
      report.perTrade.push({ tradeId: t.id, symbol: t.symbol, side: t.side, status: t.status, hadSl, hadTps, actions })
      continue
    }

    // SL — attachable for any active status (OPEN/TP1_HIT/TP2_HIT). currentStop
    // is already trailed to the right level by applyVirtualClose at each TP.
    if (!hadSl) {
      try {
        await attachSlAfterEntry(t.id)
        // Re-read to confirm.
        const after = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
        if (after?.binanceSlOrderId) {
          report.slAttached++
          actions.push(`SL attached (algoId=${after.binanceSlOrderId})`)
        } else {
          actions.push('SL attach failed (see backend logs)')
          report.errors.push({ tradeId: t.id, symbol: t.symbol, error: 'SL not attached after retry' })
        }
      } catch (e: any) {
        actions.push(`SL attach threw: ${e?.message ?? e}`)
        report.errors.push({ tradeId: t.id, symbol: t.symbol, error: `SL: ${e?.message ?? e}` })
      }
    }

    // TPs — only safe to attach when status === 'OPEN'. For TP1_HIT / TP2_HIT
    // we'd be re-creating already-executed levels, causing double-close. The
    // virtual tracker covers remaining TPs for those rows.
    if (hadTps === 0 && t.status === 'OPEN') {
      try {
        await attachTpsAfterEntry(t.id)
        const after = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
        const newCount = ((after?.binanceTpOrderIds as any[]) ?? []).length
        if (newCount > 0) {
          report.tpAttached += newCount
          actions.push(`TPs attached (${newCount})`)
        } else {
          actions.push('TP attach: no algos placed (see backend logs)')
        }
      } catch (e: any) {
        actions.push(`TP attach threw: ${e?.message ?? e}`)
        report.errors.push({ tradeId: t.id, symbol: t.symbol, error: `TP: ${e?.message ?? e}` })
      }
    } else if (hadTps === 0) {
      actions.push(`TP skipped — status=${t.status} (partial close already executed)`)
    }

    if (actions.length === 0) actions.push('all good — no action needed')
    report.perTrade.push({ tradeId: t.id, symbol: t.symbol, side: t.side, status: t.status, hadSl, hadTps, actions })
  }

  console.log(`${LOG} repair: scanned=${report.scanned} slAttached=${report.slAttached} tpAttached=${report.tpAttached} errors=${report.errors.length}`)
  return report
}
