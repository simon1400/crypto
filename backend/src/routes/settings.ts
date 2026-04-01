import { Router } from 'express'
import { prisma } from '../db/prisma'
import { encrypt, decrypt, maskKey } from '../services/encryption'
import { createBybitClient, validateBybitKeys } from '../services/bybit'
import { startAutoListener, stopAutoListener } from '../trading/autoListener'

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
    }

    if (balance !== undefined) response.balance = balance
    if (keyValidationFailed) response.keyValidationFailed = true

    res.json(response)
  } catch (err: any) {
    console.error('[Settings] PUT error:', err)
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

export default router
