import { Router } from 'express'
import { prisma } from '../db/prisma'
import { runLevelsScanCycle, DEFAULT_SETUPS } from '../services/levelsLiveScanner'
import { runLevelsTrackerCycle } from '../services/levelsTracker'

const router = Router()

// GET /api/levels?market=FOREX&status=NEW,ACTIVE&symbol=XAUUSD&limit=100
router.get('/', async (req, res) => {
  try {
    const { market, status, symbol, side, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (market) where.market = market
    if (symbol) where.symbol = symbol
    if (side) where.side = side
    if (status) where.status = { in: status.split(',') }

    const [data, total] = await Promise.all([
      prisma.levelsSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.levelsSignal.count({ where }),
    ])
    res.json({ data, total })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/stats', async (_req, res) => {
  try {
    const all = await prisma.levelsSignal.findMany({
      where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT'] } },
    })
    const bySymbol: Record<string, { trades: number; wins: number; totalR: number }> = {}
    for (const s of all) {
      const sym = s.symbol
      if (!bySymbol[sym]) bySymbol[sym] = { trades: 0, wins: 0, totalR: 0 }
      bySymbol[sym].trades++
      bySymbol[sym].totalR += s.realizedR
      if (s.realizedR > 0) bySymbol[sym].wins++
    }
    const totalTrades = all.length
    const totalR = all.reduce((a, s) => a + s.realizedR, 0)
    const wins = all.filter((s) => s.realizedR > 0).length
    res.json({
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades > 0 ? wins / totalTrades : 0,
      totalR,
      expectancyR: totalTrades > 0 ? totalR / totalTrades : 0,
      bySymbol,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.levelsConfig.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1, enabled: false, symbolsEnabled: [],
        cronIntervalMin: 5, expiryHours: 24,
        notifyOnNew: true, notifyOnClose: true,
      },
    })
    res.json({ config: cfg, defaultSetups: DEFAULT_SETUPS })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const { enabled, symbolsEnabled, expiryHours, notifyOnNew, notifyOnClose } = req.body
    const cfg = await prisma.levelsConfig.upsert({
      where: { id: 1 },
      update: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(symbolsEnabled !== undefined ? { symbolsEnabled } : {}),
        ...(expiryHours !== undefined ? { expiryHours } : {}),
        ...(notifyOnNew !== undefined ? { notifyOnNew } : {}),
        ...(notifyOnClose !== undefined ? { notifyOnClose } : {}),
      },
      create: {
        id: 1,
        enabled: enabled ?? false,
        symbolsEnabled: symbolsEnabled ?? [],
        cronIntervalMin: 5,
        expiryHours: expiryHours ?? 24,
        notifyOnNew: notifyOnNew ?? true,
        notifyOnClose: notifyOnClose ?? true,
      },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/scan-now', async (_req, res) => {
  try {
    const result = await runLevelsScanCycle()
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/track-now', async (_req, res) => {
  try {
    const processed = await runLevelsTrackerCycle()
    res.json({ processed })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const s = await prisma.levelsSignal.findUnique({ where: { id } })
    if (!s) return res.status(404).json({ error: 'Not found' })
    res.json(s)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const updated = await prisma.levelsSignal.update({
      where: { id },
      data: { status: 'EXPIRED', closedAt: new Date() },
    })
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
