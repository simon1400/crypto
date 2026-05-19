/**
 * EOD daily summary — replaces per-trade EXPIRED Telegram spam with a single
 * end-of-day aggregate per variant.
 *
 * Note: the "surviving past midnight" message was removed 2026-05-17 — since
 * EOD-FLAT policy closes ANY still-open trade at 23:55 UTC by market, there
 * are no carry-over trades. The second Telegram message was always empty AND
 * occasionally double-counted (a trade in status=TP1_HIT at the moment EOD
 * summary ran would appear both in "closed today" rows and in "surviving"
 * rows). Now we send a single CLOSED summary only.
 *
 * Idempotency: marker `eodSentForDate` stored in BreakoutConfig.lastScanResult
 * — sendBreakoutEodSummary is a no-op if it has already run for that date.
 */

import { prisma } from '../../db/prisma'
import { sendNotification } from '../notifier'
import { BreakoutVariant, configModel, tradeModel } from '../breakoutVariant'

async function buildVariantEodSummary(
  variant: BreakoutVariant,
  utcDate: string,
): Promise<{ closed: import('../notifier').EodVariantSummary }> {
  const tm = tradeModel(variant) as any
  const cm = configModel(variant) as any

  const dayStart = new Date(`${utcDate}T00:00:00.000Z`).getTime()
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`).getTime()

  const cfg = await cm.findUnique({ where: { id: 1 } })
  const deposit = cfg?.currentDepositUsd ?? 0

  // CLOSED rows = ONE row per trade, aggregating all close-events of that trade
  // that happened during this UTC day. A trade that hit TP1+TP2+SL the same day
  // appears as a single row "TP1+TP2+SL" with summed P&L. A trade whose TP1 fired
  // today but final SL tomorrow appears here today as "TP1" only, and tomorrow's
  // EOD will show the SL row separately. Σ matches dashboard's "P&L дня".
  const tradesWithCloses = await tm.findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      id: true, symbol: true, side: true, closes: true,
      positionUnits: true, feesRoundTripPct: true, openedAt: true,
    },
  })
  const feeRateDefault = cfg?.feesRoundTripPct ?? 0.08
  const closedRows: import('../notifier').EodTradeRow[] = []
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
      if (ts < dayStart || ts > dayEnd) continue
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

export async function sendBreakoutEodSummary(utcDate: string): Promise<void> {
  // Idempotency check via BreakoutConfig.lastScanResult.eodSentForDate.
  const cfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  const marker = ((cfg?.lastScanResult as any) || {}).eodSentForDate
  if (marker === utcDate) {
    console.log(`[BreakoutEOD] summary for ${utcDate} already sent — skipping`)
    return
  }

  // Variant C cleanup — отменить все PENDING_LIMIT за прошедший день.
  // Не сработавший за день limit = пробой не подтвердился, range устарел.
  try {
    const { cancelStaleLimitsEod } = await import('../dailyBreakoutLimitTrader')
    await cancelStaleLimitsEod()
  } catch (e: any) {
    console.warn(`[BreakoutEOD] C cancel stale limits failed: ${e.message}`)
  }

  const a = await buildVariantEodSummary('A', utcDate)
  const b = await buildVariantEodSummary('B', utcDate)
  const c = await buildVariantEodSummary('C', utcDate)

  try {
    await sendNotification('BREAKOUT_EOD_CLOSED', {
      utcDate,
      summaries: [a.closed, b.closed, c.closed],
    })
  } catch (e: any) {
    console.error(`[BreakoutEOD] CLOSED notify failed: ${e.message}`)
  }

  // SURVIVING summary removed 2026-05-17 — EOD-FLAT policy means no carry-over
  // trades exist past 23:55 UTC, and the legacy message was double-counting
  // trades that were still in status=TP1_HIT at the moment summary ran.

  // Mark this date so we don't re-send on restart / cron restart within minutes.
  try {
    const prev = (cfg?.lastScanResult as any) || {}
    await prisma.breakoutConfig.update({
      where: { id: 1 },
      data: { lastScanResult: { ...prev, eodSentForDate: utcDate } as any },
    })
  } catch (e: any) {
    console.warn(`[BreakoutEOD] failed to persist marker: ${e.message}`)
  }

  console.log(`[BreakoutEOD] summary sent for ${utcDate}: A closed=${a.closed.trades.length}, B closed=${b.closed.trades.length}, C closed=${c.closed.trades.length}`)
}
