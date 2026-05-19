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
import { startBreakoutLiveScanner, stopBreakoutLiveScanner } from './services/dailyBreakoutLiveScanner'
import { startBreakoutPaperTrader, stopBreakoutPaperTrader, startBreakoutEodSummary, stopBreakoutEodSummary } from './services/dailyBreakoutPaperTrader'
import { startBreakoutLimitTraderC, stopBreakoutLimitTraderC } from './services/dailyBreakoutLimitTrader'
import { startBreakoutLiveTraderC, stopBreakoutLiveTraderC } from './services/dailyBreakoutLiveTraderC'
import { startBreakoutWsTracker, stopBreakoutWsTracker } from './services/breakoutWsTracker'

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

  // === Daily Breakout strategy live scanner & trackers ===
  startBreakoutLiveScanner()
  startBreakoutPaperTrader('A')
  startBreakoutPaperTrader('B')
  // Variant C — limit-on-rangeEdge experimental copy. Reads same signal stream
  // as A/B; uses limit fills instead of market entry. See dailyBreakoutLimitTrader.ts.
  // After PENDING_LIMIT fills → status=OPEN → tracking handled by paper trader 'C'
  // through the shared trackOnePaper logic.
  startBreakoutPaperTrader('C')
  startBreakoutLimitTraderC()
  startBreakoutWsTracker()
  startBreakoutEodSummary()

  // === Variant C LIVE (Binance Futures real-money twin of paper C) ===
  // Connects to Binance + user-data WS to stream order/account events. Trading
  // is gated by BreakoutLiveConfigC.enabled (toggled from UI). If creds aren't
  // configured yet, start() is a no-op — restart triggered when /settings saves
  // new keys.
  startBreakoutLiveTraderC().catch((e) => console.error('[BreakoutLiveC] start failed:', e.message))
})

async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`)

  server.close()

  stopBreakoutLiveScanner()
  stopBreakoutPaperTrader('A')
  stopBreakoutPaperTrader('B')
  stopBreakoutPaperTrader('C')
  stopBreakoutLimitTraderC()
  stopBreakoutLiveTraderC()
  stopBreakoutWsTracker()
  stopBreakoutEodSummary()

  await prisma.$disconnect()

  console.log('[Shutdown] Cleanup complete, exiting.')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
