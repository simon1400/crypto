import { Router } from 'express'
import { prisma } from '../db/prisma'
import { asyncHandler, parseIdParam, parsePagination } from './_helpers'
import {
  FOREX_INSTRUMENTS,
  getForexScanState,
  runForexScan,
  expireForexSignals,
} from '../scannerForex'
import { computePortionPnlFromEntry } from '../services/tradeClose'

const router = Router()

// GET /api/scanner-forex/status — current scanner state
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    res.json({
      state: getForexScanState(),
      instruments: FOREX_INSTRUMENTS,
      enabled: config?.forexScanEnabled ?? false,
      minScore: config?.forexScanMinScore ?? 70,
      lastScanAt: config?.forexLastScanAt ?? null,
    })
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/run — manual trigger (ignores weekend gate)
router.post(
  '/run',
  asyncHandler(async (_req, res) => {
    const result = await runForexScan({ force: true })
    res.json(result)
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/settings — update enabled + minScore
router.post(
  '/settings',
  asyncHandler(async (req, res) => {
    const { enabled, minScore } = req.body as { enabled?: boolean; minScore?: number }

    const data: any = {}
    if (typeof enabled === 'boolean') data.forexScanEnabled = enabled
    if (typeof minScore === 'number' && minScore >= 0 && minScore <= 100) {
      data.forexScanMinScore = Math.floor(minScore)
    }

    const updated = await prisma.botConfig.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    })

    res.json({
      enabled: updated.forexScanEnabled,
      minScore: updated.forexScanMinScore,
    })
  }, 'ForexScanner'),
)

// GET /api/scanner-forex/signals — list forex signals with pagination
router.get(
  '/signals',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req, 20, 100)
    const status = req.query.status as string | undefined
    const coin = req.query.coin as string | undefined

    const where: any = { market: 'FOREX' }
    if (status) {
      if (status.includes(',')) where.status = { in: status.split(',') }
      else where.status = status
    }
    if (coin) where.coin = { contains: coin.toUpperCase() }

    const [data, total] = await Promise.all([
      prisma.generatedSignal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
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
  }, 'ForexScanner'),
)

// GET /api/scanner-forex/signals/:id — single signal
router.get(
  '/signals/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }
    res.json(signal)
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/signals/:id/take-trade — take signal AND create a ForexTrade record
router.post(
  '/signals/:id/take-trade',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { lots, entryPrice, stopLoss, takeProfits, notes } = req.body as {
      lots: number
      entryPrice?: number // optional override
      stopLoss?: number
      takeProfits?: { price: number; percent: number; rr?: number }[]
      notes?: string
    }

    if (!lots || lots <= 0) {
      res.status(400).json({ error: 'lots required (must be > 0)' })
      return
    }

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }
    if (signal.status !== 'NEW') {
      res.status(400).json({ error: 'Signal already taken or closed' })
      return
    }

    // Build TP array from signal if not provided
    const sigTps = (signal.takeProfits as any[]) || []
    const tpPercents = sigTps.length <= 1
      ? [100]
      : sigTps.length === 2
      ? [50, 50]
      : sigTps.length === 3
      ? [40, 30, 30]
      : [30, 25, 25, 20]
    const finalTps =
      takeProfits ??
      sigTps.map((tp: any, i: number) => ({
        price: tp.price,
        percent: tpPercents[i] ?? Math.floor(100 / sigTps.length),
        rr: tp.rr,
      }))

    const finalEntry = entryPrice ?? signal.entry
    const finalSl = stopLoss ?? signal.stopLoss

    const trade = await prisma.forexTrade.create({
      data: {
        instrument: signal.coin,
        type: signal.type,
        lots,
        entryPrice: finalEntry,
        stopLoss: finalSl,
        initialStop: finalSl,
        currentStop: finalSl,
        takeProfits: finalTps as any,
        status: 'OPEN',
        source: 'SCANNER',
        signalId: signal.id,
        session: signal.session,
        openedAt: new Date(),
        notes: notes || `Scanner forex #${signal.id} | Score: ${signal.score}`,
      },
    })

    await prisma.generatedSignal.update({
      where: { id },
      data: { status: 'TAKEN', amount: lots, takenAt: new Date() },
    })

    console.log(`[ForexScanner] Signal #${id} → Trade #${trade.id} (${trade.instrument} ${trade.type} ${lots} lots @ ${finalEntry})`)
    res.json({ trade, signal: { id, status: 'TAKEN' } })
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/signals/:id/take — mark as TAKEN (no Trade record, MT5 executed manually)
router.post(
  '/signals/:id/take',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { lots } = req.body as { lots?: number }

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }
    if (signal.status !== 'NEW') {
      res.status(400).json({ error: 'Signal already taken or closed' })
      return
    }

    const updated = await prisma.generatedSignal.update({
      where: { id },
      data: {
        status: 'TAKEN',
        amount: lots ?? 0, // reuse `amount` field to store lot size for info
        takenAt: new Date(),
      },
    })
    res.json(updated)
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/signals/:id/close — record close at price/percent
router.post(
  '/signals/:id/close',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const { price, percent } = req.body as { price: number; percent: number }
    if (!price || !percent) {
      res.status(400).json({ error: 'price and percent required' })
      return
    }

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }
    if (['CLOSED', 'SL_HIT', 'EXPIRED', 'NEW'].includes(signal.status)) {
      res.status(400).json({ error: 'Signal cannot be closed in current status' })
      return
    }

    const closePrice = Number(price)
    const closePct = Number(percent)
    const newClosedPct = Math.min(100, signal.closedPct + closePct)

    const { pnlPercent, pnlUsdt } = computePortionPnlFromEntry(signal, closePrice, closePct)
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

    const updated = await prisma.generatedSignal.update({
      where: { id },
      data: {
        closes,
        closedPct: newClosedPct,
        realizedPnl: newRealizedPnl,
        status: isFull ? 'CLOSED' : 'PARTIALLY_CLOSED',
        closedAt: isFull ? new Date() : null,
      },
    })
    res.json(updated)
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/signals/:id/sl-hit — stop loss hit
router.post(
  '/signals/:id/sl-hit',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }

    const remainingPct = 100 - signal.closedPct
    const { pnlPercent, pnlUsdt } = computePortionPnlFromEntry(signal, signal.stopLoss, remainingPct)

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
      where: { id },
      data: {
        closes,
        closedPct: 100,
        realizedPnl: Math.round((signal.realizedPnl + pnlUsdt) * 100) / 100,
        status: 'SL_HIT',
        closedAt: new Date(),
      },
    })
    res.json(updated)
  }, 'ForexScanner'),
)

// DELETE /api/scanner-forex/signals/:id — delete a signal
router.delete(
  '/signals/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req, res)
    if (id == null) return

    const signal = await prisma.generatedSignal.findUnique({ where: { id } })
    if (!signal || signal.market !== 'FOREX') {
      res.status(404).json({ error: 'Forex signal not found' })
      return
    }

    await prisma.generatedSignal.delete({ where: { id } })
    res.json({ ok: true })
  }, 'ForexScanner'),
)

// POST /api/scanner-forex/expire — manually expire stale signals
router.post(
  '/expire',
  asyncHandler(async (_req, res) => {
    await expireForexSignals()
    res.json({ ok: true })
  }, 'ForexScanner'),
)

export default router
