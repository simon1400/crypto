import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import analyzeRouter from './routes/analyze'
import marketRouter from './routes/market'
import historyRouter from './routes/history'
import whalesRouter from './routes/whales'
import signalsRouter from './routes/signals'
import tradesRouter from './routes/trades'
import { trackActiveSignals } from './services/signalTracker'
import scannerRouter from './routes/scanner'
import { expireOldSignals, runScan } from './scanner/coinScanner'

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

app.use('/api/analyze', analyzeRouter)
app.use('/api/market', marketRouter)
app.use('/api/history', historyRouter)
app.use('/api/whales', whalesRouter)
app.use('/api/signals', signalsRouter)
app.use('/api/trades', tradesRouter)
app.use('/api/scanner', scannerRouter)

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

  // Auto-scan every 2 hours (all 20 coins, minScore 60, GPT filter on)
  // ~12 scans/day, ~$0.5-1/day GPT cost
  async function autoScan() {
    try {
      console.log('[AutoScan] Starting scheduled scan...')
      const results = await runScan(undefined, 60, true)
      const confirmed = results.filter(r => r.gptReview.verdict === 'CONFIRM')
      console.log(`[AutoScan] Done. ${confirmed.length} confirmed signals saved.`)
    } catch (err) {
      console.error('[AutoScan] Error:', err)
    }
  }

  // First scan 1 min after startup, then every 2 hours
  setTimeout(autoScan, 60 * 1000)
  setInterval(autoScan, 2 * 60 * 60 * 1000)
})
