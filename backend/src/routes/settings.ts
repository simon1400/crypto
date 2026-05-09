import { Router } from 'express'
import type { BotConfig } from '@prisma/client'
import { prisma } from '../db/prisma'
import { encrypt, maskKey } from '../services/encryption'
import { createBybitClient, validateBybitKeys } from '../services/bybit'
import { sendTestNotification } from '../services/notifier'
import { getVirtualBalanceInfo, setVirtualBalance } from '../services/virtualBalance'
import { asyncHandler } from './_helpers'

const router = Router()

function buildConfigResponse(config: BotConfig, extras?: { balance?: string; keyValidationFailed?: boolean }) {
  const base: any = {
    apiKeyMasked: maskKey(config.apiKey),
    apiSecretMasked: maskKey(config.apiSecret),
    hasKeys: !!(config.apiKey && config.apiSecret),
    useTestnet: config.useTestnet,
    telegramBotToken: config.telegramBotToken ? '****' + config.telegramBotToken.slice(-4) : null,
    telegramChatId: config.telegramChatId,
    telegramEnabled: config.telegramEnabled,
    virtualBalance: config.virtualBalance,
    virtualBalanceStart: config.virtualBalanceStart,
    virtualStartedAt: config.virtualStartedAt,
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

// GET /api/settings/virtual-balance
router.get('/virtual-balance', asyncHandler(async (_req, res) => {
  res.json(await getVirtualBalanceInfo())
}, 'Settings'))

// PUT /api/settings/virtual-balance
router.put('/virtual-balance', asyncHandler(async (req, res) => {
  const { balance, resetStart } = req.body as { balance: number; resetStart?: boolean }
  if (typeof balance !== 'number' || balance < 0 || balance > 10_000_000) {
    res.status(400).json({ error: 'balance must be a number between 0 and 10,000,000' })
    return
  }
  const info = await setVirtualBalance(balance, resetStart !== false)
  res.json(info)
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

export default router
