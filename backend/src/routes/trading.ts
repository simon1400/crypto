import { Router, Request, Response } from 'express'
import { prisma } from '../db/prisma'
import { executeSignalOrder } from '../trading/tradingService'

const router = Router()

/**
 * POST /api/trading/execute
 * Execute a signal as a real Bybit order.
 *
 * Body: { signalId: number }
 * Returns 201 with position object on success.
 * Returns 409 if position already exists for signal.
 * Returns 400 for invalid input.
 * Returns 500 on other errors.
 */
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { signalId } = req.body

    if (!signalId || typeof signalId !== 'number') {
      return res.status(400).json({ error: 'signalId must be a number' })
    }

    const position = await executeSignalOrder(signalId)
    return res.status(201).json(position)
  } catch (err: any) {
    if (err.message?.includes('already exists')) {
      return res.status(409).json({ error: err.message })
    }
    console.error('[Trading] Execute error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/positions
 * List positions with optional status filter and pagination.
 *
 * Query: status?, page=1, limit=20
 */
router.get('/positions', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20))
    const status = req.query.status as string | undefined

    const where = status ? { status } : {}

    const [data, total] = await Promise.all([
      prisma.position.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { signal: true },
      }),
      prisma.position.count({ where }),
    ])

    return res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    console.error('[Trading] List positions error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/positions/:id
 * Get a single position with its order logs.
 */
router.get('/positions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid position ID' })
    }

    const position = await prisma.position.findUnique({
      where: { id },
      include: { orderLogs: { orderBy: { createdAt: 'desc' } }, signal: true },
    })

    if (!position) {
      return res.status(404).json({ error: 'Position not found' })
    }

    return res.json(position)
  } catch (err: any) {
    console.error('[Trading] Get position error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/trading/logs
 * List order logs with optional filters and pagination.
 *
 * Query: signalId?, positionId?, page=1, limit=50
 */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50))
    const signalId = req.query.signalId ? parseInt(req.query.signalId as string) : undefined
    const positionId = req.query.positionId ? parseInt(req.query.positionId as string) : undefined

    const where: Record<string, any> = {}
    if (signalId) where.signalId = signalId
    if (positionId) where.positionId = positionId

    const [data, total] = await Promise.all([
      prisma.orderLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.orderLog.count({ where }),
    ])

    return res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err: any) {
    console.error('[Trading] List logs error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

export default router
