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
import breakoutPaperRouter from './routes/breakoutPaper'
import breakoutPaperBRouter from './routes/breakoutPaperB'
import { startBreakoutLiveScanner, stopBreakoutLiveScanner } from './services/dailyBreakoutLiveScanner'
import { startBreakoutPaperTrader, stopBreakoutPaperTrader, startBreakoutEodSummary, stopBreakoutEodSummary } from './services/dailyBreakoutPaperTrader'
import { startBreakoutWsTracker, stopBreakoutWsTracker } from './services/breakoutWsTracker'

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
app.use('/api/settings', settingsRouter)
app.use('/api/klines', klinesRouter)
app.use('/api/breakout', breakoutRouter)
app.use('/api/breakout-paper', breakoutPaperRouter)
app.use('/api/breakout-paper-b', breakoutPaperBRouter)

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)

  // === Daily Breakout strategy live scanner & tracker ===
  startBreakoutLiveScanner()
  startBreakoutPaperTrader('A')
  startBreakoutPaperTrader('B')
  startBreakoutWsTracker()
  startBreakoutEodSummary()
})

async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`)

  server.close()

  stopBreakoutLiveScanner()
  stopBreakoutPaperTrader('A')
  stopBreakoutPaperTrader('B')
  stopBreakoutWsTracker()
  stopBreakoutEodSummary()

  await prisma.$disconnect()

  console.log('[Shutdown] Cleanup complete, exiting.')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
