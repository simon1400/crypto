import { Router } from 'express'
import queriesRouter from './queries'
import mutationsRouter from './mutations'
import closingRouter from './closing'

/**
 * Aggregator для всех /api/trades/* роутов.
 *
 * Важен порядок монтирования:
 * - closing первым, чтобы /:id/close и /:id/sl-hit не перекрылись с GET /:id
 * - mutations следом (POST /, PUT /:id, DELETE /:id)
 * - queries последним (GET /, /live, /stats, /budget, /:id) — GET /:id самый общий
 *
 * На практике Express роутит строго по методу и пути, так что пересечений нет,
 * но держим очевидный порядок от частного к общему.
 */
const router = Router()

router.use(closingRouter)
router.use(mutationsRouter)
router.use(queriesRouter)

export default router
