import { Router, Request, Response } from 'express'
import { fetchOHLCV, fetchMarketOverview } from '../services/market'
import { computeIndicators, MultiTFIndicators } from '../services/indicators'
import { analyzeWithClaude } from '../services/claude'
import { prisma } from '../db/prisma'

const router = Router()
const ALLOWED_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK']

let isRunning = false

router.post('/', async (req: Request, res: Response) => {
  if (isRunning) {
    res.status(409).json({ error: 'Analysis already running' })
    return
  }

  const { coins } = req.body as { coins?: string[] }
  if (!coins || !Array.isArray(coins) || coins.length === 0 || coins.length > 5) {
    res.status(400).json({ error: 'Select 1-5 coins' })
    return
  }

  const invalid = coins.filter((c) => !ALLOWED_COINS.includes(c))
  if (invalid.length > 0) {
    res.status(400).json({ error: `Invalid coins: ${invalid.join(', ')}` })
    return
  }

  isRunning = true

  try {
    const market = await fetchMarketOverview()

    const coinsData: Record<string, MultiTFIndicators> = {}
    await Promise.all(
      coins.map(async (coin) => {
        const symbol = coin + 'USDT'
        const [candles15m, candles1h, candles4h] = await Promise.all([
          fetchOHLCV(symbol, '15m', 100),
          fetchOHLCV(symbol, '1h', 100),
          fetchOHLCV(symbol, '4h', 60),
        ])
        coinsData[coin] = {
          tf15m: computeIndicators(candles15m),
          tf1h: computeIndicators(candles1h),
          tf4h: computeIndicators(candles4h),
        }
      })
    )

    const result = await analyzeWithClaude(coinsData, market)

    const analysis = await prisma.analysis.create({
      data: {
        coins: coins.join(','),
        marketData: market as any,
        coinsData: coinsData as any,
        result,
      },
    })

    res.json({
      id: analysis.id,
      result: analysis.result,
      coinsData,
      marketData: market,
      createdAt: analysis.createdAt,
    })
  } catch (err) {
    console.error('Analysis error:', err)
    res.status(500).json({ error: 'Analysis failed' })
  } finally {
    isRunning = false
  }
})

export default router
