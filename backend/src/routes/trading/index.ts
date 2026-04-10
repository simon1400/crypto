import { Router } from 'express'
import positionsRouter from './positions'
import actionsRouter from './positionActions'
import statsRouter from './stats'

/**
 * Aggregator для всех /api/trading/* роутов.
 *
 * Порядок монтирования важен:
 * - actions первым (POST ручки) — они строже по методу
 * - positions следом — содержит и /positions/live и /positions/:id
 * - stats — /stats, /stats/coins, /logs
 *
 * positions.ts внутри себя уже определяет /positions/live ДО /positions/:id
 * чтобы Express не принял "live" за :id параметр.
 */
const router = Router()

router.use(actionsRouter)
router.use(positionsRouter)
router.use(statsRouter)

export default router
