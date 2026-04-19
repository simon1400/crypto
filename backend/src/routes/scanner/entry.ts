import { Router } from 'express'
import { analyzeEntries, isEntryAnalyzerRunning } from '../../scanner/entryAnalyzer'
import { prisma } from '../../db/prisma'
import { assertBudget } from '../../services/budget'
import { adjustVirtualBalance } from '../../services/virtualBalance'
import { OrderType } from '../../services/fees'
import { asyncHandler, handleBudgetError, parseIdParam } from '../_helpers'
import { serializeEntryPoint, parseScoreFromNotes } from './helpers'

const router = Router()

// POST /api/scanner/analyze-entry — analyze limit order entry points
router.post('/analyze-entry', asyncHandler(async (req, res) => {
  if (isEntryAnalyzerRunning()) {
    res.status(409).json({ error: 'Entry analyzer already running' })
    return
  }

  const { coins } = req.body as { coins: string[] }
  if (!coins || !Array.isArray(coins) || coins.length === 0) {
    res.status(400).json({ error: 'coins required (array of 1-5 tickers)' })
    return
  }
  if (coins.length > 5) {
    res.status(400).json({ error: 'Maximum 5 coins per analysis' })
    return
  }

  const { results, errors } = await analyzeEntries(coins)

    // Save results to DB as GeneratedSignals + build response in single pass
    const savedIds: Record<string, number> = {}
    const responseResults = []

    for (const r of results) {
      const entry1 = serializeEntryPoint(r.entry1)
      const entry2 = serializeEntryPoint(r.entry2)

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
            entry1,
            entry2,
            avgEntry: r.avgEntry,
            slPercent: r.slPercent,
            riskReward: r.riskReward,
            currentPrice: r.currentPrice,
            regime: r.regime,
            reasons: r.reasons,
            funding: r.funding ? { rate: r.funding.fundingRate } : null,
            oi: r.oi ? { value: r.oi.openInterest } : null,
          })),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
        },
      })
      savedIds[r.coin] = saved.id

      responseResults.push({
        savedId: saved.id,
        coin: r.coin,
        type: r.type,
        strategy: r.strategy,
        score: r.score,
        currentPrice: r.currentPrice,
        entry1,
        entry2,
        avgEntry: r.avgEntry,
        stopLoss: r.stopLoss,
        slPercent: r.slPercent,
        takeProfits: r.takeProfits,
        leverage: r.leverage,
        positionPct: r.positionPct,
        riskReward: r.riskReward,
        reasons: r.reasons,
        regime: r.regime,
        funding: r.funding ? { rate: r.funding.fundingRate } : null,
        oi: r.oi ? { value: r.oi.openInterest } : null,
      })
    }

  res.json({ total: results.length, errors, results: responseResults })
}, 'EntryAnalyzer'))

// GET /api/scanner/entry-signals — get saved entry analyses
router.get('/entry-signals', asyncHandler(async (_req, res) => {
  const signals = await prisma.generatedSignal.findMany({
    where: { strategy: 'entry_analysis' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json(signals)
}, 'EntryAnalyzer'))

// DELETE /api/scanner/entry-signals/:id — delete a saved entry analysis
router.delete('/entry-signals/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const signal = await prisma.generatedSignal.findUnique({ where: { id } })
  if (!signal || signal.strategy !== 'entry_analysis') {
    res.status(404).json({ error: 'Entry signal not found' })
    return
  }
  await prisma.generatedSignal.delete({ where: { id } })
  res.json({ ok: true })
}, 'EntryAnalyzer'))

// POST /api/scanner/take-entry — take entry analysis as 2 trades
router.post('/take-entry', asyncHandler(async (req, res) => {
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
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const orderTypeNorm: OrderType = orderType === 'limit' ? 'limit' : 'market'

  // Бюджетный гард: amount — общая маржа на обе entry-сделки + entry fee на полный объём
  let entryFeeTotal = 0
  try {
    const result = await assertBudget(Number(amount), Number(leverage), orderTypeNorm)
    entryFeeTotal = result.entryFee
  } catch (err) {
    if (handleBudgetError(err, res)) return
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

  await adjustVirtualBalance(-entryFeeTotal, `entry fee ${symbol} entry-analyzer ${orderTypeNorm}`)

  const baseTradeData = {
    coin: symbol,
    type,
    leverage,
    stopLoss,
    takeProfits,
    status: 'PENDING_ENTRY',
    source: 'ENTRY_ANALYZER',
    entryOrderType: orderTypeNorm,
  }

  const [trade1, trade2] = await Promise.all([
    prisma.trade.create({
      data: {
        ...baseTradeData,
        entryPrice: entry1,
        amount: amount1,
        fees: fee1,
        notes: `group:${groupId} | Entry 1 (основной)${scoreStr} | Entry 2: $${entry2}`,
      },
    }),
    prisma.trade.create({
      data: {
        ...baseTradeData,
        entryPrice: entry2,
        amount: amount2,
        fees: fee2,
        notes: `group:${groupId} | Entry 2 (усреднение)${scoreStr} | Entry 1: $${entry1}`,
      },
    }),
  ])

  // Mark saved signal as TAKEN
  if (signalId) {
    await prisma.generatedSignal.update({
      where: { id: signalId },
      data: { status: 'TAKEN', amount, takenAt: new Date() },
    }).catch(() => {})
  }

  console.log(`[EntryAnalyzer] Created trades #${trade1.id} + #${trade2.id} (${symbol} ${type}, group: ${groupId})`)
  res.json({ trade1, trade2, groupId })
}, 'EntryAnalyzer'))

// POST /api/scanner/merge-entry — merge 2 entry trades into 1 averaged trade
router.post('/merge-entry', asyncHandler(async (req, res) => {
  const { trade1Id, trade2Id } = req.body as { trade1Id: number; trade2Id: number }

  const [t1, t2] = await Promise.all([
    prisma.trade.findUnique({ where: { id: trade1Id } }),
    prisma.trade.findUnique({ where: { id: trade2Id } }),
  ])

  if (!t1 || !t2) {
    res.status(404).json({ error: 'Trades not found' })
    return
  }
  if (t1.source !== 'ENTRY_ANALYZER' || t2.source !== 'ENTRY_ANALYZER') {
    res.status(400).json({ error: 'Both trades must be ENTRY_ANALYZER source' })
    return
  }

  // Weighted average entry
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

  // Переносим Score из исходных notes
  const score = parseScoreFromNotes(t1.notes) ?? parseScoreFromNotes(t2.notes)
  const scorePart = score != null ? ` | Score: ${score}` : ''

  // Delete both old trades and create merged trade atomically
  const merged = await prisma.$transaction(async (tx) => {
    await tx.trade.deleteMany({ where: { id: { in: [trade1Id, trade2Id] } } })
    return tx.trade.create({
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
        entryOrderType: t1.entryOrderType,
        fees: t1.fees + t2.fees,
        fundingPaid: t1.fundingPaid + t2.fundingPaid,
        notes: `Merged from #${trade1Id} ($${t1.entryPrice}) + #${trade2Id} ($${t2.entryPrice}) → avg $${avgEntry}${scorePart}`,
      },
    })
  })

  console.log(`[EntryAnalyzer] Merged trades #${trade1Id}+#${trade2Id} → #${merged.id} (avg entry: $${avgEntry})`)
  res.json(merged)
}, 'EntryAnalyzer'))

export default router
