import { Router } from 'express'
import { prisma } from '../db/prisma'
import { getChannelMessages } from '../services/telegram'
import { parseSignalMessage } from '../services/signalParser'
import { trackActiveSignals, resolveSymbolFromCache } from '../services/signalTracker'
import { fetchCurrentPrice } from '../services/market'
import { asyncHandler, parseIdParam } from './_helpers'

const router = Router()

interface ChannelConfig {
  peer: string
  topicId?: number
}

const CHANNELS: Record<string, ChannelConfig> = {
  EveningTrader: { peer: 'EveningTrader' },
  ETG: { peer: process.env.ETG_CHANNEL_ID || '-1003873272082' },
}

// GET /api/signals?channel=EveningTrader&days=7
router.get('/', asyncHandler(async (req, res) => {
  const channel = (req.query.channel as string) || 'EveningTrader'
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const signals = await prisma.signal.findMany({
    where: { channel, publishedAt: { gte: since } },
    orderBy: { publishedAt: 'desc' },
  })
  res.json({ data: signals, channel, days })
}, 'Signals'))

// GET /api/signals/:id — single signal with price history
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const signal = await prisma.signal.findUnique({ where: { id } })
  if (!signal) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }
  res.json(signal)
}, 'Signals'))

// POST /api/signals/sync — sync signals from Telegram channel
router.post('/sync', asyncHandler(async (req, res) => {
  // Extend timeout for large syncs (3+ months of messages)
  req.setTimeout(300_000) // 5 min
  res.setTimeout(300_000)

  const channel = (req.body.channel as string) || 'EveningTrader'
  const days = Math.min(Math.max(parseInt(req.body.days as string) || 7, 1), 90)
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const sinceUnix = Math.floor(since / 1000)

  let imported = 0
  let skipped = 0

  const config = CHANNELS[channel]
  if (!config) {
    res.status(400).json({ error: `Unknown channel: ${channel}` })
    return
  }

  const messages = await getChannelMessages(config.peer, sinceUnix, config.topicId)

  for (const msg of messages) {
    const parsed: any = parseSignalMessage(msg.text)

    if (!parsed) continue

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
        update: {},
      })
      imported++
    } catch {
      skipped++
    }
  }

  // Also run tracker to update statuses
  await trackActiveSignals()

  const signals = await prisma.signal.findMany({
    where: { channel, publishedAt: { gte: new Date(since) } },
    orderBy: { publishedAt: 'desc' },
  })
  res.json({ data: signals, imported, skipped, channel })
}, 'Signals'))

// POST /api/signals/prices — get current prices for coins
router.post('/prices', asyncHandler(async (req, res) => {
  const coins = req.body.coins as string[]
  if (!Array.isArray(coins)) {
    res.status(400).json({ error: 'coins array required' })
    return
  }

  const prices: Record<string, number | null> = {}
  await Promise.all(
    [...new Set(coins)].map(async (coin) => {
      prices[coin] = await fetchCurrentPrice(resolveSymbolFromCache(coin))
    }),
  )

  res.json({ prices })
}, 'Signals'))

// POST /api/signals/reset/:id — reset signal status to ENTRY_WAIT (for mismatched prices)
router.post('/reset/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const signal = await prisma.signal.update({
    where: { id },
    data: { status: 'ENTRY_WAIT', entryFilledAt: null, statusUpdatedAt: null, priceHistory: [] },
  })
  res.json(signal)
}, 'Signals'))

// POST /api/signals/track — manually trigger price tracking
router.post('/track', asyncHandler(async (_req, res) => {
  await trackActiveSignals()
  res.json({ ok: true })
}, 'Signals'))

// DELETE /api/signals/clear — delete signals by channel and period
router.delete('/clear', asyncHandler(async (req, res) => {
  const channel = req.query.channel as string
  const days = parseInt(req.query.days as string) || 0

  const where: any = {}
  if (channel && channel !== 'all') {
    where.channel = channel
  }
  if (days > 0) {
    where.publishedAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
  }

  const result = await prisma.signal.deleteMany({ where })
  res.json({ deleted: result.count })
}, 'Signals'))

export default router
