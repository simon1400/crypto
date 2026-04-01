import { prisma } from '../db/prisma'
import { OrderAction } from './types'
import { sendNotification } from '../services/notifier'

/**
 * Log a trading action to the OrderLog table.
 *
 * Every trading action (order placed, filled, cancelled, SL/TP hit, etc.)
 * is recorded with optional position and signal references for traceability.
 */
export async function logOrderAction(
  action: OrderAction,
  opts: {
    positionId?: number
    signalId?: number
    details?: Record<string, any>
  }
): Promise<void> {
  await prisma.orderLog.create({
    data: {
      action,
      positionId: opts.positionId,
      signalId: opts.signalId,
      details: opts.details ?? {},
    },
  })

  console.log(
    `[OrderLog] ${action} pos=${opts.positionId ?? '-'} sig=${opts.signalId ?? '-'}`
  )

  // Fire-and-forget notification
  sendNotification(action, opts.details).catch(() => {})
}
