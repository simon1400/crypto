import { Router } from 'express'
import { prisma } from '../db/prisma'
import { getChannelMessages, downloadMessageMedia } from '../services/telegram'
import { parseSignalMessage } from '../services/signalParser'
import { parseSignalImage, isBinanceKillersSignal } from '../services/imageParser'
import { trackActiveSignals, resolveSymbolFromCache } from '../services/signalTracker'
import { fetchCurrentPrice } from '../services/market'

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
router.get('/', async (req, res) => {
  try {
    const channel = (req.query.channel as string) || 'EveningTrader'
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const where = channel === 'Near512-All'
      ? { channel: { in: NEAR512_CHANNELS }, publishedAt: { gte: since } }
      : { channel, publishedAt: { gte: since } }

    const signals = await prisma.signal.findMany({
      where,
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
  // Extend timeout for large syncs (3+ months of messages)
  req.setTimeout(300000) // 5 min
  res.setTimeout(300000)
  try {
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

    const signals = await prisma.signal.findMany({
      where,
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
        prices[coin] = await fetchCurrentPrice(resolveSymbolFromCache(coin))
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
