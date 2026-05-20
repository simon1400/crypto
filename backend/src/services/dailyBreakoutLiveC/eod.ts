/**
 * LIVE C end-of-day summary — Telegram report listing every BreakoutLiveTradeC
 * row that produced a close event on this UTC day.
 *
 * Mirrors the paper EOD summary (`dailyBreakoutPaper/eod.ts`): one row per
 * trade, reasons joined with '+' (e.g. "TP1+EXPIRED"), Σ P&L net of fees.
 * Reuses the existing 'BREAKOUT_EOD_CLOSED' notifier action — `variant:'LIVE'`
 * is already a valid value of EodVariantSummary, so the formatter just works.
 *
 * Idempotency: a marker is stored on BreakoutLiveConfigC.lastEodReportDate.
 * EOD-tick fires once per minute in the 23:55 UTC window so this gate is
 * needed to avoid duplicate sends.
 */

import { prisma } from '../../db/prisma'
import { sendNotification, type EodTradeRow, type EodVariantSummary } from '../notifier'
import { LOG, snapshot } from './state'

/**
 * Build the LIVE C variant summary for `utcDate` and send it via Telegram.
 * Called from runEodTick after flatten + cancel-pending + dust sweep — by
 * that point all closes from today are persisted.
 */
export async function sendLiveCEodSummary(utcDate: string): Promise<void> {
  const cfg = await prisma.breakoutLiveConfigC.findUnique({ where: { id: 1 } })
  if (!cfg) return
  // Idempotency: if we already sent for this date, no-op. Marker on config row
  // so a process restart in the 23:55-23:59 window doesn't re-fire.
  if ((cfg as any).lastEodReportDate === utcDate) {
    console.log(`${LOG} EOD summary for ${utcDate} already sent`)
    return
  }

  const dayStart = new Date(`${utcDate}T00:00:00.000Z`).getTime()
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`).getTime()

  // Every trade that has at least one close — we'll filter close events by
  // timestamp inside the loop so we attribute partials correctly.
  const trades = await prisma.breakoutLiveTradeC.findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      symbol: true, side: true, closes: true, openedAt: true,
      entryFeeUsd: true, fundingPaidUsd: true,
    },
  })

  const rows: EodTradeRow[] = []
  for (const t of trades) {
    const arr = ((t.closes as any[]) ?? []) as Array<{
      price: number; percent: number; pnlUsd: number; pnlR: number;
      feePaidUsd?: number; closedAt: string; reason: string; reasonNote?: string;
    }>
    let pnlSum = 0
    let rSum = 0
    const reasons: string[] = []
    let totalPercentToday = 0
    for (const c of arr) {
      const ts = c.closedAt ? new Date(c.closedAt).getTime() : new Date(t.openedAt).getTime()
      if (ts < dayStart || ts > dayEnd) continue
      // Gross PnL is what we store in closes[].pnlUsd (refined by WS event to
      // Binance's o.rp). Subtract the slice's exit fee for net.
      const sliceFee = Number(c.feePaidUsd ?? 0)
      pnlSum += Number(c.pnlUsd ?? 0) - sliceFee
      rSum += Number(c.pnlR ?? 0)
      totalPercentToday += Number(c.percent ?? 0)
      // Use the user-facing reasonNote when present (EOD-FLAT / manual /
      // kill-switch — the close-time `reason` is always 'SL' for cid-routing
      // purposes, but the human label sits in reasonNote).
      const label = c.reasonNote && c.reasonNote !== c.reason ? c.reasonNote : c.reason
      if (label) reasons.push(label)
    }
    if (reasons.length === 0) continue
    // Entry fee + accrued funding are charged once per trade. Attribute them
    // to the day's row only if the trade was OPENED today (so closes from
    // multi-day TP1-today/SL-tomorrow split don't double-charge).
    const openedToday = new Date(t.openedAt).getTime() >= dayStart && new Date(t.openedAt).getTime() <= dayEnd
    if (openedToday) {
      pnlSum -= Number(t.entryFeeUsd ?? 0)
      pnlSum += Number(t.fundingPaidUsd ?? 0)  // fundingPaidUsd is already signed (negative = paid)
    }
    rows.push({
      symbol: t.symbol,
      side: t.side as 'BUY' | 'SELL',
      pnlUsd: pnlSum,
      pnlR: rSum,
      reasons: reasons.join('+'),
    })
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol))
  const totalPnl = rows.reduce((s, r) => s + r.pnlUsd, 0)
  // Use the actual wallet balance from the live snapshot so the depo figure
  // matches what's on Binance right now (and the dashboard's top stats).
  const depo = snapshot.current?.total ?? cfg.currentDepositUsd

  const liveSummary: EodVariantSummary = {
    variant: 'LIVE',
    trades: rows,
    totalPnlUsd: totalPnl,
    depositUsd: depo,
  }

  try {
    await sendNotification('BREAKOUT_EOD_CLOSED', {
      utcDate,
      summaries: [liveSummary],
    })
  } catch (e: any) {
    console.error(`${LOG} EOD summary notify failed: ${e.message}`)
    return
  }

  // Persist marker so we don't re-send within the 23:55-23:59 window.
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: { lastEodReportDate: utcDate } as any,
  }).catch((e) => console.warn(`${LOG} EOD marker persist failed: ${e?.message ?? e}`))

  console.log(`${LOG} EOD summary sent for ${utcDate}: ${rows.length} trade(s), Σ ${totalPnl.toFixed(2)}$`)
}
