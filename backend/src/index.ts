import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import { loginRateLimit } from './middleware/rateLimit'
import marketRouter from './routes/market'
import signalsRouter from './routes/signals'
import tradingRouter from './routes/trading'
import { trackActiveSignals } from './services/signalTracker'
import settingsRouter from './routes/settings'
import { startWsListener, stopWsListener } from './trading/wsListener'
import { startTtlChecker, stopTtlChecker } from './trading/tradingService'
import { reconcilePositions } from './trading/positionManager'
import { startAutoListener, stopAutoListener } from './trading/autoListener'
import { seedTickerMappings } from './trading/tickerMapper'
import { stopHealthCheck } from './services/telegram'
import { prisma } from './db/prisma'
import klinesRouter from './routes/klines'
import breakoutRouter from './routes/breakout'
import breakoutPaperRouter from './routes/breakoutPaper'
import { startBreakoutLiveScanner, stopBreakoutLiveScanner } from './services/dailyBreakoutLiveScanner'
import { startBreakoutPaperTrader, stopBreakoutPaperTrader } from './services/dailyBreakoutPaperTrader'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors())
app.use(express.json())

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
app.use('/api/signals', signalsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/trading', tradingRouter)
app.use('/api/klines', klinesRouter)
app.use('/api/breakout', breakoutRouter)
app.use('/api/breakout-paper', breakoutPaperRouter)

// Module-level interval references for graceful shutdown
let signalTrackerInterval: NodeJS.Timeout
let reconcileInterval: NodeJS.Timeout
let ttlInterval: NodeJS.Timeout

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // Track Telegram signal prices every hour
  signalTrackerInterval = setInterval(() => {
    trackActiveSignals().catch(err => console.error('[SignalTracker] Interval error:', err))
  }, 60 * 60 * 1000)

  // Start WebSocket listener for real-time Bybit events
  startWsListener().catch(err =>
    console.error('[WsListener] Failed to start:', err.message)
  )

  // Start TTL checker for expired pending orders (every 60s)
  ttlInterval = startTtlChecker()

  // Reconcile positions with Bybit every 60 seconds via REST polling
  reconcileInterval = setInterval(() => {
    reconcilePositions().catch(err => console.error('[PositionManager] Reconcile error:', err))
  }, 60 * 1000)

  // Start auto listener if tradingMode is "auto"
  prisma.botConfig.findUnique({ where: { id: 1 } }).then(config => {
    if (config?.tradingMode === 'auto') {
      startAutoListener().catch(err =>
        console.error('[AutoListener] Failed to start on boot:', err.message)
      )
    }
  }).catch(() => {
    // BotConfig may not exist yet — skip
  })

  // Seed ticker mappings (PEPE, BONK, FLOKI, PLAY)
  seedTickerMappings().catch(err => console.error('[Startup] Seed ticker mappings error:', err.message))

  // === Daily Breakout strategy live scanner & tracker ===
  // Optimal config (backtest 365d): 3h range, vol×2.0, 11 monetах,
  // full trailing TP1→BE/TP2→TP1, splits 50/30/20.
  // TRAIN R/tr +0.16 (n=667), TEST R/tr +0.34 (n=358) at 0.05% slippage.
  // Заменил Levels v2 (TEST R/tr -0.06) после strategy comparison backtest 2026-05-07.
  startBreakoutLiveScanner()
  startBreakoutPaperTrader()
})

async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`)

  // 1. Stop accepting new connections
  server.close()

  // 2. Clear all intervals
  clearInterval(signalTrackerInterval)
  clearInterval(reconcileInterval)
  stopTtlChecker(ttlInterval)
  stopBreakoutLiveScanner()
  stopBreakoutPaperTrader()
  stopHealthCheck()

  // 3. Close WebSocket connections
  stopWsListener()
  await stopAutoListener().catch(() => {})

  // 4. Disconnect database
  await prisma.$disconnect()

  console.log('[Shutdown] Cleanup complete, exiting.')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
