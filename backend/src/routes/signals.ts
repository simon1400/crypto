import { Router } from 'express'
import { prisma } from '../db/prisma'
import { getChannelMessages } from '../services/telegram'
import { parseSignalMessage } from '../services/signalParser'
import { trackActiveSignals } from '../services/signalTracker'

const router = Router()

const CHANNELS: Record<string, string> = {
  EveningTrader: 'EveningTrader',
}

// GET /api/signals?channel=EveningTrader
router.get('/', async (req, res) => {
  try {
    const channel = (req.query.channel as string) || 'EveningTrader'
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const signals = await prisma.signal.findMany({
      where: {
        channel,
        publishedAt: { gte: weekAgo },
      },
      orderBy: { publishedAt: 'desc' },
    })

    res.json({ data: signals, channel })
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

    const messages = await getChannelMessages(username, 100)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

    let imported = 0
    let skipped = 0

    for (const msg of messages) {
      // Skip messages older than a week
      if (msg.date * 1000 < weekAgo) continue

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
        publishedAt: { gte: new Date(weekAgo) },
      },
      orderBy: { publishedAt: 'desc' },
    })

    res.json({ data: signals, imported, skipped, channel })
  } catch (err: any) {
    console.error('[Signals] Sync error:', err)
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
