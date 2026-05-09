import { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Обёртка для async route-хендлеров: ловит необработанные исключения
 * и отправляет 500 с сообщением.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
  logPrefix?: string,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err: any) => {
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
 * Парсит :id из req.params.
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
