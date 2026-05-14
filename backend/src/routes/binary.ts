import { Router } from 'express'
import { asyncHandler } from './_helpers'
import { getForexSnapshot, markSignalOutcome, UserOutcome } from '../services/forexHelperService'
import { getOtcSnapshot, ingestTicks, markOtcSignalOutcome, IncomingTick } from '../services/otcHelperService'

const router = Router()

router.get('/forex', asyncHandler(async (_req, res) => {
  res.json(getForexSnapshot())
}, 'ForexHelper'))

router.post('/forex/mark', asyncHandler(async (req, res) => {
  const { id, outcome } = req.body as { id?: string; outcome?: UserOutcome }
  if (!id) {
    res.status(400).json({ error: 'id required' })
    return
  }
  if (outcome != null && outcome !== 'WIN' && outcome !== 'LOSS' && outcome !== 'RECOVERY' && outcome !== 'SKIPPED') {
    res.status(400).json({ error: 'invalid outcome' })
    return
  }
  const result = markSignalOutcome(id, outcome ?? null)
  if (!result.ok) {
    res.status(404).json({ error: result.error })
    return
  }
  res.json({ ok: true, signal: result.signal })
}, 'ForexHelperMark'))

// ============ OTC ============

router.get('/otc', asyncHandler(async (_req, res) => {
  res.json(getOtcSnapshot())
}, 'OtcHelper'))

router.post('/otc-ingest', asyncHandler(async (req, res) => {
  const { ticks } = req.body as { ticks?: IncomingTick[] }
  if (!Array.isArray(ticks)) {
    res.status(400).json({ error: 'ticks array required' })
    return
  }
  const result = ingestTicks(ticks)
  res.json({ ok: true, ...result })
}, 'OtcIngest'))

router.post('/otc/mark', asyncHandler(async (req, res) => {
  const { id, outcome } = req.body as { id?: string; outcome?: UserOutcome }
  if (!id) {
    res.status(400).json({ error: 'id required' })
    return
  }
  if (outcome != null && outcome !== 'WIN' && outcome !== 'LOSS' && outcome !== 'RECOVERY' && outcome !== 'SKIPPED') {
    res.status(400).json({ error: 'invalid outcome' })
    return
  }
  const result = markOtcSignalOutcome(id, outcome ?? null)
  if (!result.ok) {
    res.status(404).json({ error: result.error })
    return
  }
  res.json({ ok: true, signal: result.signal })
}, 'OtcHelperMark'))

export default router
