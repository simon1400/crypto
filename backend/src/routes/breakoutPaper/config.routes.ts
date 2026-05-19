import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { resetBreakoutPaperAccount } from '../../services/dailyBreakoutPaper'
import { BreakoutVariant } from '../../services/breakoutVariant'

export function registerConfigRoutes(router: Router, variant: BreakoutVariant, cm: any, tm: any): void {
  router.get('/config', async (_req, res) => {
    try {
      const cfg = await cm.upsert({
        where: { id: 1 }, update: {}, create: { id: 1 },
      })
      res.json(cfg)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.put('/config', async (req, res) => {
    try {
      const {
        enabled, riskPctPerTrade, feesRoundTripPct, autoTrailingSL,
        feeTakerPct, feeMakerPct, slipTakerPct,
        targetMarginPct, marginGuardEnabled, marginGuardAutoClose,
        dailyLossLimitPct, weeklyLossLimitPct,
        maxConcurrentPositions, maxPositionsPerSymbol,
      } = req.body
      const cfg = await cm.update({
        where: { id: 1 },
        data: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(riskPctPerTrade !== undefined ? { riskPctPerTrade } : {}),
          ...(feesRoundTripPct !== undefined ? { feesRoundTripPct } : {}),
          ...(feeTakerPct !== undefined ? { feeTakerPct } : {}),
          ...(feeMakerPct !== undefined ? { feeMakerPct } : {}),
          ...(slipTakerPct !== undefined ? { slipTakerPct } : {}),
          ...(autoTrailingSL !== undefined ? { autoTrailingSL } : {}),
          ...(targetMarginPct !== undefined ? { targetMarginPct } : {}),
          ...(marginGuardEnabled !== undefined ? { marginGuardEnabled } : {}),
          ...(marginGuardAutoClose !== undefined ? { marginGuardAutoClose } : {}),
          ...(dailyLossLimitPct !== undefined ? { dailyLossLimitPct } : {}),
          ...(weeklyLossLimitPct !== undefined ? { weeklyLossLimitPct } : {}),
          ...(maxConcurrentPositions !== undefined ? { maxConcurrentPositions } : {}),
          ...(maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol } : {}),
        },
      })
      res.json(cfg)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/reset', async (req, res) => {
    try {
      const { startingDepositUsd } = req.body
      const cfg = await resetBreakoutPaperAccount(startingDepositUsd, variant)
      res.json(cfg)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // wipe-all: variant A wipes shared signals (legacy behavior). Variant B only
  // wipes its own trades + resets its own config — never touches shared signals.
  router.post('/wipe-all', async (req, res) => {
    try {
      const { startingDepositUsd } = req.body as { startingDepositUsd?: number }
      const tradesDeleted = await tm.deleteMany({})
      let signalsDeleted = 0
      if (variant === 'A') {
        const r = await prisma.breakoutSignal.deleteMany({})
        signalsDeleted = r.count
      }
      const cfg = await resetBreakoutPaperAccount(startingDepositUsd, variant)
      res.json({
        ok: true,
        deletedTrades: tradesDeleted.count,
        deletedSignals: signalsDeleted,
        config: cfg,
      })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })
}
