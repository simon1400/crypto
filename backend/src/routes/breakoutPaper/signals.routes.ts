import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { forceOpenSignal } from '../../services/dailyBreakoutPaperTrader'
import { BreakoutVariant } from '../../services/breakoutVariant'
import { applySignalOverlay } from './helpers'

// Signals view: same shared BreakoutSignal stream, but joined with this
// variant's PaperTrade table so paperStatus / paperReason reflect the variant's
// outcome (not just A's). The shared signal's own status/closes still come from
// BreakoutSignal (only A mirrors them; for B these reflect "what would A's view be").
export function registerSignalsRoutes(router: Router, variant: BreakoutVariant, tm: any): void {
  router.get('/signals', async (req, res) => {
    try {
      const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
      const where: any = {}
      if (status) where.status = { in: status.split(',') }
      if (symbol) where.symbol = symbol
      const [signals, total] = await Promise.all([
        prisma.breakoutSignal.findMany({
          where, orderBy: { createdAt: 'desc' },
          skip: parseInt(offset, 10) || 0,
          take: Math.min(parseInt(limit, 10) || 100, 500),
        }),
        prisma.breakoutSignal.count({ where }),
      ])
      const trades = await tm.findMany({
        where: { signalId: { in: signals.map(s => s.id) } },
        select: {
          id: true, signalId: true, status: true, leverage: true, marginUsd: true,
          realizedR: true, realizedPnlUsd: true, feesPaidUsd: true, netPnlUsd: true,
          closes: true, openedAt: true, closedAt: true, lastPriceCheck: true,
        },
      })
      const tradeBySigId = new Map<number, any>()
      for (const t of trades) tradeBySigId.set(t.signalId, t)

      const data = signals.map((s: any) =>
        applySignalOverlay(s, variant, tradeBySigId.get(s.id) ?? null)
      )
      res.json({ data, total })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/signals/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const sig = await prisma.breakoutSignal.findUnique({ where: { id } })
      if (!sig) return res.status(404).json({ error: 'Not found' })
      const t = await tm.findFirst({ where: { signalId: id } })
      res.json(applySignalOverlay(sig, variant, t ?? null))
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // Force-open a SKIPPED signal in this variant. Bypasses guards (concurrent/margin/etc).
  router.post('/signals/:id/force-open', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      const result = await forceOpenSignal(id, variant)
      if (!result.ok) return res.status(400).json(result)
      res.json(result)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })
}
