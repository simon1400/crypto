import { Router } from 'express'
import { getPostTp1Analytics, getSetupPerformance, getEntryModelComparison } from '../../services/tradeAnalytics'
import { asyncHandler } from '../_helpers'

const router = Router()

// GET /api/scanner/analytics/post-tp1 — post-TP1 management analysis
router.get('/analytics/post-tp1', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const source = req.query.source as string | undefined
  const stats = await getPostTp1Analytics(days, source)
  res.json(stats)
}, 'Analytics'))

// GET /api/scanner/analytics/setup-performance — breakdown by setup category
router.get('/analytics/setup-performance', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const stats = await getSetupPerformance(days)
  res.json(stats)
}, 'Analytics'))

// GET /api/scanner/analytics/entry-models — compare entry model performance
router.get('/analytics/entry-models', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const stats = await getEntryModelComparison(days)
  res.json(stats)
}, 'Analytics'))

export default router
