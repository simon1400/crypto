/**
 * One-off preview script: builds the EOD daily summary for a target UTC date
 * using REAL trade data from the DB and fires the BREAKOUT_EOD_CLOSED +
 * BREAKOUT_EOD_SURVIVING notifications via the real notifier — same code path
 * the production cron will use.
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
): Promise<{ closed: EodVariantSummary; surviving: EodVariantSummary }> {
  const tm = variant === 'A' ? prisma.breakoutPaperTrade : prisma.breakoutPaperTradeB
  const cm = variant === 'A' ? prisma.breakoutPaperConfig : prisma.breakoutPaperConfigB

  const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`)

  const cfg = await (cm as any).findUnique({ where: { id: 1 } })
  const deposit = cfg?.currentDepositUsd ?? 0

  const closedToday = await (tm as any).findMany({
    where: {
      status: { in: ['EXPIRED', 'CLOSED', 'SL_HIT'] },
      closedAt: { gte: dayStart, lte: dayEnd },
    },
    orderBy: { closedAt: 'asc' },
  })
  const closedRows: EodTradeRow[] = closedToday.map((t: any) => ({
    symbol: t.symbol,
    side: t.side,
    pnlUsd: t.netPnlUsd ?? 0,
    pnlR: t.realizedR ?? 0,
  }))
  const closedTotal = closedRows.reduce((s, r) => s + r.pnlUsd, 0)

  const survivingToday = await (tm as any).findMany({
    where: {
      status: { in: ['TP1_HIT', 'TP2_HIT'] },
      openedAt: { gte: dayStart, lte: dayEnd },
    },
    orderBy: { openedAt: 'asc' },
  })
  const survivingRows: EodTradeRow[] = survivingToday.map((t: any) => ({
    symbol: t.symbol,
    side: t.side,
    pnlUsd: (t.realizedPnlUsd ?? 0) - (t.feesPaidUsd ?? 0),
    pnlR: t.realizedR ?? 0,
  }))
  const survivingTotal = survivingRows.reduce((s, r) => s + r.pnlUsd, 0)

  return {
    closed: { variant, trades: closedRows, totalPnlUsd: closedTotal, depositUsd: deposit },
    surviving: { variant, trades: survivingRows, totalPnlUsd: survivingTotal, depositUsd: deposit },
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

  console.log(`[Preview] A closed=${a.closed.trades.length} surviving=${a.surviving.trades.length}`)
  console.log(`[Preview] B closed=${b.closed.trades.length} surviving=${b.surviving.trades.length}`)

  await sendNotification('BREAKOUT_EOD_CLOSED', {
    utcDate,
    summaries: [a.closed, b.closed],
  })
  await sendNotification('BREAKOUT_EOD_SURVIVING', {
    utcDate,
    summaries: [a.surviving, b.surviving],
  })

  console.log('[Preview] Sent 2 messages via real notifier. DB untouched (no marker written).')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
