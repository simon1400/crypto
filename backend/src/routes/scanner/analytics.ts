import { Router } from 'express'
import { getPostTp1Analytics, getSetupPerformance, getEntryModelComparison } from '../../services/tradeAnalytics'
import { asyncHandler } from '../_helpers'

const router = Router()

function parseMinScore(req: any): number {
  const raw = req.query.minScore as string | undefined
  if (raw === undefined || raw === '') return 70
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return 70
  return Math.max(0, n)
}

// GET /api/scanner/analytics/post-tp1 — post-TP1 management analysis
router.get('/analytics/post-tp1', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const source = req.query.source as string | undefined
  const minScore = parseMinScore(req)
  const stats = await getPostTp1Analytics(days, source, minScore)
  res.json(stats)
}, 'Analytics'))

// GET /api/scanner/analytics/setup-performance — breakdown by setup category
router.get('/analytics/setup-performance', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const minScore = parseMinScore(req)
  const stats = await getSetupPerformance(days, minScore)
  res.json(stats)
}, 'Analytics'))

// GET /api/scanner/analytics/entry-models — compare entry model performance
router.get('/analytics/entry-models', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30
  const minScore = parseMinScore(req)
  const stats = await getEntryModelComparison(days, minScore)
  res.json(stats)
}, 'Analytics'))

export default router
