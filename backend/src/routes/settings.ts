import { Router } from 'express'
import type { BotConfig } from '@prisma/client'
import { prisma } from '../db/prisma'
import { encrypt, maskKey } from '../services/encryption'
import { createBybitClient, validateBybitKeys } from '../services/bybit'
import { startAutoListener, stopAutoListener } from '../trading/autoListener'
import { restartAutoScanner } from '../services/autoScanner'
import { getInstrumentInfo } from '../trading/instrumentCache'
import { sendTestNotification, sendNotification } from '../services/notifier'
import { getVirtualBalanceInfo, setVirtualBalance } from '../services/virtualBalance'
import { asyncHandler, parseIdParam } from './_helpers'

const router = Router()

/**
 * Единый формат ответа /settings — используется в GET и PUT для исключения дубликата.
 */
function buildConfigResponse(config: BotConfig, extras?: { balance?: string; keyValidationFailed?: boolean }) {
  const base: any = {
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
    autoScanEnabled: config.autoScanEnabled,
    autoScanIntervalMin: config.autoScanIntervalMin,
    autoScanMinScore: config.autoScanMinScore,
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
    positionSizePct,
    dailyLossLimitPct,
    orderTtlMinutes,
    tradingMode,
    near512Topics,
    eveningTraderCategories,
    telegramBotToken,
    telegramChatId,
    telegramEnabled,
    autoScanEnabled,
    autoScanIntervalMin,
    autoScanMinScore,
    takerFeeRate,
    makerFeeRate,
  } = req.body

  // Validate numeric ranges
  if (positionSizePct !== undefined && (positionSizePct < 1 || positionSizePct > 50)) {
    res.status(400).json({ error: 'positionSizePct must be between 1 and 50' })
    return
  }
  if (dailyLossLimitPct !== undefined && (dailyLossLimitPct < 1 || dailyLossLimitPct > 30)) {
    res.status(400).json({ error: 'dailyLossLimitPct must be between 1 and 30' })
    return
  }
  if (orderTtlMinutes !== undefined && (orderTtlMinutes < 5 || orderTtlMinutes > 1440)) {
    res.status(400).json({ error: 'orderTtlMinutes must be between 5 and 1440' })
    return
  }
  if (tradingMode !== undefined && !['manual', 'auto'].includes(tradingMode)) {
    res.status(400).json({ error: 'tradingMode must be "manual" or "auto"' })
    return
  }
  if (autoScanIntervalMin !== undefined && (autoScanIntervalMin < 5 || autoScanIntervalMin > 120)) {
    res.status(400).json({ error: 'autoScanIntervalMin must be between 5 and 120' })
    return
  }
  if (autoScanMinScore !== undefined && (autoScanMinScore < 50 || autoScanMinScore > 100)) {
    res.status(400).json({ error: 'autoScanMinScore must be between 50 and 100' })
    return
  }

  // Build update object conditionally
  const updateData: any = {}
  const createData: any = { id: 1 }

  const setBoth = (key: string, value: any) => {
    updateData[key] = value
    createData[key] = value
  }

  if (useTestnet !== undefined) setBoth('useTestnet', useTestnet)
  if (positionSizePct !== undefined) setBoth('positionSizePct', positionSizePct)
  if (dailyLossLimitPct !== undefined) setBoth('dailyLossLimitPct', dailyLossLimitPct)
  if (orderTtlMinutes !== undefined) setBoth('orderTtlMinutes', orderTtlMinutes)
  if (tradingMode !== undefined) setBoth('tradingMode', tradingMode)
  if (near512Topics !== undefined) setBoth('near512Topics', near512Topics)
  if (eveningTraderCategories !== undefined) setBoth('eveningTraderCategories', eveningTraderCategories)
  if (telegramBotToken !== undefined) setBoth('telegramBotToken', telegramBotToken)
  if (telegramChatId !== undefined) setBoth('telegramChatId', telegramChatId)
  if (telegramEnabled !== undefined) setBoth('telegramEnabled', telegramEnabled)
  if (autoScanEnabled !== undefined) setBoth('autoScanEnabled', autoScanEnabled)
  if (autoScanIntervalMin !== undefined) setBoth('autoScanIntervalMin', autoScanIntervalMin)
  if (autoScanMinScore !== undefined) setBoth('autoScanMinScore', autoScanMinScore)
  if (takerFeeRate !== undefined && takerFeeRate >= 0 && takerFeeRate <= 0.01) setBoth('takerFeeRate', takerFeeRate)
  if (makerFeeRate !== undefined && makerFeeRate >= 0 && makerFeeRate <= 0.01) setBoth('makerFeeRate', makerFeeRate)

  let keyValidationFailed = false
  let balance: string | undefined

  // Handle API keys
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
  // If apiKey is null/undefined, do NOT touch existing keys (Pitfall 4)

  const config = await prisma.botConfig.upsert({ where: { id: 1 }, update: updateData, create: createData })

  // Restart auto scanner if any of its config fields changed
  if (autoScanEnabled !== undefined || autoScanIntervalMin !== undefined || autoScanMinScore !== undefined) {
    restartAutoScanner()
  }

  // Start/stop auto listener based on tradingMode change
  if (tradingMode === 'auto') {
    startAutoListener().catch(err =>
      console.error('[Settings] Failed to start auto listener:', err.message),
    )
  } else if (tradingMode === 'manual') {
    stopAutoListener().catch(err =>
      console.error('[Settings] Failed to stop auto listener:', err.message),
    )
  }

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

// POST /api/settings/test-trade-notifications — test all trade notification formats
router.post('/test-trade-notifications', asyncHandler(async (_req, res) => {
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

  await sendNotification('ORDER_FILLED', {
    symbol: 'BTCUSDT', type: 'LONG', leverage: 10,
    entryPrice: 84500, stopLoss: 83200, margin: 100,
    takeProfits: [
      { price: 85800, percent: 40 },
      { price: 87000, percent: 30 },
      { price: 89000, percent: 30 },
    ],
  })
  await delay(500)

  await sendNotification('TP1_HIT', {
    symbol: 'BTCUSDT', type: 'LONG', leverage: 10,
    price: 85800, closedPct: 40, pnlPct: 15.38,
    pnl: 6.15, fee: 0.0346, totalRealizedPnl: 6.15,
    remainingPct: 60, newStopLoss: 84500,
  })
  await delay(500)

  await sendNotification('SL_TRIGGERED', {
    symbol: 'ETHUSDT', type: 'SHORT', leverage: 5,
    price: 3250, pnl: -12.50, pnlPct: -6.25,
    totalRealizedPnl: -12.50, totalFees: 0.08,
    exitReason: 'INITIAL_STOP', timeInTrade: '3ч 45м',
  })
  await delay(500)

  await sendNotification('POSITION_CLOSED', {
    symbol: 'BTCUSDT', type: 'LONG', leverage: 10,
    totalRealizedPnl: 28.50, totalFees: 0.12,
    netPnl: 28.38, timeInTrade: '6ч 12м',
  })

  res.json({ success: true, message: 'Sent 4 test notifications: entry, TP, SL, close' })
}, 'Settings'))

// GET /api/settings/virtual-balance — текущий виртуальный депозит + ROI
router.get('/virtual-balance', asyncHandler(async (_req, res) => {
  res.json(await getVirtualBalanceInfo())
}, 'Settings'))

// PUT /api/settings/virtual-balance — установить новый депозит
router.put('/virtual-balance', asyncHandler(async (req, res) => {
  const { balance, resetStart } = req.body as { balance: number; resetStart?: boolean }
  if (typeof balance !== 'number' || balance < 0 || balance > 10_000_000) {
    res.status(400).json({ error: 'balance must be a number between 0 and 10,000,000' })
    return
  }
  const info = await setVirtualBalance(balance, resetStart !== false)
  res.json(info)
}, 'Settings'))

// POST /api/settings/reset-simulation — удалить все сделки + восстановить баланс
router.post('/reset-simulation', asyncHandler(async (req, res) => {
  const { balance } = req.body as { balance: number }
  if (typeof balance !== 'number' || balance < 0 || balance > 10_000_000) {
    res.status(400).json({ error: 'balance must be a number between 0 and 10,000,000' })
    return
  }

  const { count } = await prisma.trade.deleteMany({})
  const info = await setVirtualBalance(balance, true)

  console.log(`[Settings] Simulation reset: deleted ${count} trades, balance set to $${balance}`)
  res.json({ deletedTrades: count, ...info })
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

// === Ticker mappings CRUD ===

// GET /api/settings/ticker-mappings
router.get('/ticker-mappings', asyncHandler(async (_req, res) => {
  const mappings = await prisma.tickerMapping.findMany({ orderBy: { createdAt: 'asc' } })
  res.json(mappings)
}, 'Settings'))

/**
 * Проверяем что символ существует на Bybit. Возвращает true если ok.
 */
async function validateBybitSymbol(symbol: string): Promise<boolean> {
  try {
    const client = await createBybitClient()
    await getInstrumentInfo(client, symbol.toUpperCase())
    return true
  } catch {
    return false
  }
}

// POST /api/settings/ticker-mappings
router.post('/ticker-mappings', asyncHandler(async (req, res) => {
  const { fromTicker, toSymbol, priceMultiplier, notes } = req.body

  if (!fromTicker || !toSymbol) {
    res.status(400).json({ error: 'fromTicker and toSymbol are required' })
    return
  }

  if (!(await validateBybitSymbol(toSymbol))) {
    res.status(400).json({ error: `Symbol ${toSymbol} not found on Bybit` })
    return
  }

  try {
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
      res.status(400).json({ error: `Mapping for ${fromTicker} already exists` })
      return
    }
    throw err
  }
}, 'Settings'))

// PUT /api/settings/ticker-mappings/:id
router.put('/ticker-mappings/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return

  const { fromTicker, toSymbol, priceMultiplier, notes } = req.body

  if (toSymbol && !(await validateBybitSymbol(toSymbol))) {
    res.status(400).json({ error: `Symbol ${toSymbol} not found on Bybit` })
    return
  }

  try {
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
      res.status(400).json({ error: `Mapping for ${fromTicker} already exists` })
      return
    }
    throw err
  }
}, 'Settings'))

// DELETE /api/settings/ticker-mappings/:id
router.delete('/ticker-mappings/:id', asyncHandler(async (req, res) => {
  const id = parseIdParam(req, res)
  if (id == null) return
  await prisma.tickerMapping.delete({ where: { id } })
  res.json({ success: true })
}, 'Settings'))

export default router
