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

    const { results, funnel, savedIds } = await runScan(
      coins || SCAN_COINS,
      minScore ?? 40,
      useGPT ?? true,
    )

    res.json({
      total: results.length,
      funnel,
      regime: results[0]?.regime || null,
      signals: results.map(r => ({
        savedId: savedIds[r.signal.coin] || null,
        coin: r.signal.coin,
        type: r.signal.type,
        strategy: r.signal.strategy,
        score: r.signal.score,
        category: r.category,
        scoreBreakdown: r.signal.scoreBreakdown,
        // Best entry model
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
        bestEntryType: r.signal.bestEntryType,
        // All entry models
        entryModels: r.signal.entryModels,
        reasons: r.signal.reasons,
        // GPT annotation (not verdict)
        setupQuality: r.gptAnnotation.setupQuality,
        aiCommentary: r.gptAnnotation.commentary,
        aiRisks: r.gptAnnotation.risks,
        aiConflicts: r.gptAnnotation.conflicts,
        aiKeyLevels: r.gptAnnotation.keyLevels,
        recommendedEntryType: r.gptAnnotation.recommendedEntryType,
        waitForConfirmation: r.gptAnnotation.waitForConfirmation,
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
    const category = req.query.category as string | undefined

    const dateFrom = req.query.dateFrom as string | undefined
    const dateTo = req.query.dateTo as string | undefined

    const where: any = {}
    if (status) where.status = status
    if (coin) where.coin = { contains: coin.toUpperCase() }
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setDate(end.getDate() + 1)
        where.createdAt.lt = end
      }
    }
    // Category is stored inside marketContext JSON — filter in app layer if needed

    const [data, total] = await Promise.all([
      prisma.generatedSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.generatedSignal.count({ where }),
    ])

    // Post-filter by category if requested
    let filtered = data
    if (category) {
      filtered = data.filter((s: any) => {
        const mc = s.marketContext as any
        return mc?.category === category
      })
    }

    res.json({
      data: filtered,
      total: category ? filtered.length : total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/signals/:id/take — take signal (start tracking)
router.post('/signals/:id/take', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { amount } = req.body as { amount?: number }

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })
    if (signal.status !== 'NEW') return res.status(400).json({ error: 'Signal already taken or closed' })

    const updated = await prisma.generatedSignal.update({
      where: { id },
      data: {
        status: 'TAKEN',
        amount: amount || 0,
        takenAt: new Date(),
      },
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/signals/:id/take-trade — take signal and create a tracked Trade
router.post('/signals/:id/take-trade', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { amount, modelType, leverage: customLeverage } = req.body as { amount: number; modelType?: string; leverage?: number }

    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required (USDT)' })

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })
    if (signal.status !== 'NEW') return res.status(400).json({ error: 'Signal already taken or closed' })

    // Pick entry model if specified
    const mc = signal.marketContext as any
    const models = (mc?.entryModels as any[]) || []
    const model = modelType
      ? models.find((m: any) => m.type === modelType && m.viable) || models[0]
      : models[0]

    const entry = model?.entry ?? signal.entry
    const stopLoss = model?.stopLoss ?? signal.stopLoss
    const leverage = customLeverage || model?.leverage || signal.leverage
    const tps = model?.takeProfits ?? signal.takeProfits as any[]

    // Build TP array with percent distribution
    const tpCount = tps.length
    const tpPercents = tpCount <= 1 ? [100]
      : tpCount === 2 ? [50, 50]
      : tpCount === 3 ? [40, 30, 30]
      : [30, 25, 25, 20]
    const takeProfits = tps.map((tp: any, i: number) => ({
      price: tp.price,
      percent: tpPercents[i] || Math.floor(100 / tpCount),
    }))

    // Create Trade with PENDING_ENTRY — waits for price to reach entry
    const trade = await prisma.trade.create({
      data: {
        coin: signal.coin.toUpperCase().replace('USDT', '') + 'USDT',
        type: signal.type,
        leverage,
        entryPrice: entry,
        amount,
        stopLoss,
        takeProfits,
        status: 'PENDING_ENTRY',
        source: 'SCANNER',
        notes: `Scanner signal #${signal.id} | ${signal.strategy} | Score: ${signal.score}${model ? ` | Model: ${model.type}` : ''}`,
      },
    })

    // Mark signal as TAKEN
    await prisma.generatedSignal.update({
      where: { id },
      data: { status: 'TAKEN', amount, takenAt: new Date() },
    })

    console.log(`[Scanner] Signal #${id} taken as Trade #${trade.id} (${trade.coin} ${trade.type} $${entry}, ${leverage}x, $${amount})`)
    res.json({ trade, signal: { id, status: 'TAKEN' } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/signals/:id/close — partial/full close at price
router.post('/signals/:id/close', async (req, res) => {
  try {
    const { price, percent } = req.body as { price: number; percent: number }
    if (!price || !percent) return res.status(400).json({ error: 'price and percent required' })

    const signal = await prisma.generatedSignal.findUnique({ where: { id: Number(req.params.id) } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })
    if (['CLOSED', 'SL_HIT', 'EXPIRED', 'NEW'].includes(signal.status)) {
      return res.status(400).json({ error: 'Signal cannot be closed in current status' })
    }

    const closePrice = Number(price)
    const closePct = Number(percent)
    const newClosedPct = Math.min(100, signal.closedPct + closePct)

    const direction = signal.type === 'LONG' ? 1 : -1
    const priceDiff = (closePrice - signal.entry) * direction
    const pnlPercent = (priceDiff / signal.entry) * 100 * signal.leverage
    const portionAmount = signal.amount * (closePct / 100)
    const pnlUsdt = portionAmount * (pnlPercent / 100)

    const closes = Array.isArray(signal.closes) ? [...(signal.closes as any[])] : []
    closes.push({
      price: closePrice,
      percent: closePct,
      pnl: Math.round(pnlUsdt * 100) / 100,
      pnlPercent: Math.round(pnlPercent * 100) / 100,
      closedAt: new Date().toISOString(),
    })

    const newRealizedPnl = Math.round((signal.realizedPnl + pnlUsdt) * 100) / 100
    const isFull = newClosedPct >= 100
    const newStatus = isFull ? 'CLOSED' : 'PARTIALLY_CLOSED'

    const updated = await prisma.generatedSignal.update({
      where: { id: signal.id },
      data: {
        closes,
        closedPct: newClosedPct,
        realizedPnl: newRealizedPnl,
        status: newStatus,
        closedAt: isFull ? new Date() : null,
      },
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/signals/:id/sl-hit — stop loss hit
router.post('/signals/:id/sl-hit', async (req, res) => {
  try {
    const signal = await prisma.generatedSignal.findUnique({ where: { id: Number(req.params.id) } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })

    const remainingPct = 100 - signal.closedPct
    const direction = signal.type === 'LONG' ? 1 : -1
    const priceDiff = (signal.stopLoss - signal.entry) * direction
    const pnlPercent = (priceDiff / signal.entry) * 100 * signal.leverage
    const portionAmount = signal.amount * (remainingPct / 100)
    const pnlUsdt = portionAmount * (pnlPercent / 100)

    const closes = Array.isArray(signal.closes) ? [...(signal.closes as any[])] : []
    closes.push({
      price: signal.stopLoss,
      percent: remainingPct,
      pnl: Math.round(pnlUsdt * 100) / 100,
      pnlPercent: Math.round(pnlPercent * 100) / 100,
      closedAt: new Date().toISOString(),
      isSL: true,
    })

    const updated = await prisma.generatedSignal.update({
      where: { id: signal.id },
      data: {
        closes,
        closedPct: 100,
        realizedPnl: Math.round((signal.realizedPnl + pnlUsdt) * 100) / 100,
        status: 'SL_HIT',
        closedAt: new Date(),
      },
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/scanner/signals/:id/status — update signal status (skip/expire)
router.put('/signals/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { status } = req.body as { status: string }

    const valid = ['EXPIRED']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Use /take, /close, or /sl-hit endpoints instead' })
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