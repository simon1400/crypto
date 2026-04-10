import { Request, Response, NextFunction, RequestHandler } from 'express'
import { BudgetError } from '../services/budget'

/**
 * Общий хелпер: BudgetError → 400 ответ с детальной раскладкой.
 * Возвращает true если ошибка была обработана — caller должен вернуть.
 *
 * Пример:
 *   try { await assertBudget(...) }
 *   catch (err) {
 *     if (handleBudgetError(err, res)) return
 *     throw err
 *   }
 */
export function handleBudgetError(err: unknown, res: Response): boolean {
  if (err instanceof BudgetError) {
    res.status(400).json({
      error: err.message,
      budget: { balance: err.balance, used: err.usedMargin, requested: err.requested },
    })
    return true
  }
  return false
}

/**
 * Обёртка для async route-хендлеров: ловит необработанные исключения
 * и отправляет 500 с сообщением. Убирает повторяющийся try/catch во всех роутах.
 *
 * Использование:
 *   router.get('/foo', asyncHandler(async (req, res) => {
 *     const data = await prisma.foo.findMany()
 *     res.json(data)
 *   }))
 *
 * Опциональный logPrefix добавляется в console.error для навигации по логам.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
  logPrefix?: string,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err: any) => {
      // BudgetError обрабатываем отдельно
      if (handleBudgetError(err, res)) return
      const prefix = logPrefix ? `[${logPrefix}] ` : ''
      console.error(`${prefix}${req.method} ${req.path} error:`, err?.message || err)
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'Internal error' })
      }
    })
  }
}

/**
 * Стандартный парсер pagination из query: { page, limit, skip }.
 * page = max(1, ?page || 1)
 * limit = min(maxLimit, max(1, ?limit || defaultLimit))
 */
export function parsePagination(
  req: Request,
  defaultLimit = 20,
  maxLimit = 100,
): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit))
  return { page, limit, skip: (page - 1) * limit }
}

/**
 * Парсит :id из req.params. При невалидном значении сам отправляет 400 и возвращает null.
 * Caller должен проверить на null и вернуть управление.
 *
 * Пример:
 *   const id = parseIdParam(req, res)
 *   if (id == null) return
 */
export function parseIdParam(req: Request, res: Response, paramName = 'id'): number | null {
  const raw = req.params[paramName] as string
  const id = parseInt(raw, 10)
  if (isNaN(id)) {
    res.status(400).json({ error: `Invalid ${paramName}` })
    return null
  }
  return id
}
