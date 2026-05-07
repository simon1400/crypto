import { Router } from 'express'
import { prisma } from '../db/prisma'
import {
  runBreakoutScanCycleNow, DEFAULT_BREAKOUT_SETUPS,
} from '../services/dailyBreakoutLiveScanner'
import { runBreakoutTrackerCycle } from '../services/dailyBreakoutTracker'

const router = Router()

// === Config ===
router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.breakoutConfig.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const { enabled, symbolsEnabled, rangeBars, volumeMultiplier, notifyOnNew, notifyOnClose } = req.body
    const cfg = await prisma.breakoutConfig.update({
      where: { id: 1 },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(symbolsEnabled !== undefined ? { symbolsEnabled } : {}),
        ...(rangeBars !== undefined ? { rangeBars } : {}),
        ...(volumeMultiplier !== undefined ? { volumeMultiplier } : {}),
        ...(notifyOnNew !== undefined ? { notifyOnNew } : {}),
        ...(notifyOnClose !== undefined ? { notifyOnClose } : {}),
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/setups', async (_req, res) => {
  res.json({ setups: DEFAULT_BREAKOUT_SETUPS })
})

// === Signals ===
router.get('/signals', async (req, res) => {
  try {
    const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (status) where.status = { in: status.split(',') }
    if (symbol) where.symbol = symbol
    const [data, total] = await Promise.all([
      prisma.breakoutSignal.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.breakoutSignal.count({ where }),
    ])
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
    res.json(sig)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// === Manual scan/track triggers ===
router.post('/scan-now', async (_req, res) => {
  try {
    await runBreakoutScanCycleNow()
    const cfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
    res.json({ ok: true, lastScanAt: cfg?.lastScanAt, lastScanResult: cfg?.lastScanResult })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/track-now', async (_req, res) => {
  try {
    const processed = await runBreakoutTrackerCycle()
    res.json({ processed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
