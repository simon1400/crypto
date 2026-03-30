import { Router } from 'express'
import { runScan, isScannerRunning, SCAN_COINS, expireOldSignals } from '../scanner/coinScanner'
import { prisma } from '../db/prisma'

const router = Router()

// POST /api/scanner/scan — trigger manual scan
router.post('/scan', async (req, res) => {
  try {
    if (isScannerRunning()) {
      return res.status(409).json({ error: 'Scanner already running' })
    }

    const { coins, minScore, useGPT } = req.body as {
      coins?: string[]
      minScore?: number
      useGPT?: boolean
    }

    const results = await runScan(
      coins || SCAN_COINS,
      minScore ?? 55,
      useGPT ?? true,
    )

    res.json({
      total: results.length,
      confirmed: results.filter(r => r.gptReview.verdict === 'CONFIRM').length,
      rejected: results.filter(r => r.gptReview.verdict === 'REJECT').length,
      regime: results[0]?.regime || null,
      signals: results.map(r => ({
        coin: r.signal.coin,
        type: r.signal.type,
        strategy: r.signal.strategy,
        score: r.signal.score,
        scoreBreakdown: r.signal.scoreBreakdown,
        entry: r.signal.entry,
        stopLoss: r.signal.stopLoss,
        slPercent: r.signal.slPercent,
        takeProfits: r.signal.takeProfits,
        tp1Percent: r.signal.tp1Percent,
        tp2Percent: r.signal.tp2Percent,
        tp3Percent: r.signal.tp3Percent,
        leverage: r.signal.leverage,
        positionPct: r.signal.positionPct,
        riskReward: r.signal.riskReward,
        reasons: r.signal.reasons,
        gptVerdict: r.gptReview.verdict,
        gptConfidence: r.gptReview.confidence,
        gptReasoning: r.gptReview.reasoning,
        gptRisks: r.gptReview.risks,
        gptKeyLevels: r.gptReview.keyLevels,
      })),
    })
  } catch (err: any) {
    console.error('[Scanner Route] Error:', err)
    res.status(500).json({ error: err.message || 'Scan failed' })
  }
})

// GET /api/scanner/status — check if scanner is running
router.get('/status', (_req, res) => {
  res.json({ running: isScannerRunning() })
})

// GET /api/scanner/signals — get saved signals with pagination
router.get('/signals', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const status = req.query.status as string | undefined
    const coin = req.query.coin as string | undefined

    const where: any = {}
    if (status) where.status = status
    if (coin) where.coin = { contains: coin.toUpperCase() }

    const [data, total] = await Promise.all([
      prisma.generatedSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.generatedSignal.count({ where }),
    ])

    res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/scanner/signals/:id/status — update signal status (TAKEN, etc.)
router.put('/signals/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { status } = req.body as { status: string }

    const valid = ['NEW', 'TAKEN', 'EXPIRED', 'HIT_TP', 'HIT_SL']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` })
    }

    const signal = await prisma.generatedSignal.update({
      where: { id },
      data: { status },
    })

    res.json(signal)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/scanner/signals/:id — delete a signal
router.delete('/signals/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    await prisma.generatedSignal.delete({ where: { id } })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/expire — manually expire old signals
router.post('/expire', async (_req, res) => {
  try {
    const count = await expireOldSignals()
    res.json({ expired: count })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/scanner/coins — get available coins list
router.get('/coins', (_req, res) => {
  res.json({ coins: SCAN_COINS })
})

export default router
