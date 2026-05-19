import { prisma } from '../../db/prisma'

/**
 * Sync BreakoutSignal.status to mirror what paper trade did. Replaces the
 * separate dailyBreakoutTracker cron — paper trader is the single source of
 * truth for live tracking. Used by variant A only (variant B/C does not
 * mutate shared signals).
 */
export async function syncSignalStatus(
  signalId: number,
  newStatus: 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'CLOSED' | 'SL_HIT' | 'EXPIRED',
  realizedR: number | null,
  lastPriceCheck: number | null,
  closedAt: Date | null,
  closes: any[] | null,
): Promise<void> {
  try {
    const data: any = { status: newStatus }
    if (realizedR != null) data.realizedR = realizedR
    if (lastPriceCheck != null) {
      data.lastPriceCheck = lastPriceCheck
      data.lastPriceCheckAt = new Date()
    }
    if (closedAt) data.closedAt = closedAt
    if (closes) data.closes = closes
    await prisma.breakoutSignal.update({ where: { id: signalId }, data })
  } catch { /* signal may have been deleted manually — ignore */ }
}
