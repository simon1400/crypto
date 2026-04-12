import { Router } from 'express'
import scanRouter from './scan'
import signalsRouter from './signals'
import entryRouter from './entry'
import coinsRouter from './coins'
import analyticsRouter from './analytics'

/**
 * Aggregator для всех /api/scanner/* роутов.
 * - scan       — запуск сканера, статус, прогресс, expire
 * - signals    — CRUD сигналов + действия (take, close, sl-hit)
 * - entry      — entry analyzer (лимитные входы + merge)
 * - coins      — список монет для сканирования
 * - analytics  — post-TP1 анализ, performance по категориям, сравнение моделей входа
 */
const router = Router()

router.use(scanRouter)
router.use(signalsRouter)
router.use(entryRouter)
router.use(coinsRouter)
router.use(analyticsRouter)

export default router
