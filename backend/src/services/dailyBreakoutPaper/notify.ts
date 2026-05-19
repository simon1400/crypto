import { prisma } from '../../db/prisma'
import { sendNotification, VariantOpenInfo } from '../notifier'
import { BreakoutVariant, logTag } from '../breakoutVariant'
import { OpenedTradeInfo } from './types'

/**
 * Telegram notify for trades opened off-cycle (timer-driven slow/fast tick when
 * scanner inline didn't fire — e.g. boot, refill after terminal close, manual
 * scan). Sends one message per signal with this variant's sizing block. The
 * scanner itself uses its own consolidated path (A+B in one message) and
 * does NOT call this helper.
 */
export async function notifySingleVariantOpens(opened: OpenedTradeInfo[], variant: BreakoutVariant): Promise<void> {
  for (const t of opened) {
    const v: VariantOpenInfo = {
      variant,
      depositUsd: t.depositUsd,
      riskPctPerTrade: t.riskPctPerTrade,
      riskUsd: t.riskUsd,
      positionSizeUsd: t.positionSizeUsd,
      positionUnits: t.positionUnits,
      marginUsd: t.marginUsd,
      leverage: t.leverage,
      cappedByMaxLeverage: t.cappedByMaxLeverage,
      targetMarginPct: t.targetMarginPct,
    }
    try {
      await sendNotification('BREAKOUT_OPENED', {
        symbol: t.symbol,
        side: t.side,
        reason: t.reason,
        variants: [v],
      })
      if (variant === 'A') {
        try {
          await prisma.breakoutSignal.update({
            where: { id: t.signalId },
            data: { notifiedTelegram: true },
          })
        } catch { /* signal may have been deleted — ignore */ }
      }
    } catch (e: any) {
      console.error(`${logTag(variant)} OPENED notify failed for sig ${t.signalId}: ${e.message}`)
    }
  }
}
