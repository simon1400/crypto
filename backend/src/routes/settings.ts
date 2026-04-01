import { Router } from 'express'
import { prisma } from '../db/prisma'
import { encrypt, decrypt, maskKey } from '../services/encryption'
import { createBybitClient, validateBybitKeys } from '../services/bybit'
import { startAutoListener, stopAutoListener } from '../trading/autoListener'
import { getInstrumentInfo } from '../trading/instrumentCache'
import { sendTestNotification } from '../services/notifier'

const router = Router()

// GET /api/settings
router.get('/', async (_req, res) => {
  try {
    const config = await prisma.botConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    })

    res.json({
      apiKeyMasked: maskKey(config.apiKey),
      apiSecretMasked: maskKey(config.apiSecret),
      hasKeys: !!(config.apiKey && config.apiSecret),
      useTestnet: config.useTestnet,
      positionSizePct: config.positionSizePct,
      dailyLossLimitPct: config.dailyLossLimitPct,
      orderTtlMinutes: config.orderTtlMinutes,
      tradingMode: config.tradingMode,
      near512Topics: config.near512Topics,
      eveningTraderCategories: config.eveningTraderCategories,
      telegramBotToken: config.telegramBotToken ? '****' + config.telegramBotToken.slice(-4) : null,
      telegramChatId: config.telegramChatId,
      telegramEnabled: config.telegramEnabled,
    })
  } catch (err: any) {
    console.error('[Settings] GET error:', err)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/settings
router.put('/', async (req, res) => {
  try {
    const {
      apiKey,
      apiSecret,
      useTestnet,
      positionSizePct,
      dailyLossLimitPct,
      orderTtlMinutes,
      tradingMode,
      near512Topics,
      eveningTraderCategories,
      telegramBotToken,
      telegramChatId,
      telegramEnabled,
    } = req.body

    // Validate numeric ranges
    if (positionSizePct !== undefined && (positionSizePct < 1 || positionSizePct > 50)) {
      return res.status(400).json({ error: 'positionSizePct must be between 1 and 50' })
    }
    if (dailyLossLimitPct !== undefined && (dailyLossLimitPct < 1 || dailyLossLimitPct > 30)) {
      return res.status(400).json({ error: 'dailyLossLimitPct must be between 1 and 30' })
    }
    if (orderTtlMinutes !== undefined && (orderTtlMinutes < 5 || orderTtlMinutes > 1440)) {
      return res.status(400).json({ error: 'orderTtlMinutes must be between 5 and 1440' })
    }
    if (tradingMode !== undefined && !['manual', 'auto'].includes(tradingMode)) {
      return res.status(400).json({ error: 'tradingMode must be "manual" or "auto"' })
    }

    // Build update object conditionally
    const updateData: any = {}
    const createData: any = { id: 1 }

    if (useTestnet !== undefined) { updateData.useTestnet = useTestnet; createData.useTestnet = useTestnet }
    if (positionSizePct !== undefined) { updateData.positionSizePct = positionSizePct; createData.positionSizePct = positionSizePct }
    if (dailyLossLimitPct !== undefined) { updateData.dailyLossLimitPct = dailyLossLimitPct; createData.dailyLossLimitPct = dailyLossLimitPct }
    if (orderTtlMinutes !== undefined) { updateData.orderTtlMinutes = orderTtlMinutes; createData.orderTtlMinutes = orderTtlMinutes }
    if (tradingMode !== undefined) { updateData.tradingMode = tradingMode; createData.tradingMode = tradingMode }
    if (near512Topics !== undefined) { updateData.near512Topics = near512Topics; createData.near512Topics = near512Topics }
    if (eveningTraderCategories !== undefined) { updateData.eveningTraderCategories = eveningTraderCategories; createData.eveningTraderCategories = eveningTraderCategories }
    if (telegramBotToken !== undefined) { updateData.telegramBotToken = telegramBotToken; createData.telegramBotToken = telegramBotToken }
    if (telegramChatId !== undefined) { updateData.telegramChatId = telegramChatId; createData.telegramChatId = telegramChatId }
    if (telegramEnabled !== undefined) { updateData.telegramEnabled = telegramEnabled; createData.telegramEnabled = telegramEnabled }

    let keyValidationFailed = false
    let balance: string | undefined

    // Handle API keys
    if (apiKey && apiSecret) {
      const testnetFlag = useTestnet ?? (await prisma.botConfig.findUnique({ where: { id: 1 } }))?.useTestnet ?? true
      const validation = await validateBybitKeys(apiKey, apiSecret, testnetFlag)

      if (validation.valid) {
        updateData.apiKey = encrypt(apiKey)
        updateData.apiSecret = encrypt(apiSecret)
        createData.apiKey = updateData.apiKey
        createData.apiSecret = updateData.apiSecret
        balance = validation.balance
      } else {
        keyValidationFailed = true
        // Still save non-key settings below
      }
    }
    // If apiKey is null/undefined, do NOT touch existing keys (Pitfall 4)

    const config = await prisma.botConfig.upsert({
      where: { id: 1 },
      update: updateData,
      create: createData,
    })

    // Start/stop auto listener based on tradingMode change
    if (tradingMode === 'auto') {
      startAutoListener().catch(err =>
        console.error('[Settings] Failed to start auto listener:', err.message)
      )
    } else if (tradingMode === 'manual') {
      stopAutoListener().catch(err =>
        console.error('[Settings] Failed to stop auto listener:', err.message)
      )
    }

    const response: any = {
      apiKeyMasked: maskKey(config.apiKey),
      apiSecretMasked: maskKey(config.apiSecret),
      hasKeys: !!(config.apiKey && config.apiSecret),
      useTestnet: config.useTestnet,
      positionSizePct: config.positionSizePct,
      dailyLossLimitPct: config.dailyLossLimitPct,
      orderTtlMinutes: config.orderTtlMinutes,
      tradingMode: config.tradingMode,
      near512Topics: config.near512Topics,
      eveningTraderCategories: config.eveningTraderCategories,
      telegramBotToken: config.telegramBotToken ? '****' + config.telegramBotToken.slice(-4) : null,
      telegramChatId: config.telegramChatId,
      telegramEnabled: config.telegramEnabled,
    }

    if (balance !== undefined) response.balance = balance
    if (keyValidationFailed) response.keyValidationFailed = true

    res.json(response)
  } catch (err: any) {
    console.error('[Settings] PUT error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/settings/test-notification
router.post('/test-notification', async (req, res) => {
  try {
    let { botToken, chatId } = req.body

    // If not provided, read from BotConfig
    if (!botToken || !chatId) {
      const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
      if (!config?.telegramBotToken || !config?.telegramChatId) {
        return res.status(400).json({ error: 'Bot token and chat ID are required' })
      }
      botToken = botToken || config.telegramBotToken
      chatId = chatId || config.telegramChatId
    }

    const success = await sendTestNotification(botToken, chatId)
    if (success) {
      res.json({ success: true })
    } else {
      res.json({ success: false, error: 'Failed to send test message' })
    }
  } catch (err: any) {
    console.error('[Settings] Test notification error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/settings/balance
router.get('/balance', async (_req, res) => {
  try {
    const client = await createBybitClient()
    const response = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' })
    const balance =
      response.result.list[0]?.coin?.find((c: any) => c.coin === 'USDT')?.walletBalance || '0'
    res.json({ balance })
  } catch (err: any) {
    if (err.message?.includes('not configured')) {
      return res.status(400).json({ error: err.message })
    }
    console.error('[Settings] Balance error:', err)
    res.status(502).json({ error: `Failed to fetch balance: ${err.message}` })
  }
})

// GET /api/settings/ticker-mappings
router.get('/ticker-mappings', async (_req, res) => {
  try {
    const mappings = await prisma.tickerMapping.findMany({
      orderBy: { createdAt: 'asc' },
    })
    res.json(mappings)
  } catch (err: any) {
    console.error('[Settings] Ticker mappings GET error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/settings/ticker-mappings
router.post('/ticker-mappings', async (req, res) => {
  try {
    const { fromTicker, toSymbol, priceMultiplier, notes } = req.body

    if (!fromTicker || !toSymbol) {
      return res.status(400).json({ error: 'fromTicker and toSymbol are required' })
    }

    // Validate symbol exists on Bybit (per D-06)
    try {
      const client = await createBybitClient()
      await getInstrumentInfo(client, toSymbol.toUpperCase())
    } catch {
      return res.status(400).json({ error: `Symbol ${toSymbol} not found on Bybit` })
    }

    const mapping = await prisma.tickerMapping.create({
      data: {
        fromTicker: fromTicker.toUpperCase(),
        toSymbol: toSymbol.toUpperCase(),
        priceMultiplier: priceMultiplier || 1,
        notes: notes || null,
      },
    })
    res.json(mapping)
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: `Mapping for ${req.body.fromTicker} already exists` })
    }
    console.error('[Settings] Ticker mapping POST error:', err)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/settings/ticker-mappings/:id
router.put('/ticker-mappings/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { fromTicker, toSymbol, priceMultiplier, notes } = req.body

    // Validate symbol if changed (per D-06)
    if (toSymbol) {
      try {
        const client = await createBybitClient()
        await getInstrumentInfo(client, toSymbol.toUpperCase())
      } catch {
        return res.status(400).json({ error: `Symbol ${toSymbol} not found on Bybit` })
      }
    }

    const mapping = await prisma.tickerMapping.update({
      where: { id },
      data: {
        ...(fromTicker && { fromTicker: fromTicker.toUpperCase() }),
        ...(toSymbol && { toSymbol: toSymbol.toUpperCase() }),
        ...(priceMultiplier !== undefined && { priceMultiplier }),
        ...(notes !== undefined && { notes: notes || null }),
      },
    })
    res.json(mapping)
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: `Mapping for ${req.body.fromTicker} already exists` })
    }
    console.error('[Settings] Ticker mapping PUT error:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/settings/ticker-mappings/:id
router.delete('/ticker-mappings/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    await prisma.tickerMapping.delete({ where: { id } })
    res.json({ success: true })
  } catch (err: any) {
    console.error('[Settings] Ticker mapping DELETE error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
