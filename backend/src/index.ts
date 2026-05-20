import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import { loginRateLimit } from './middleware/rateLimit'
import marketRouter from './routes/market'
import settingsRouter from './routes/settings'
import { prisma } from './db/prisma'
import klinesRouter from './routes/klines'
import breakoutRouter from './routes/breakout'
import breakoutPaperRouter from './routes/breakoutPaperA'
import breakoutPaperBRouter from './routes/breakoutPaperB'
import breakoutPaperCRouter from './routes/breakoutPaperC'
import breakoutLiveCRouter from './routes/breakoutLiveC'
import { startBreakoutLiveTraderC, stopBreakoutLiveTraderC } from './services/dailyBreakoutLiveC'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Login endpoint — no auth required
app.post('/api/login', loginRateLimit, (req, res) => {
  const { password } = req.body as { password?: string }
  if (password === process.env.APP_PASSWORD) {
    res.json({ token: process.env.API_SECRET })
  } else {
    res.status(401).json({ error: 'Wrong password' })
  }
})

app.use('/api', authMiddleware)

app.use('/api/market', marketRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/klines', klinesRouter)
app.use('/api/breakout', breakoutRouter)
app.use('/api/breakout-paper', breakoutPaperRouter)
app.use('/api/breakout-paper-b', breakoutPaperBRouter)
app.use('/api/breakout-paper-c', breakoutPaperCRouter)
app.use('/api/breakout-live-c', breakoutLiveCRouter)

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // === Daily Breakout — only LIVE C runs now (2026-05-20 decision) ===
  // Paper A/B/C, signal scanner, ws tracker, EOD summary and limit trader are
  // all stopped — LIVE C is the only active path. Their REST endpoints
  // (/api/breakout-paper*) stay registered so the historical DB is still
  // queryable, but no new paper trades are opened.
  //
  // Connects to Binance + user-data WS to stream order/account events. Trading
  // is gated by BreakoutLiveConfigC.enabled (toggled from UI). If creds aren't
  // configured yet, start() is a no-op — restart triggered when /settings saves
  // new keys.
  startBreakoutLiveTraderC().catch((e) => console.error('[BreakoutLiveC] start failed:', e.message))
})

async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`)

  server.close()

  stopBreakoutLiveTraderC()

  await prisma.$disconnect()

  console.log('[Shutdown] Cleanup complete, exiting.')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
