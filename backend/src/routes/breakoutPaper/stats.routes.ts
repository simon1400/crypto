import { Router } from 'express'
import { BreakoutVariant } from '../../services/breakoutVariant'
import { computeStatsResponse } from './helpers'

export function registerStatsRoutes(router: Router, variant: BreakoutVariant, cm: any, tm: any): void {
  router.get('/stats', async (_req, res) => {
    try {
      const payload = await computeStatsResponse(cm, tm, variant)
      res.json(payload)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })
}
