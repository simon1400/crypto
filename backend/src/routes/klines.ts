import { Router, Request, Response } from 'express'
import { fetchKlines, VALID_INTERVALS } from '../services/klines'

const router = Router()

// GET /api/klines?symbol=BTCUSDT&interval=1h&count=500
router.get('/', async (req: Request, res: Response) => {
  try {
    const symbol = (req.query.symbol as string || '').toUpperCase()
    const interval = req.query.interval as string || '1h'
    const count = Math.min(Number(req.query.count) || 500, 5000)

    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' })
    }

    if (!VALID_INTERVALS.includes(interval)) {
      return res.status(400).json({ error: `Invalid interval. Valid: ${VALID_INTERVALS.join(', ')}` })
    }

    const data = await fetchKlines(symbol, interval, count)
    res.json({ symbol, interval, count: data.length, data })
  } catch (err: any) {
    console.error('[Klines] Route error:', err.message)
    res.status(500).json({ error: err.message || 'Failed to fetch klines' })
  }
})

export default router
