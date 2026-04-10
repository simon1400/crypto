import { Router } from 'express'
import { prisma } from '../../db/prisma'
import { getLivePositions } from '../../services/positionsLive'
import { asyncHandler, parsePagination, parseIdParam } from '../_helpers'

const router = Router()

/**
 * GET /api/trading/positions
 * List positions with optional status filter and pagination.
 */
router.get('/positions', asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req)
  const status = req.query.status as string | undefined
  const where = status ? { status } : {}

  const [data, total] = await Promise.all([
    prisma.position.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { signal: true },
    }),
    prisma.position.count({ where }),
  ])

  res.json({ data, total, page, totalPages: Math.ceil(total / limit) })
}, 'Trading'))

/**
 * GET /api/trading/positions/live
 * Get open positions enriched with unrealisedPnl from Bybit.
 * IMPORTANT: Must be defined before /positions/:id to avoid Express matching "live" as :id.
 */
router.get('/positions/live', asyncHandler(async (_req, res) => {
  const data = await getLivePositions()
  res.json({ data })
}, 'Trading'))

/**
 * GET /api/trading/positions/:id
 * Get a single position with its order logs.
 */
router.get('/positions/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const position = await prisma.position.findUnique({
    where: { id },
    include: { orderLogs: { orderBy: { createdAt: 'desc' } }, signal: true },
  })

  if (!position) {
    res.status(404).json({ error: 'Position not found' })
    return
  }

  res.json(position)
}, 'Trading'))

export default router
