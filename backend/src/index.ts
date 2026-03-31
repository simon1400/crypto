import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import marketRouter from './routes/market'
import signalsRouter from './routes/signals'
import tradesRouter from './routes/trades'
import { trackActiveSignals } from './services/signalTracker'
import scannerRouter from './routes/scanner'
import settingsRouter from './routes/settings'
import { expireOldSignals } from './scanner/coinScanner'

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

  // Auto-scan disabled — manual scan only via POST /api/scanner/scan
})
