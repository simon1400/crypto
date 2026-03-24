import { Request, Response, NextFunction } from 'express'

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-api-secret']
  if (secret !== process.env.API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
