import { Router, Request, Response } from 'express'
import { fetchMarketOverview } from '../services/market'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  try {
    const data = await fetchMarketOverview()
    res.json(data)
  } catch (err) {
    console.error('Market overview error:', err)
    res.status(500).json({ error: 'Failed to fetch market data' })
  }
})

export default router
