import { Router } from 'express'
import scanRouter from './scan'
import signalsRouter from './signals'
import entryRouter from './entry'
import coinsRouter from './coins'

/**
 * Aggregator для всех /api/scanner/* роутов.
 * Разделение по функциональным группам:
 * - scan      — запуск сканера, статус, прогресс, expire
 * - signals   — CRUD сигналов + действия (take, close, sl-hit)
 * - entry     — entry analyzer (лимитные входы + merge)
 * - coins     — список монет для сканирования
 *
 * Все паттерны путей неизменны — mount без префикса.
 */
const router = Router()

router.use(scanRouter)
router.use(signalsRouter)
router.use(entryRouter)
router.use(coinsRouter)

export default router
