import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import { loginRateLimit } from './middleware/rateLimit'
import marketRouter from './routes/market'
import signalsRouter from './routes/signals'
import tradesRouter from './routes/trades'
import tradingRouter from './routes/trading'
import { trackActiveSignals } from './services/signalTracker'
import scannerRouter from './routes/scanner'
import scannerForexRouter from './routes/scannerForex'
import forexTradesRouter from './routes/forexTrades'
import settingsRouter from './routes/settings'
import { expireOldSignals } from './scanner/coinScanner'
import { startWsListener, stopWsListener } from './trading/wsListener'
import { startTtlChecker, stopTtlChecker } from './trading/tradingService'
import { reconcilePositions } from './trading/positionManager'
import { startAutoListener, stopAutoListener } from './trading/autoListener'
import { seedTickerMappings } from './trading/tickerMapper'
import { trackScannerTrades } from './services/scannerTracker'
import { checkSignalIntegrity } from './services/integrityMonitor'
import { startFundingTracker, stopFundingTracker } from './services/fundingTracker'
import { startAutoScanner, stopAutoScanner } from './services/autoScanner'
import { startLiquidationListener, stopLiquidationListener } from './services/liquidations'
import { stopHealthCheck } from './services/telegram'
import { SCAN_COINS } from './scanner/coinScanner'
import { prisma } from './db/prisma'
import klinesRouter from './routes/klines'
import levelsRouter from './routes/levels'
import { startLevelsScanner, stopLevelsScanner } from './services/levelsLiveScanner'
import { startLevelsTracker, stopLevelsTracker } from './services/levelsTracker'

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
app.use('/api/trades', tradesRouter)
app.use('/api/scanner', scannerRouter)
app.use('/api/scanner-forex', scannerForexRouter)
app.use('/api/forex-trades', forexTradesRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/trading', tradingRouter)
app.use('/api/klines', klinesRouter)
app.use('/api/levels', levelsRouter)

// Module-level interval references for graceful shutdown
let signalTrackerInterval: NodeJS.Timeout
let expireSignalsInterval: NodeJS.Timeout
let scannerTrackerInterval: NodeJS.Timeout
let integrityInterval: NodeJS.Timeout
let reconcileInterval: NodeJS.Timeout
let ttlInterval: NodeJS.Timeout

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // Track signal prices every hour
  signalTrackerInterval = setInterval(() => {
    trackActiveSignals().catch(err => console.error('[SignalTracker] Interval error:', err))
  }, 60 * 60 * 1000)

  // Expire old scanner signals every 30 minutes
  expireSignalsInterval = setInterval(() => {
    expireOldSignals().catch(err => console.error('[Scanner] Expire error:', err))
  }, 30 * 60 * 1000)

  // Track scanner trades (entry fill, SL/TP) every 2 seconds
  scannerTrackerInterval = setInterval(() => {
    trackScannerTrades().catch(err => console.error('[ScannerTracker] Error:', err))
  }, 2000)

  // Integrity monitoring for pending limit signals (every 15 min)
  integrityInterval = setInterval(() => {
    checkSignalIntegrity().catch(err => console.error('[IntegrityMonitor] Interval error:', err))
  }, 15 * 60 * 1000)

  // Funding rate tracker — каждые 5 минут проверяет что прошёл 8h boundary,
  // начисляет/списывает funding для открытых сделок (виртуальная симуляция)
  startFundingTracker()

  // Liquidation WebSocket listener — копит ликвидации в памяти rolling 60min,
  // используется в скоринге сканера и в GPT-промптах. Без отдельного UI.
  startLiquidationListener(SCAN_COINS)

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

  // Background auto-scanner — runs on interval when enabled in settings
  startAutoScanner()

  // === Levels strategy live scanner & tracker (V2 + Fibo) ===
  startLevelsScanner()
  startLevelsTracker()
})

async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`)

  // 1. Stop accepting new connections
  server.close()

  // 2. Clear all intervals
  clearInterval(signalTrackerInterval)
  clearInterval(expireSignalsInterval)
  clearInterval(scannerTrackerInterval)
  clearInterval(integrityInterval)
  clearInterval(reconcileInterval)
  stopTtlChecker(ttlInterval)
  stopFundingTracker()
  stopAutoScanner()
  stopLevelsScanner()
  stopLevelsTracker()
  stopHealthCheck()

  // 3. Close WebSocket connections
  stopWsListener()
  stopLiquidationListener()
  await stopAutoListener().catch(() => {})

  // 4. Disconnect database
  await prisma.$disconnect()

  console.log('[Shutdown] Cleanup complete, exiting.')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
