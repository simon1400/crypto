import { Router } from 'express'
import { prisma } from '../db/prisma'
import { getChannelMessages } from '../services/telegram'
import { parseSignalMessage } from '../services/signalParser'
import { trackActiveSignals, resolveSymbol } from '../services/signalTracker'
import { fetchCurrentPrice } from '../services/market'

const router = Router()

const CHANNELS: Record<string, string> = {
  EveningTrader: 'EveningTrader',
}

// GET /api/signals?channel=EveningTrader&days=7
router.get('/', async (req, res) => {
  try {
    const channel = (req.query.channel as string) || 'EveningTrader'
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const signals = await prisma.signal.findMany({
      where: {
        channel,
        publishedAt: { gte: since },
      },
      orderBy: { publishedAt: 'desc' },
    })

    res.json({ data: signals, channel, days })
  } catch (err: any) {
    console.error('[Signals] GET error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/signals/:id — single signal with price history
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const signal = await prisma.signal.findUnique({ where: { id } })
    if (!signal) return res.status(404).json({ error: 'Signal not found' })
    res.json(signal)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/signals/sync — sync signals from Telegram channel
router.post('/sync', async (req, res) => {
  try {
    const channel = (req.body.channel as string) || 'EveningTrader'
    const username = CHANNELS[channel] || channel

    const days = Math.min(Math.max(parseInt(req.body.days as string) || 7, 1), 90)
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const sinceUnix = Math.floor(since / 1000)

    const messages = await getChannelMessages(username, sinceUnix)

    let imported = 0
    let skipped = 0

    for (const msg of messages) {

      const parsed = parseSignalMessage(msg.text)
      if (!parsed) continue

      // Upsert — skip duplicates by messageId
      try {
        await prisma.signal.upsert({
          where: {
            channel_messageId: { channel, messageId: msg.id },
          },
          create: {
            channel,
            messageId: msg.id,
            publishedAt: new Date(msg.date * 1000),
            type: parsed.type,
            coin: parsed.coin,
            leverage: parsed.leverage,
            entryMin: parsed.entryMin,
            entryMax: parsed.entryMax,
            stopLoss: parsed.stopLoss,
            takeProfits: parsed.takeProfits,
          },
          update: {}, // don't update existing signals
        })
        imported++
      } catch {
        skipped++
      }
    }

    // Also run tracker to update statuses
    await trackActiveSignals()

    const signals = await prisma.signal.findMany({
      where: {
        channel,
        publishedAt: { gte: new Date(since) },
      },
      orderBy: { publishedAt: 'desc' },
    })

    res.json({ data: signals, imported, skipped, channel })
  } catch (err: any) {
    console.error('[Signals] Sync error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/signals/prices — get current prices for coins
router.post('/prices', async (req, res) => {
  try {
    const coins = req.body.coins as string[]
    if (!Array.isArray(coins)) return res.status(400).json({ error: 'coins array required' })

    const prices: Record<string, number | null> = {}
    await Promise.all(
      [...new Set(coins)].map(async (coin) => {
        prices[coin] = await fetchCurrentPrice(resolveSymbol(coin))
      })
    )

    res.json({ prices })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/signals/reset/:id — reset signal status to ENTRY_WAIT (for mismatched prices)
router.post('/reset/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const signal = await prisma.signal.update({
      where: { id },
      data: { status: 'ENTRY_WAIT', entryFilledAt: null, statusUpdatedAt: null, priceHistory: [] },
    })
    res.json(signal)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/signals/track — manually trigger price tracking
router.post('/track', async (_req, res) => {
  try {
    await trackActiveSignals()
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
