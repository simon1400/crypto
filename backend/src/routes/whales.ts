import { Router } from 'express'
import { fetchWhaleData, getWhaleList } from '../services/whales'

const router = Router()

let isScanning = false

// GET /api/whales — list tracked whales (no Etherscan calls)
router.get('/', (_req, res) => {
  res.json({ whales: getWhaleList() })
})

// POST /api/whales/scan — fetch whale data on demand (button press)
router.post('/scan', async (_req, res) => {
  if (isScanning) {
    return res.status(409).json({ error: 'Scan already running' })
  }

  isScanning = true
  try {
    const data = await fetchWhaleData()
    res.json({ data, scannedAt: new Date().toISOString() })
  } catch (err) {
    console.error('Whale scan error:', err)
    res.status(500).json({ error: 'Failed to scan whale wallets' })
  } finally {
    isScanning = false
  }
})

export default router
