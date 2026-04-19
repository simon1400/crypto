import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockPrismaBotConfig,
  mockPrismaSignal,
  mockTelegramClient,
  mockParseSignalMessage,
  mockExtractCategory,
  mockCheckDailyLoss,
  mockExecuteSignalOrder,
  mockLogOrderAction,
} = vi.hoisted(() => ({
  mockPrismaBotConfig: {
    findUnique: vi.fn(),
  },
  mockPrismaSignal: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
  mockTelegramClient: {
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
  },
  mockParseSignalMessage: vi.fn(),
  mockExtractCategory: vi.fn(),
  mockCheckDailyLoss: vi.fn(),
  mockExecuteSignalOrder: vi.fn(),
  mockLogOrderAction: vi.fn(),
}))

vi.mock('../../src/db/prisma', () => ({
  prisma: {
    botConfig: mockPrismaBotConfig,
    signal: mockPrismaSignal,
  },
}))

vi.mock('../../src/services/telegram', () => ({
  getTelegramClient: vi.fn(async () => mockTelegramClient),
}))

vi.mock('../../src/services/signalParser', () => ({
  parseSignalMessage: mockParseSignalMessage,
  extractCategory: mockExtractCategory,
}))

vi.mock('../../src/trading/dailyLossGuard', () => ({
  checkDailyLoss: mockCheckDailyLoss,
}))

vi.mock('../../src/trading/tradingService', () => ({
  executeSignalOrder: mockExecuteSignalOrder,
}))

vi.mock('../../src/trading/orderLogger', () => ({
  logOrderAction: mockLogOrderAction,
}))

vi.mock('telegram/events', () => ({
  NewMessage: vi.fn(),
}))

vi.mock('telegram/events/EditedMessage', () => ({
  EditedMessage: vi.fn(),
}))

import {
  handleAutoMessage,
  startAutoListener,
  stopAutoListener,
  isAutoListenerActive,
  _resetForTests,
} from '../../src/trading/autoListener'

function makeEvent(overrides: {
  text?: string
  chatId?: string | bigint
  messageId?: number
}) {
  return {
    message: {
      message: overrides.text ?? '',
      chatId: overrides.chatId != null
        ? BigInt(overrides.chatId.toString())
        : BigInt('12345'),
      id: overrides.messageId ?? 1,
    },
  } as any
}

function mockConfig(overrides: Partial<{
  tradingMode: string
  eveningTraderCategories: string[]
  dailyLossLimitPct: number
}> = {}) {
  mockPrismaBotConfig.findUnique.mockResolvedValue({
    id: 1,
    tradingMode: overrides.tradingMode ?? 'auto',
    eveningTraderCategories: overrides.eveningTraderCategories ?? ['scalp', 'risk-scalp', 'swing'],
    dailyLossLimitPct: overrides.dailyLossLimitPct ?? 5,
  })
}

const EVENING_TRADER_CHAT_ID = '999' // any ID for EveningTrader

describe('autoListener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTests()
    mockCheckDailyLoss.mockResolvedValue({ allowed: true, realizedLossToday: 0, prospectiveWorstCase: 0, totalWorstCase: 0, limitAmount: 50 })
    mockLogOrderAction.mockResolvedValue(undefined)
    mockExecuteSignalOrder.mockResolvedValue({ id: 1 })
    mockPrismaSignal.findFirst.mockResolvedValue(null) // no duplicates by default
  })

  describe('handleAutoMessage', () => {
    it('Test 1: parses valid EveningTrader signal, saves to DB, executes', async () => {
      const signalText = 'Scalp Long $BTC (Max 10x)\nEntry: 95000\nSL: 94000\nTP: 96000 - 97000'
      const event = makeEvent({ text: signalText, chatId: EVENING_TRADER_CHAT_ID, messageId: 100 })

      mockConfig()
      mockParseSignalMessage.mockReturnValue({
        type: 'LONG', coin: 'BTC', leverage: 10,
        entryMin: 95000, entryMax: 95000, stopLoss: 94000,
        takeProfits: [96000, 97000], category: 'scalp',
      })
      mockExtractCategory.mockReturnValue('scalp')
      mockPrismaSignal.create.mockResolvedValue({ id: 42 })

      await handleAutoMessage(event)

      expect(mockPrismaSignal.create).toHaveBeenCalledTimes(1)
      expect(mockExecuteSignalOrder).toHaveBeenCalledWith(42)
      expect(mockLogOrderAction).toHaveBeenCalledWith('AUTO_EXECUTED', expect.objectContaining({ signalId: 42 }))
    })

    it('Test 3: skips when tradingMode is manual', async () => {
      const event = makeEvent({ text: 'Long $BTC...', chatId: EVENING_TRADER_CHAT_ID, messageId: 300 })

      mockConfig({ tradingMode: 'manual' })
      mockParseSignalMessage.mockReturnValue({
        type: 'LONG', coin: 'BTC', leverage: 10,
        entryMin: 95000, entryMax: 95000, stopLoss: 94000,
        takeProfits: [96000], category: 'scalp',
      })

      await handleAutoMessage(event)

      expect(mockExecuteSignalOrder).not.toHaveBeenCalled()
      expect(mockPrismaSignal.create).not.toHaveBeenCalled()
    })

    it('Test 5: skips EveningTrader when category not in config', async () => {
      const event = makeEvent({ text: 'Swing Long $BTC...', chatId: EVENING_TRADER_CHAT_ID, messageId: 500 })

      mockConfig({ eveningTraderCategories: ['scalp'] }) // swing not enabled
      mockParseSignalMessage.mockReturnValue({
        type: 'LONG', coin: 'BTC', leverage: 10,
        entryMin: 95000, entryMax: 95000, stopLoss: 94000,
        takeProfits: [96000], category: 'swing',
      })
      mockExtractCategory.mockReturnValue('swing')

      await handleAutoMessage(event)

      expect(mockExecuteSignalOrder).not.toHaveBeenCalled()
      expect(mockLogOrderAction).toHaveBeenCalledWith('AUTO_SKIPPED', expect.objectContaining({
        details: expect.objectContaining({ reason: 'category_not_enabled' }),
      }))
    })

    it('Test 6: skips when checkDailyLoss returns allowed=false', async () => {
      const event = makeEvent({ text: 'Scalp Long $BTC...', chatId: EVENING_TRADER_CHAT_ID, messageId: 600 })

      mockConfig()
      mockParseSignalMessage.mockReturnValue({
        type: 'LONG', coin: 'BTC', leverage: 10,
        entryMin: 95000, entryMax: 95000, stopLoss: 94000,
        takeProfits: [96000], category: 'scalp',
      })
      mockExtractCategory.mockReturnValue('scalp')
      mockCheckDailyLoss.mockResolvedValue({
        allowed: false,
        realizedLossToday: -40,
        prospectiveWorstCase: 20,
        totalWorstCase: 60,
        limitAmount: 50,
        reason: 'Daily loss limit exceeded',
      })

      await handleAutoMessage(event)

      expect(mockExecuteSignalOrder).not.toHaveBeenCalled()
      expect(mockLogOrderAction).toHaveBeenCalledWith('DAILY_LIMIT_HIT', expect.objectContaining({
        details: expect.objectContaining({ totalWorstCase: 60 }),
      }))
    })

    it('Test 7: skips unparseable messages silently', async () => {
      const event = makeEvent({ text: 'Random chat message', chatId: EVENING_TRADER_CHAT_ID, messageId: 700 })

      mockParseSignalMessage.mockReturnValue(null)

      await handleAutoMessage(event)

      expect(mockPrismaBotConfig.findUnique).not.toHaveBeenCalled()
      expect(mockExecuteSignalOrder).not.toHaveBeenCalled()
      expect(mockLogOrderAction).not.toHaveBeenCalled()
    })

    it('Test 8: deduplicates - skips if signal with same channel+messageId exists', async () => {
      const event = makeEvent({ text: 'Scalp Long $BTC...', chatId: EVENING_TRADER_CHAT_ID, messageId: 800 })

      mockConfig()
      mockParseSignalMessage.mockReturnValue({
        type: 'LONG', coin: 'BTC', leverage: 10,
        entryMin: 95000, entryMax: 95000, stopLoss: 94000,
        takeProfits: [96000], category: 'scalp',
      })
      mockExtractCategory.mockReturnValue('scalp')

      // Simulate unique constraint violation on create
      const prismaError = new Error('Unique constraint failed') as any
      prismaError.code = 'P2002'
      mockPrismaSignal.create.mockRejectedValue(prismaError)

      await handleAutoMessage(event)

      expect(mockExecuteSignalOrder).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle', () => {
    it('Test 9: startAutoListener sets active, stopAutoListener clears', async () => {
      expect(isAutoListenerActive()).toBe(false)

      await startAutoListener()
      expect(isAutoListenerActive()).toBe(true)

      await stopAutoListener()
      expect(isAutoListenerActive()).toBe(false)
    })

    it('Test 10: startAutoListener called twice does not register duplicate handlers', async () => {
      await startAutoListener()
      await startAutoListener()

      expect(mockTelegramClient.addEventHandler).toHaveBeenCalledTimes(1)
    })
  })
})
