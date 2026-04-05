import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import marketRouter from './routes/market'
import signalsRouter from './routes/signals'
import tradesRouter from './routes/trades'
import tradingRouter from './routes/trading'
import { trackActiveSignals } from './services/signalTracker'
import scannerRouter from './routes/scanner'
import settingsRouter from './routes/settings'
import { expireOldSignals } from './scanner/coinScanner'
import { startWsListener } from './trading/wsListener'
import { startTtlChecker } from './trading/tradingService'
import { reconcilePositions } from './trading/positionManager'
import { startAutoListener } from './trading/autoListener'
import { seedTickerMappings } from './trading/tickerMapper'
import { prisma } from './db/prisma'
import klinesRouter from './routes/klines'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors())
app.use(express.json())

// Login endpoint — no auth required
app.post('/api/login', (req, res) => {
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
app.use('/api/trades', tradesRouter)
app.use('/api/scanner', scannerRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/trading', tradingRouter)
app.use('/api/klines', klinesRouter)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // Track signal prices every hour
  setInterval(() => {
    trackActiveSignals().catch(err => console.error('[SignalTracker] Interval error:', err))
  }, 60 * 60 * 1000)

  // Expire old scanner signals every 30 minutes
  setInterval(() => {
    expireOldSignals().catch(err => console.error('[Scanner] Expire error:', err))
  }, 30 * 60 * 1000)

  // Start WebSocket listener for real-time Bybit events
  startWsListener().catch(err =>
    console.error('[WsListener] Failed to start:', err.message)
  )

  // Start TTL checker for expired pending orders (every 60s)
  startTtlChecker()

  // Reconcile positions with Bybit every 60 seconds via REST polling
  setInterval(() => {
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

  // Auto-scan disabled — manual scan only via POST /api/scanner/scan
})
