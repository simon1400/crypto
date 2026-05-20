import type { Request, Response } from 'express'
import { BreakoutVariant, configModel, tradeModel } from '../../services/breakoutVariant'
import { ACTIVE_STATUSES, computeUnrealizedForTrades, computeStatsResponse } from './helpers'

/**
 * Build shared read-only handlers parameterised by variant. Used by the live
 * router to expose /trades/live and /stats with identical shape to paper —
 * the BreakoutPaper component renders both off the same response.
 *
 * Mutating endpoints (PUT /trades/:id, POST /reset, etc.) are NOT exported
 * here because they touch paper-specific helpers (resetBreakoutPaperAccount,
 * syncSignalStatus) which assume paper config shape. Live has its own
 * /baseline/reset and /kill-switch routes instead.
 */
export function buildSharedReadHandlers(variant: BreakoutVariant) {
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any

  const tradesLive = async (_req: Request, res: Response) => {
    try {
      const trades = await tm.findMany({
        where: { status: { in: [...ACTIVE_STATUSES] } },
      })
      const result = await computeUnrealizedForTrades(trades, variant)
      res.json(result)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  }

  const stats = async (_req: Request, res: Response) => {
    try {
      const payload = await computeStatsResponse(cm, tm, variant)
      res.json(payload)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  }

  return { tradesLive, stats }
}
