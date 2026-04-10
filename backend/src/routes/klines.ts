import { Router } from 'express'
import { fetchKlines, VALID_INTERVALS } from '../services/klines'
import { asyncHandler } from './_helpers'

const router = Router()

// GET /api/klines?symbol=BTCUSDT&interval=1h&count=500
router.get('/', asyncHandler(async (req, res) => {
  const symbol = (req.query.symbol as string || '').toUpperCase()
  const interval = req.query.interval as string || '1h'
  const count = Math.min(Number(req.query.count) || 500, 5000)

  if (!symbol) {
    res.status(400).json({ error: 'symbol is required' })
    return
  }
  if (!VALID_INTERVALS.includes(interval)) {
    res.status(400).json({ error: `Invalid interval. Valid: ${VALID_INTERVALS.join(', ')}` })
    return
  }

  const data = await fetchKlines(symbol, interval, count)
  res.json({ symbol, interval, count: data.length, data })
}, 'Klines'))

export default router
