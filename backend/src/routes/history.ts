import { Router, Request, Response } from 'express'
import { prisma } from '../db/prisma'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10))
  const skip = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.analysis.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.analysis.count(),
  ])

  res.json({
    data,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  })
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }

  const analysis = await prisma.analysis.findUnique({ where: { id } })
  if (!analysis) {
    res.status(404).json({ error: 'Not found' })
    return
  }

  res.json(analysis)
})

export default router
