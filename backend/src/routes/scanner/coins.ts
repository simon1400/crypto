import { Router } from 'express'
import { SCAN_COINS } from '../../scanner/coinScanner'
import { prisma } from '../../db/prisma'
import { asyncHandler } from '../_helpers'

const router = Router()

// GET /api/scanner/coins — get selected coins for scanning (or default SCAN_COINS)
router.get('/coins', asyncHandler(async (_req, res) => {
  try {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    const selected = (config?.scannerCoins as string[]) || []
    res.json({ coins: selected.length > 0 ? selected : SCAN_COINS })
  } catch {
    res.json({ coins: SCAN_COINS })
  }
}, 'Scanner'))

// GET /api/scanner/coin-list — get all Bybit USDT pairs + current selection
router.get('/coin-list', asyncHandler(async (_req, res) => {
  const bybitRes = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000')
  const bybitData = await bybitRes.json() as { result: { list: { symbol: string; status: string; quoteCoin: string }[] } }
  const allCoins = bybitData.result.list
    .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT')
    .map(s => s.symbol.replace('USDT', ''))
    .sort()

  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  const selected = (config?.scannerCoins as string[]) || []

  res.json({ available: allCoins, selected })
}, 'Scanner'))

// PUT /api/scanner/coin-list — save selected coins
router.put('/coin-list', asyncHandler(async (req, res) => {
  const { coins } = req.body as { coins: string[] }
  if (!Array.isArray(coins)) {
    res.status(400).json({ error: 'coins array required' })
    return
  }

  await prisma.botConfig.upsert({
    where: { id: 1 },
    create: { scannerCoins: coins },
    update: { scannerCoins: coins },
  })

  res.json({ saved: coins.length })
}, 'Scanner'))

export default router
