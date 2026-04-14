import { Router } from 'express'
import { runScan, isScannerRunning, SCAN_COINS, expireOldSignals } from '../../scanner/coinScanner'
import { scannerProgress } from '../../scanner/scannerProgress'
import { prisma } from '../../db/prisma'
import { asyncHandler } from '../_helpers'

const router = Router()

// POST /api/scanner/scan — trigger manual scan
router.post('/scan', asyncHandler(async (req, res) => {
  if (isScannerRunning()) {
    res.status(409).json({ error: 'Scanner already running' })
    return
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
        // === New 3-layer scoring ===
        setup_category: r.setup_category ?? null,
        execution_type: r.execution_type ?? null,
        setup_score: r.enriched?.setup_score ?? null,
        setup_score_breakdown: r.setup_score_breakdown ?? null,
        entry_trigger_result: r.entry_trigger_result ?? null,
        hard_filter_result: r.hard_filter_result ?? null,
        signal_context: r.signal_context ?? null,
        signal_explanation: r.signal_explanation ?? null,
        limit_entry_plan: r.limit_entry_plan ?? null,
        market_entry_plan: r.market_entry_plan ?? null,
        risk_profile: r.risk_profile ?? null,
        candidates: r.enriched?.limit_plan?.candidates ?? r.limit_entry_plan?.candidates ?? null,
        exchange: r.exchange ?? 'bybit',
      })),
  })
}, 'Scanner'))

// GET /api/scanner/status — check if scanner is running
router.get('/status', (_req, res) => {
  res.json({ running: isScannerRunning() })
})

// GET /api/scanner/progress — current snapshot (для polling fallback)
router.get('/progress', (_req, res) => {
  res.json(scannerProgress.getState())
})

// GET /api/scanner/progress-stream — Server-Sent Events live updates
router.get('/progress-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // отключаем nginx буферизацию
  res.flushHeaders?.()

  const send = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  send(scannerProgress.getState())

  const listener = (state: any) => send(state)
  scannerProgress.on('update', listener)

  // Heartbeat каждые 15 сек чтобы соединение не закрылось
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    scannerProgress.off('update', listener)
    res.end()
  })
})

// POST /api/scanner/cancel — stop running scan
router.post('/cancel', (_req, res) => {
  if (!isScannerRunning()) {
    res.status(400).json({ error: 'Scanner is not running' })
    return
  }
  scannerProgress.abort()
  res.json({ ok: true })
})

// POST /api/scanner/expire — manually expire old signals
router.post('/expire', asyncHandler(async (_req, res) => {
  const count = await expireOldSignals()
  res.json({ expired: count })
}, 'Scanner'))

export default router
