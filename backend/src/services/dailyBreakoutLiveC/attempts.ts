/**
 * Attempt audit — every decision around a placement (placed, exchange-rejected,
 * or skipped by our gate / pre-placement filter) writes a row to
 * BreakoutLiveAttemptC. The LIVE UI 'Отклонённые' tab reads these so the user
 * can see what each cycle tried and why it didn't open.
 */

import { prisma } from '../../db/prisma'
import { LOG } from './state'

export interface AttemptArgs {
  symbol: string
  side: 'BUY' | 'SELL'
  rangeDate: string
  // PLACED | REJECTED_EXCHANGE | SKIPPED_GATE | SKIPPED_FILTER
  status: 'PLACED' | 'REJECTED_EXCHANGE' | 'SKIPPED_GATE' | 'SKIPPED_FILTER'
  reasonCode?: string | null
  reasonText?: string | null
  limitPrice?: number | null
  markPrice?: number | null
  rangeHigh?: number | null
  rangeLow?: number | null
}

export async function recordAttempt(a: AttemptArgs): Promise<void> {
  try {
    await prisma.breakoutLiveAttemptC.create({
      data: {
        symbol: a.symbol,
        side: a.side,
        rangeDate: a.rangeDate,
        status: a.status,
        reasonCode: a.reasonCode ?? null,
        reasonText: a.reasonText ?? null,
        limitPrice: a.limitPrice ?? null,
        markPrice: a.markPrice ?? null,
        rangeHigh: a.rangeHigh ?? null,
        rangeLow: a.rangeLow ?? null,
      },
    })
  } catch (e: any) {
    // Best-effort audit — never break the placement cycle if logging fails.
    console.warn(`${LOG} recordAttempt failed for ${a.symbol} ${a.side}: ${e.message}`)
  }
}

/**
 * Drop attempt rows older than today so the table stays bounded. Called at
 * EOD alongside cancelOrphanPendingLimits / flatten.
 */
export async function pruneOldAttempts(): Promise<void> {
  const utcDate = new Date().toISOString().slice(0, 10)
  try {
    const r = await prisma.breakoutLiveAttemptC.deleteMany({
      where: { rangeDate: { lt: utcDate } },
    })
    if (r.count > 0) {
      console.log(`${LOG} pruned ${r.count} attempt(s) from prior UTC days`)
    }
  } catch (e: any) {
    console.warn(`${LOG} pruneOldAttempts failed: ${e.message}`)
  }
}
