/**
 * Variant-parameterised router factory for the Daily Breakout paper trader.
 *
 * Both /api/breakout-paper (variant A, prod) and /api/breakout-paper-b (variant B,
 * alternate sizing experiment) mount the same set of endpoints. This factory builds
 * a Router for a given variant, routing all DB reads/writes to the variant's
 * config + trade tables via the breakoutVariant helper.
 *
 * Variant A is allowed to mutate the shared BreakoutSignal table (legacy behavior:
 * DELETE /trades/:id also deletes the originating signal so the cron doesn't
 * re-open it). Variant B does NOT touch shared signals — deleting a B trade only
 * removes the B row; the signal stays for variant A.
 */

import { Router } from 'express'
import { BreakoutVariant, configModel, tradeModel } from '../../services/breakoutVariant'
import { registerConfigRoutes } from './config.routes'
import { registerTradesRoutes } from './trades.routes'
import { registerCloseRoutes } from './close.routes'
import { registerStatsRoutes } from './stats.routes'
import { registerSignalsRoutes } from './signals.routes'

export { buildSharedReadHandlers } from './sharedHandlers'

export function buildBreakoutPaperRouter(variant: BreakoutVariant): Router {
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any
  const router = Router()

  registerConfigRoutes(router, variant, cm, tm)
  // Order matters: /trades/live must register before /trades/:id so Express
  // doesn't match "live" as the :id param.
  registerTradesRoutes(router, variant, cm, tm)
  registerCloseRoutes(router, variant, cm, tm)
  registerStatsRoutes(router, variant, cm, tm)
  registerSignalsRoutes(router, variant, tm)

  return router
}
