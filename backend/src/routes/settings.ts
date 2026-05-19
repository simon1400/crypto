import { Router } from 'express'
import type { BotConfig } from '@prisma/client'
import { prisma } from '../db/prisma'
import { encrypt, maskKey } from '../services/encryption'
import { createBybitClient, validateBybitKeys } from '../services/bybit'
import { sendTestNotification } from '../services/notifier'
import { BinanceFuturesClient, BinanceApiError } from '../services/exchanges/binanceFutures'
import { restartBreakoutLiveTraderC } from '../services/dailyBreakoutLiveC'
import { asyncHandler } from './_helpers'

const router = Router()

function buildConfigResponse(config: BotConfig, extras?: { balance?: string; keyValidationFailed?: boolean }) {
  const base: any = {
    apiKeyMasked: maskKey(config.apiKey),
    apiSecretMasked: maskKey(config.apiSecret),
    hasKeys: !!(config.apiKey && config.apiSecret),
    useTestnet: config.useTestnet,
    binanceTestnetKeyMasked: maskKey(config.binanceTestnetApiKey),
    binanceTestnetSecretMasked: maskKey(config.binanceTestnetApiSecret),
    binanceTestnetConfigured: !!(config.binanceTestnetApiKey && config.binanceTestnetApiSecret),
    binanceLiveKeyMasked: maskKey(config.binanceLiveApiKey),
    binanceLiveSecretMasked: maskKey(config.binanceLiveApiSecret),
    binanceLiveConfigured: !!(config.binanceLiveApiKey && config.binanceLiveApiSecret),
    telegramBotToken: config.telegramBotToken ? '****' + config.telegramBotToken.slice(-4) : null,
    telegramChatId: config.telegramChatId,
    telegramEnabled: config.telegramEnabled,
    takerFeeRate: config.takerFeeRate,
    makerFeeRate: config.makerFeeRate,
  }
  if (extras?.balance !== undefined) base.balance = extras.balance
  if (extras?.keyValidationFailed) base.keyValidationFailed = true
  return base
}

// GET /api/settings
router.get('/', asyncHandler(async (_req, res) => {
  const config = await prisma.botConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  res.json(buildConfigResponse(config))
}, 'Settings'))

// PUT /api/settings
router.put('/', asyncHandler(async (req, res) => {
  const {
    apiKey,
    apiSecret,
    useTestnet,
    telegramBotToken,
    telegramChatId,
    telegramEnabled,
    takerFeeRate,
    makerFeeRate,
  } = req.body

  const updateData: any = {}
  const createData: any = { id: 1 }

  const setBoth = (key: string, value: any) => {
    updateData[key] = value
    createData[key] = value
  }

  if (useTestnet !== undefined) setBoth('useTestnet', useTestnet)
  if (telegramBotToken !== undefined) setBoth('telegramBotToken', telegramBotToken)
  if (telegramChatId !== undefined) setBoth('telegramChatId', telegramChatId)
  if (telegramEnabled !== undefined) setBoth('telegramEnabled', telegramEnabled)
  if (takerFeeRate !== undefined && takerFeeRate >= 0 && takerFeeRate <= 0.01) setBoth('takerFeeRate', takerFeeRate)
  if (makerFeeRate !== undefined && makerFeeRate >= 0 && makerFeeRate <= 0.01) setBoth('makerFeeRate', makerFeeRate)

  let keyValidationFailed = false
  let balance: string | undefined

  if (apiKey && apiSecret) {
    const testnetFlag = useTestnet ?? (await prisma.botConfig.findUnique({ where: { id: 1 } }))?.useTestnet ?? true
    const validation = await validateBybitKeys(apiKey, apiSecret, testnetFlag)

    if (validation.valid) {
      setBoth('apiKey', encrypt(apiKey))
      setBoth('apiSecret', encrypt(apiSecret))
      balance = validation.balance
    } else {
      keyValidationFailed = true
    }
  }

  const config = await prisma.botConfig.upsert({ where: { id: 1 }, update: updateData, create: createData })

  res.json(buildConfigResponse(config, { balance, keyValidationFailed }))
}, 'Settings'))

// POST /api/settings/test-notification
router.post('/test-notification', asyncHandler(async (req, res) => {
  let { botToken, chatId, telegramBotToken, telegramChatId } = req.body
  botToken = botToken || telegramBotToken
  chatId = chatId || telegramChatId

  if (!botToken || !chatId) {
    const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
    if (!config?.telegramBotToken || !config?.telegramChatId) {
      res.status(400).json({ error: 'Bot token and chat ID are required' })
      return
    }
    botToken = botToken || config.telegramBotToken
    chatId = chatId || config.telegramChatId
  }

  const success = await sendTestNotification(botToken, chatId)
  res.json({ success, ...(success ? {} : { error: 'Failed to send test message' }) })
}, 'Settings'))

// GET /api/settings/mt5-balance
router.get('/mt5-balance', asyncHandler(async (_req, res) => {
  const config = await prisma.botConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  res.json({
    balance: config.mt5Balance,
    riskPct: config.mt5RiskPct,
    commissionPerLot: config.mt5CommissionPerLot,
  })
}, 'Settings'))

// PUT /api/settings/mt5-balance
router.put('/mt5-balance', asyncHandler(async (req, res) => {
  const { balance, riskPct, commissionPerLot } = req.body as {
    balance?: number | null
    riskPct?: number
    commissionPerLot?: number
  }

  const updateData: any = {}
  if (balance === null) {
    updateData.mt5Balance = null
  } else if (balance !== undefined) {
    if (typeof balance !== 'number' || balance < 0 || balance > 10_000_000) {
      res.status(400).json({ error: 'balance must be a number between 0 and 10,000,000' })
      return
    }
    updateData.mt5Balance = balance
  }
  if (riskPct !== undefined) {
    if (typeof riskPct !== 'number' || riskPct <= 0 || riskPct > 100) {
      res.status(400).json({ error: 'riskPct must be between 0 and 100' })
      return
    }
    updateData.mt5RiskPct = riskPct
  }
  if (commissionPerLot !== undefined) {
    if (typeof commissionPerLot !== 'number' || commissionPerLot < 0 || commissionPerLot > 200) {
      res.status(400).json({ error: 'commissionPerLot must be between 0 and 200' })
      return
    }
    updateData.mt5CommissionPerLot = commissionPerLot
  }

  const config = await prisma.botConfig.upsert({
    where: { id: 1 },
    update: updateData,
    create: { id: 1, ...updateData },
  })
  res.json({
    balance: config.mt5Balance,
    riskPct: config.mt5RiskPct,
    commissionPerLot: config.mt5CommissionPerLot,
  })
}, 'Settings'))

// GET /api/settings/balance — реальный баланс с Bybit
router.get('/balance', asyncHandler(async (_req, res) => {
  try {
    const client = await createBybitClient()
    const response = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' })
    const list = response.result?.list
    const balance = list?.[0]?.coin?.find((c: any) => c.coin === 'USDT')?.walletBalance || '0'
    res.json({ balance })
  } catch (err: any) {
    if (err.message?.includes('not configured')) {
      res.status(400).json({ error: err.message })
      return
    }
    res.status(502).json({ error: `Failed to fetch balance: ${err.message}` })
  }
}, 'Settings'))

// ============================================================================
// Binance Futures USDT-M API keys (used by Variant C live trader)
// Two independent pairs: testnet + live. Validated on save via getAccount().
// ============================================================================

// PUT /api/settings/binance-keys
// Body: { net: 'testnet' | 'live', apiKey: string, apiSecret: string }
router.put('/binance-keys', asyncHandler(async (req, res) => {
  const { net, apiKey, apiSecret } = req.body as {
    net?: 'testnet' | 'live'
    apiKey?: string
    apiSecret?: string
  }
  if (net !== 'testnet' && net !== 'live') {
    res.status(400).json({ error: 'net must be testnet or live' })
    return
  }
  if (!apiKey || !apiSecret || apiKey.length < 10 || apiSecret.length < 10) {
    res.status(400).json({ error: 'apiKey and apiSecret are required' })
    return
  }

  // Validate against Binance by hitting getAccount() — confirms key has Futures
  // trade permission and signing works. Doesn't validate IP whitelist (that
  // surfaces on first real placement).
  const client = new BinanceFuturesClient({
    apiKey, apiSecret, net: net === 'live' ? 'prod' : 'testnet',
  })
  try {
    await client.syncTime()
    const acc = await client.getAccount()
    const usdt = acc.assets.find((a) => a.asset === 'USDT')
    const balance = usdt ? usdt.availableBalance : '0'

    const keyField = net === 'testnet' ? 'binanceTestnetApiKey' : 'binanceLiveApiKey'
    const secretField = net === 'testnet' ? 'binanceTestnetApiSecret' : 'binanceLiveApiSecret'

    const updateData: any = {
      [keyField]: encrypt(apiKey),
      [secretField]: encrypt(apiSecret),
    }
    const config = await prisma.botConfig.upsert({
      where: { id: 1 },
      update: updateData,
      create: { id: 1, ...updateData },
    })
    // Restart live trader so it picks up the new keys without process restart.
    // Fire-and-forget — if it fails the user still has updated keys in DB.
    restartBreakoutLiveTraderC().catch((e) => console.warn('[Settings] restart live trader failed:', e.message))
    res.json({ ...buildConfigResponse(config), binanceBalance: balance, binanceNet: net })
  } catch (e: any) {
    const msg = e instanceof BinanceApiError ? e.message : (e?.message || 'unknown')
    res.status(400).json({ error: `Binance validation failed: ${msg}` })
  }
}, 'Settings'))

// DELETE /api/settings/binance-keys?net=testnet|live
router.delete('/binance-keys', asyncHandler(async (req, res) => {
  const net = req.query.net as string
  if (net !== 'testnet' && net !== 'live') {
    res.status(400).json({ error: 'net query param must be testnet or live' })
    return
  }
  const updateData: any = net === 'testnet'
    ? { binanceTestnetApiKey: null, binanceTestnetApiSecret: null }
    : { binanceLiveApiKey: null, binanceLiveApiSecret: null }
  const config = await prisma.botConfig.update({ where: { id: 1 }, data: updateData })
  // Restart live trader so it disconnects the now-missing creds.
  restartBreakoutLiveTraderC().catch((e) => console.warn('[Settings] restart live trader failed:', e.message))
  res.json(buildConfigResponse(config))
}, 'Settings'))

export default router
