import { Router } from 'express'
import { prisma } from '../db/prisma'
import { getChannelMessages, downloadMessageMedia } from '../services/telegram'
import { parseSignalMessage } from '../services/signalParser'
import { parseSignalImage, isBinanceKillersSignal } from '../services/imageParser'
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
  'Near512-LowCap': { peer: '-1002726338238', topicId: 6 },
  'Near512-MidHigh': { peer: '-1002726338238', topicId: 8 },
  'Near512-Spot': { peer: '-1002726338238', topicId: 18 },
  BinanceKillers: { peer: 'binancekillers' },
}

// Channels that require image parsing (signal data is in photos, not text)
const IMAGE_CHANNELS = ['BinanceKillers']

// Channels that belong to Near512 group (for "All" combined view)
const NEAR512_CHANNELS = ['Near512-LowCap', 'Near512-MidHigh', 'Near512-Spot']

// GET /api/signals?channel=EveningTrader&days=7
router.get('/', asyncHandler(async (req, res) => {
  const channel = (req.query.channel as string) || 'EveningTrader'
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const where = channel === 'Near512-All'
    ? { channel: { in: NEAR512_CHANNELS }, publishedAt: { gte: since } }
    : { channel, publishedAt: { gte: since } }

  const signals = await prisma.signal.findMany({ where, orderBy: { publishedAt: 'desc' } })
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

  // Determine which channels to sync
  const channelsToSync = channel === 'Near512-All' ? NEAR512_CHANNELS : [channel]

  let imported = 0
  let skipped = 0

  for (const ch of channelsToSync) {
    const config = CHANNELS[ch]
    if (!config) continue

    const messages = await getChannelMessages(config.peer, sinceUnix, config.topicId)
    const isImageChannel = IMAGE_CHANNELS.includes(ch)

    for (const msg of messages) {
      let parsed: any = null

      if (isImageChannel) {
        // BinanceKillers: signal data is in the photo, text is just ✅✅TICKER✅✅
        const ticker = isBinanceKillersSignal(msg.text)
        if (!ticker || !msg.hasMedia) continue

        console.log(`[Signals] BinanceKillers signal detected: ${ticker}, downloading image...`)
        const imageBuffer = await downloadMessageMedia(config.peer, msg.id, config.topicId)
        if (!imageBuffer) {
          console.warn(`[Signals] Failed to download image for msg #${msg.id}`)
          continue
        }

        parsed = await parseSignalImage(imageBuffer)
        if (parsed) {
          console.log(`[Signals] BinanceKillers parsed: ${parsed.coin} ${parsed.type} entry=${parsed.entryMin}-${parsed.entryMax}`)
        }
      } else {
        parsed = parseSignalMessage(msg.text)
      }

      if (!parsed) continue

      try {
        await prisma.signal.upsert({
          where: {
            channel_messageId: { channel: ch, messageId: msg.id },
          },
          create: {
            channel: ch,
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
  }

  // Also run tracker to update statuses
  await trackActiveSignals()

  const where = channel === 'Near512-All'
    ? { channel: { in: NEAR512_CHANNELS }, publishedAt: { gte: new Date(since) } }
    : { channel, publishedAt: { gte: new Date(since) } }

  const signals = await prisma.signal.findMany({ where, orderBy: { publishedAt: 'desc' } })
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
    if (channel === 'Near512-All') {
      where.channel = { in: NEAR512_CHANNELS }
    } else {
      where.channel = channel
    }
  }
  if (days > 0) {
    where.publishedAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
  }

  const result = await prisma.signal.deleteMany({ where })
  res.json({ deleted: result.count })
}, 'Signals'))

export default router
