import { Request, Response, NextFunction } from 'express'

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // EventSource не поддерживает кастомные заголовки, поэтому для SSE
  // разрешаем передавать секрет через ?token=...
  const secret = req.headers['x-api-secret'] || req.query.token
  if (secret !== process.env.API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
