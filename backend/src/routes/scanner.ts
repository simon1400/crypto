import { Router } from 'express'
import { runScan, isScannerRunning, SCAN_COINS, expireOldSignals } from '../scanner/coinScanner'
import { analyzeEntries, isEntryAnalyzerRunning } from '../scanner/entryAnalyzer'
import { prisma } from '../db/prisma'
import { assertBudget, BudgetError } from '../services/budget'
import { adjustVirtualBalance } from '../services/virtualBalance'
import { OrderType } from '../services/fees'

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

    // Use provided coins, or load from DB selection, or fallback to default
    let scanCoins = coins
    if (!scanCoins) {
      const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
      const selected = (config?.scannerCoins as string[]) || []
      scanCoins = selected.length > 0 ? selected : SCAN_COINS
    }

    const { results, funnel, savedIds } = await runScan(
      scanCoins,
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
        scoreBand: r.scoreBand,
        entryQuality: r.entryQuality,
        triggerState: r.triggerState,
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
        // GPT annotation (overlay, not verdict)
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
    const { amount, modelType, leverage: customLeverage, orderType } = req.body as { amount: number; modelType?: string; leverage?: number; orderType?: OrderType }

    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required (USDT)' })

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })
    if (signal.status !== 'NEW') return res.status(400).json({ error: 'Signal already taken or closed' })

    const orderTypeNorm: OrderType = orderType === 'limit' ? 'limit' : 'market'

    // Бюджетный гард + расчёт entry fee
    let entryFee = 0
    try {
      // leverage берём из тела или signal — точное значение определим ниже
      const lev = Number(customLeverage) || signal.leverage
      const result = await assertBudget(Number(amount), lev, orderTypeNorm)
      entryFee = result.entryFee
    } catch (err: any) {
      if (err instanceof BudgetError) {
        return res.status(400).json({
          error: err.message,
          budget: { balance: err.balance, used: err.usedMargin, requested: err.requested },
        })
      }
      throw err
    }

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

    // Списываем entry fee из virtualBalance
    await adjustVirtualBalance(-entryFee, `entry fee ${signal.coin} scanner ${orderTypeNorm}`)

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
        entryOrderType: orderTypeNorm,
        fees: entryFee,
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

// DELETE /api/scanner/signals/all — delete all signals
router.delete('/signals/all', async (_req, res) => {
  try {
    const { count } = await prisma.generatedSignal.deleteMany({})
    res.json({ deleted: count })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/scanner/signals/unused — delete signals not taken (NEW, EXPIRED)
router.delete('/signals/unused', async (_req, res) => {
  try {
    const { count } = await prisma.generatedSignal.deleteMany({
      where: { status: { in: ['NEW', 'EXPIRED'] } },
    })
    res.json({ deleted: count })
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

// POST /api/scanner/analyze-entry — analyze limit order entry points
router.post('/analyze-entry', async (req, res) => {
  try {
    if (isEntryAnalyzerRunning()) {
      return res.status(409).json({ error: 'Entry analyzer already running' })
    }

    const { coins, useGPT } = req.body as { coins: string[]; useGPT?: boolean }
    if (!coins || !Array.isArray(coins) || coins.length === 0) {
      return res.status(400).json({ error: 'coins required (array of 1-5 tickers)' })
    }
    if (coins.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 coins per analysis' })
    }

    const { results, errors } = await analyzeEntries(coins, useGPT ?? true)

    // Save results to DB as GeneratedSignals
    const savedIds: Record<string, number> = {}
    for (const r of results) {
      const entry1Data = {
        price: r.entry1.price,
        positionPercent: r.entry1.positionPercent,
        label: r.entry1.label,
        sources: r.entry1.cluster.sources,
        totalWeight: r.entry1.cluster.totalWeight,
        distancePercent: r.entry1.cluster.distancePercent,
        fillProbability: Math.round(r.entry1.cluster.fillProbability * 100),
      }
      const entry2Data = {
        price: r.entry2.price,
        positionPercent: r.entry2.positionPercent,
        label: r.entry2.label,
        sources: r.entry2.cluster.sources,
        totalWeight: r.entry2.cluster.totalWeight,
        distancePercent: r.entry2.cluster.distancePercent,
        fillProbability: Math.round(r.entry2.cluster.fillProbability * 100),
      }

      const saved = await prisma.generatedSignal.create({
        data: {
          coin: r.coin,
          type: r.type,
          strategy: 'entry_analysis',
          score: r.score,
          entry: r.entry1.price,
          stopLoss: r.stopLoss,
          takeProfits: r.takeProfits,
          leverage: r.leverage,
          positionPct: r.positionPct,
          indicators: {},
          marketContext: JSON.parse(JSON.stringify({
            source: 'ENTRY_ANALYZER',
            entry1: entry1Data,
            entry2: entry2Data,
            avgEntry: r.avgEntry,
            slPercent: r.slPercent,
            riskReward: r.riskReward,
            currentPrice: r.currentPrice,
            regime: r.regime,
            reasons: r.reasons,
            gpt: r.gpt,
            funding: r.funding ? { rate: r.funding.fundingRate } : null,
            oi: r.oi ? { value: r.oi.openInterest } : null,
          })),
          aiAnalysis: r.gpt ? JSON.stringify(r.gpt) : null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
        },
      })
      savedIds[r.coin] = saved.id
    }

    res.json({
      total: results.length,
      errors,
      results: results.map(r => ({
        savedId: savedIds[r.coin] || null,
        coin: r.coin,
        type: r.type,
        strategy: r.strategy,
        score: r.score,
        currentPrice: r.currentPrice,
        entry1: {
          price: r.entry1.price,
          positionPercent: r.entry1.positionPercent,
          label: r.entry1.label,
          sources: r.entry1.cluster.sources,
          totalWeight: r.entry1.cluster.totalWeight,
          distancePercent: r.entry1.cluster.distancePercent,
          fillProbability: Math.round(r.entry1.cluster.fillProbability * 100),
        },
        entry2: {
          price: r.entry2.price,
          positionPercent: r.entry2.positionPercent,
          label: r.entry2.label,
          sources: r.entry2.cluster.sources,
          totalWeight: r.entry2.cluster.totalWeight,
          distancePercent: r.entry2.cluster.distancePercent,
          fillProbability: Math.round(r.entry2.cluster.fillProbability * 100),
        },
        avgEntry: r.avgEntry,
        stopLoss: r.stopLoss,
        slPercent: r.slPercent,
        takeProfits: r.takeProfits,
        leverage: r.leverage,
        positionPct: r.positionPct,
        riskReward: r.riskReward,
        reasons: r.reasons,
        regime: r.regime,
        gpt: r.gpt,
        funding: r.funding ? { rate: r.funding.fundingRate } : null,
        oi: r.oi ? { value: r.oi.openInterest } : null,
      })),
    })
  } catch (err: any) {
    console.error('[EntryAnalyzer Route] Error:', err)
    res.status(500).json({ error: err.message || 'Entry analysis failed' })
  }
})

// GET /api/scanner/entry-signals — get saved entry analyses
router.get('/entry-signals', async (req, res) => {
  try {
    const signals = await prisma.generatedSignal.findMany({
      where: { strategy: 'entry_analysis' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    res.json(signals)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/scanner/entry-signals/:id — delete a saved entry analysis
router.delete('/entry-signals/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.strategy !== 'entry_analysis') {
      return res.status(404).json({ error: 'Entry signal not found' })
    }
    await prisma.generatedSignal.delete({ where: { id } })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/take-entry — take entry analysis as 2 trades
router.post('/take-entry', async (req, res) => {
  try {
    const { coin, type, amount, leverage, entry1, entry2, stopLoss, score, signalId, takeProfits, orderType } = req.body as {
      coin: string
      type: string
      amount: number
      leverage: number
      entry1: number
      entry2: number
      stopLoss: number
      score?: number
      signalId?: number
      takeProfits: { price: number; percent: number }[]
      orderType?: OrderType
    }

    if (!coin || !type || !amount || !entry1 || !entry2 || !stopLoss) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const orderTypeNorm: OrderType = orderType === 'limit' ? 'limit' : 'market'

    // Бюджетный гард: amount — общая маржа на обе entry-сделки + entry fee на полный объём
    let entryFeeTotal = 0
    try {
      const result = await assertBudget(Number(amount), Number(leverage), orderTypeNorm)
      entryFeeTotal = result.entryFee
    } catch (err: any) {
      if (err instanceof BudgetError) {
        return res.status(400).json({
          error: err.message,
          budget: { balance: err.balance, used: err.usedMargin, requested: err.requested },
        })
      }
      throw err
    }

    const groupId = `EA-${Date.now()}`
    const symbol = coin.toUpperCase().includes('USDT') ? coin.toUpperCase() : `${coin.toUpperCase()}USDT`

    const amount1 = Math.round(amount * 0.6 * 100) / 100
    const amount2 = Math.round(amount * 0.4 * 100) / 100
    const scoreStr = score ? ` | Score: ${score}` : ''

    // Распределяем общую entry fee пропорционально между двумя сделками
    const fee1 = Math.round(entryFeeTotal * 0.6 * 1e6) / 1e6
    const fee2 = Math.round((entryFeeTotal - fee1) * 1e6) / 1e6

    // Списываем общий entry fee
    await adjustVirtualBalance(-entryFeeTotal, `entry fee ${symbol} entry-analyzer ${orderTypeNorm}`)

    // Create Trade 1 (основной вход, 60%)
    const trade1 = await prisma.trade.create({
      data: {
        coin: symbol,
        type,
        leverage,
        entryPrice: entry1,
        amount: amount1,
        stopLoss,
        takeProfits,
        status: 'PENDING_ENTRY',
        source: 'ENTRY_ANALYZER',
        entryOrderType: orderTypeNorm,
        fees: fee1,
        notes: `group:${groupId} | Entry 1 (основной)${scoreStr} | Entry 2: $${entry2}`,
      },
    })

    // Create Trade 2 (усреднение, 40%)
    const trade2 = await prisma.trade.create({
      data: {
        coin: symbol,
        type,
        leverage,
        entryPrice: entry2,
        amount: amount2,
        stopLoss,
        takeProfits,
        status: 'PENDING_ENTRY',
        source: 'ENTRY_ANALYZER',
        entryOrderType: orderTypeNorm,
        fees: fee2,
        notes: `group:${groupId} | Entry 2 (усреднение)${scoreStr} | Entry 1: $${entry1}`,
      },
    })

    // Mark saved signal as TAKEN
    if (signalId) {
      await prisma.generatedSignal.update({
        where: { id: signalId },
        data: { status: 'TAKEN', amount, takenAt: new Date() },
      }).catch(() => {})
    }

    console.log(`[EntryAnalyzer] Created trades #${trade1.id} + #${trade2.id} (${symbol} ${type}, group: ${groupId})`)
    res.json({ trade1, trade2, groupId })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/scanner/merge-entry — merge 2 entry trades into 1 averaged trade
router.post('/merge-entry', async (req, res) => {
  try {
    const { trade1Id, trade2Id } = req.body as { trade1Id: number; trade2Id: number }

    const [t1, t2] = await Promise.all([
      prisma.trade.findUnique({ where: { id: trade1Id } }),
      prisma.trade.findUnique({ where: { id: trade2Id } }),
    ])

    if (!t1 || !t2) return res.status(404).json({ error: 'Trades not found' })
    if (t1.source !== 'ENTRY_ANALYZER' || t2.source !== 'ENTRY_ANALYZER') {
      return res.status(400).json({ error: 'Both trades must be ENTRY_ANALYZER source' })
    }

    // Calculate weighted average entry
    const totalAmount = t1.amount + t2.amount
    const avgEntry = Math.round(((t1.entryPrice * t1.amount + t2.entryPrice * t2.amount) / totalAmount) * 10000) / 10000

    // Recalculate TP R:R from averaged entry
    const tps = t1.takeProfits as any[]
    const riskAmount = Math.abs(avgEntry - t1.stopLoss)
    const direction = t1.type === 'LONG' ? 1 : -1
    const newTPs = tps.map((tp: any) => ({
      price: tp.price,
      percent: tp.percent,
      rr: riskAmount > 0 ? Math.round(((tp.price - avgEntry) * direction / riskAmount) * 100) / 100 : 0,
    }))

    // Delete both old trades
    await prisma.trade.deleteMany({ where: { id: { in: [trade1Id, trade2Id] } } })

    // Create merged trade
    const merged = await prisma.trade.create({
      data: {
        coin: t1.coin,
        type: t1.type,
        leverage: t1.leverage,
        entryPrice: avgEntry,
        amount: totalAmount,
        stopLoss: t1.stopLoss,
        takeProfits: newTPs,
        status: 'OPEN',
        source: 'ENTRY_ANALYZER',
        notes: `Merged from #${trade1Id} ($${t1.entryPrice}) + #${trade2Id} ($${t2.entryPrice}) → avg $${avgEntry}`,
      },
    })

    console.log(`[EntryAnalyzer] Merged trades #${trade1Id}+#${trade2Id} → #${merged.id} (avg entry: $${avgEntry})`)
    res.json(merged)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/scanner/coins — get available coins list (selected for scanning)
router.get('/coins', async (_req, res) => {
  try {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    const selected = (config?.scannerCoins as string[]) || []
    // If no custom selection, return default SCAN_COINS
    res.json({ coins: selected.length > 0 ? selected : SCAN_COINS })
  } catch {
    res.json({ coins: SCAN_COINS })
  }
})

// GET /api/scanner/coin-list — get all Bybit pairs + current selection
router.get('/coin-list', async (_req, res) => {
  try {
    // Fetch all available linear perpetual pairs from Bybit
    const bybitRes = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000')
    const bybitData = await bybitRes.json() as { result: { list: { symbol: string; status: string; quoteCoin: string }[] } }
    const allCoins = bybitData.result.list
      .filter((s: any) => s.status === 'Trading' && s.quoteCoin === 'USDT')
      .map((s: any) => s.symbol.replace('USDT', ''))
      .sort()

    // Get current selection from DB
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    const selected = (config?.scannerCoins as string[]) || []

    res.json({ available: allCoins, selected })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/scanner/coin-list — save selected coins
router.put('/coin-list', async (req, res) => {
  try {
    const { coins } = req.body as { coins: string[] }
    if (!Array.isArray(coins)) return res.status(400).json({ error: 'coins array required' })

    await prisma.botConfig.upsert({
      where: { id: 1 },
      create: { scannerCoins: coins },
      update: { scannerCoins: coins },
    })

    res.json({ saved: coins.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router