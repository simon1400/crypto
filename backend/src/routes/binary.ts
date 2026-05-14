import { Router } from 'express'
import { asyncHandler } from './_helpers'
import { getForexSnapshot, markSignalOutcome, UserOutcome } from '../services/forexHelperService'

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

export default router
