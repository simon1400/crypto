import { Router } from 'express'
import { prisma } from '../db/prisma'
import { runPaperCycle, resetPaperAccount } from '../services/levelsPaperTrader'

const router = Router()

router.get('/config', async (_req, res) => {
  try {
    const cfg = await prisma.levelsPaperConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    })
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.put('/config', async (req, res) => {
  try {
    const {
      enabled, riskPctPerTrade, feesRoundTripPct,
      dailyLossLimitPct, weeklyLossLimitPct,
      maxConcurrentPositions, maxPositionsPerSymbol,
    } = req.body
    const cfg = await prisma.levelsPaperConfig.update({
      where: { id: 1 },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(riskPctPerTrade !== undefined ? { riskPctPerTrade } : {}),
        ...(feesRoundTripPct !== undefined ? { feesRoundTripPct } : {}),
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
    const cfg = await resetPaperAccount(startingDepositUsd)
    res.json(cfg)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/cycle-now', async (_req, res) => {
  try {
    const result = await runPaperCycle()
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/trades', async (req, res) => {
  try {
    const { status, symbol, limit = '100', offset = '0' } = req.query as Record<string, string>
    const where: any = {}
    if (status) where.status = { in: status.split(',') }
    if (symbol) where.symbol = symbol
    const [data, total] = await Promise.all([
      prisma.levelsPaperTrade.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: parseInt(offset, 10) || 0,
        take: Math.min(parseInt(limit, 10) || 100, 500),
      }),
      prisma.levelsPaperTrade.count({ where }),
    ])
    res.json({ data, total })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/stats', async (_req, res) => {
  try {
    const cfg = await prisma.levelsPaperConfig.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    const closed = await prisma.levelsPaperTrade.findMany({
      where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
      select: { netPnlUsd: true, openedAt: true, closedAt: true, symbol: true },
    })
    const winRate = closed.length > 0 ? closed.filter((t) => t.netPnlUsd > 0).length / closed.length : 0

    // Equity curve — group closed trades by day
    const byDay: Record<string, number> = {}
    for (const t of closed) {
      const day = (t.closedAt ?? t.openedAt).toISOString().slice(0, 10)
      byDay[day] = (byDay[day] ?? 0) + t.netPnlUsd
    }
    const equityCurve: Array<{ date: string; pnl: number; equity: number }> = []
    let running = cfg.startingDepositUsd
    for (const date of Object.keys(byDay).sort()) {
      running += byDay[date]
      equityCurve.push({ date, pnl: byDay[date], equity: running })
    }

    // Per-symbol breakdown
    const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {}
    for (const t of closed) {
      bySymbol[t.symbol] = bySymbol[t.symbol] ?? { trades: 0, wins: 0, pnl: 0 }
      bySymbol[t.symbol].trades++
      bySymbol[t.symbol].pnl += t.netPnlUsd
      if (t.netPnlUsd > 0) bySymbol[t.symbol].wins++
    }

    res.json({
      config: cfg,
      winRate,
      returnPct: cfg.startingDepositUsd > 0 ? ((cfg.currentDepositUsd - cfg.startingDepositUsd) / cfg.startingDepositUsd) * 100 : 0,
      bySymbol,
      equityCurve,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/trades/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const trade = await prisma.levelsPaperTrade.findUnique({ where: { id } })
    if (!trade) return res.status(404).json({ error: 'Not found' })
    res.json(trade)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
