import { Router } from 'express'
import { fetchMarketOverview } from '../services/market'
import { asyncHandler } from './_helpers'

const router = Router()

router.get('/', asyncHandler(async (_req, res) => {
  const data = await fetchMarketOverview()
  res.json(data)
}, 'Market'))

export default router
