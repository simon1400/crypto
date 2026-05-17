/**
 * One-off preview script: builds the EOD daily summary for a target UTC date
 * using REAL trade data from the DB and fires the BREAKOUT_EOD_CLOSED
 * notification via the real notifier — same code path the production cron uses.
 *
 * Read-only: does NOT touch trades, signals, configs, or the eod marker.
 *
 * Usage on server (after deploy):
 *   cd /opt/crypto/backend && npx tsx src/scripts/sendEodTestPreview.ts 2026-05-09
 */

import { prisma } from '../db/prisma'
import { sendNotification, EodVariantSummary, EodTradeRow } from '../services/notifier'

async function buildVariantSummary(
  variant: 'A' | 'B',
  utcDate: string,
): Promise<{ closed: EodVariantSummary }> {
  const tm = variant === 'A' ? prisma.breakoutPaperTrade : prisma.breakoutPaperTradeB
  const cm = variant === 'A' ? prisma.breakoutPaperConfig : prisma.breakoutPaperConfigB

  const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`)

  const cfg = await (cm as any).findUnique({ where: { id: 1 } })
  const deposit = cfg?.currentDepositUsd ?? 0

  // CLOSED rows = one row per trade, aggregating all close-events of that trade
  // that fired this UTC day. Matches dashboard's "P&L дня".
  const tradesWithCloses = await (tm as any).findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      id: true, symbol: true, side: true, closes: true,
      positionUnits: true, feesRoundTripPct: true, openedAt: true,
    },
  })
  const feeRateDefault = cfg?.feesRoundTripPct ?? 0.08
  const closedRows: EodTradeRow[] = []
  for (const t of tradesWithCloses) {
    const arr = ((t.closes as any[]) ?? []) as Array<{
      price: number; percent: number; pnlUsd: number; pnlR: number;
      closedAt: string; reason: string;
    }>
    const feeRatePct = t.feesRoundTripPct ?? feeRateDefault
    let pnlSum = 0
    let rSum = 0
    const reasons: string[] = []
    for (const c of arr) {
      const ts = c.closedAt ? new Date(c.closedAt).getTime() : new Date(t.openedAt).getTime()
      if (ts < dayStart.getTime() || ts > dayEnd.getTime()) continue
      const notional = t.positionUnits * c.price * (c.percent / 100)
      const fee = notional * (feeRatePct / 100)
      pnlSum += (c.pnlUsd ?? 0) - fee
      rSum += c.pnlR ?? 0
      if (c.reason) reasons.push(c.reason)
    }
    if (reasons.length === 0) continue
    closedRows.push({
      symbol: t.symbol,
      side: t.side as 'BUY' | 'SELL',
      pnlUsd: pnlSum,
      pnlR: rSum,
      reasons: reasons.join('+'),
    })
  }
  closedRows.sort((a, b) => a.symbol.localeCompare(b.symbol))
  const closedTotal = closedRows.reduce((s, r) => s + r.pnlUsd, 0)

  return {
    closed: { variant, trades: closedRows, totalPnlUsd: closedTotal, depositUsd: deposit },
  }
}

async function main() {
  const utcDate = process.argv[2]
  if (!utcDate || !/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) {
    console.error('Usage: sendEodTestPreview.ts YYYY-MM-DD')
    process.exit(1)
  }

  const a = await buildVariantSummary('A', utcDate)
  const b = await buildVariantSummary('B', utcDate)

  console.log(`[Preview] A closed=${a.closed.trades.length}, B closed=${b.closed.trades.length}`)

  await sendNotification('BREAKOUT_EOD_CLOSED', {
    utcDate,
    summaries: [a.closed, b.closed],
  })

  console.log('[Preview] Sent EOD CLOSED message via real notifier. DB untouched (no marker written).')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
