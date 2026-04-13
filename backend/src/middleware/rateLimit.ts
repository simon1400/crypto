import { Request, Response, NextFunction } from 'express'

interface RateEntry {
  count: number
  resetAt: number
}

const attempts = new Map<string, RateEntry>()

const WINDOW_MS = 60_000  // 1 minute
const MAX_ATTEMPTS = 5

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip)
  }
}, 5 * 60_000)

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const entry = attempts.get(ip)

  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    next()
    return
  }

  if (entry.count >= MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many login attempts. Try again in 1 minute.' })
    return
  }

  entry.count++
  next()
}
