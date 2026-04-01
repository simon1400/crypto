import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock p-queue before imports
vi.mock('p-queue', () => {
  class MockPQueue {
    add(fn: () => Promise<any>) {
      return fn()
    }
  }
  return { default: MockPQueue }
})

// Mock prisma
const mockPrismaPosition = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
}
const mockPrismaSignal = {
  findUnique: vi.fn(),
}
const mockPrismaBotConfig = {
  findUnique: vi.fn(),
}
vi.mock('../../src/db/prisma', () => ({
  prisma: {
    position: mockPrismaPosition,
    signal: mockPrismaSignal,
    botConfig: mockPrismaBotConfig,
  },
}))

// Mock bybit client
const mockBybitClient = {
  getWalletBalance: vi.fn(),
  cancelOrder: vi.fn(),
  setLeverage: vi.fn(),
  submitOrder: vi.fn(),
  getTickers: vi.fn(),
}
vi.mock('../../src/services/bybit', () => ({
  createBybitClient: vi.fn(() => mockBybitClient),
}))

// Mock orderExecutor
const mockExecutor = {
  executeInQueue: vi.fn((fn: () => Promise<any>) => fn()),
  setLeverage: vi.fn(),
  determineEntryType: vi.fn(),
  placeEntryWithSl: vi.fn(),
  placeTpOrders: vi.fn(),
}
vi.mock('../../src/trading/orderExecutor', () => ({
  createOrderExecutor: vi.fn(() => mockExecutor),
}))

// Mock instrumentCache
vi.mock('../../src/trading/instrumentCache', () => ({
  getInstrumentInfo: vi.fn(() =>
    Promise.resolve({
      symbol: 'BTCUSDT',
      minOrderQty: '0.001',
      qtyStep: '0.001',
      tickSize: '0.01',
    })
  ),
}))

// Mock positionSizer
vi.mock('../../src/trading/positionSizer', () => ({
  calculatePositionQty: vi.fn(() => '0.01'),
  alignToTickSize: vi.fn((price: number) => String(price)),
}))

// Mock orderLogger
vi.mock('../../src/trading/orderLogger', () => ({
  logOrderAction: vi.fn(),
}))

import { executeSignalOrder, checkExpiredOrders, startTtlChecker, stopTtlChecker } from '../../src/trading/tradingService'
import { logOrderAction } from '../../src/trading/orderLogger'

const sampleSignal = {
  id: 1,
  channel: 'test',
  messageId: 1,
  publishedAt: new Date(),
  type: 'LONG',
  coin: 'BTC',
  leverage: 10,
  entryMin: 95000,
  entryMax: 96000,
  stopLoss: 93000,
  takeProfits: [98000, 100000],
  status: 'ENTRY_WAIT',
  category: null,
  entryFilledAt: null,
  statusUpdatedAt: null,
  priceHistory: [],
  createdAt: new Date(),
}

const sampleBotConfig = {
  id: 1,
  apiKey: 'enc-key',
  apiSecret: 'enc-secret',
  useTestnet: true,
  positionSizePct: 10,
  dailyLossLimitPct: 5,
  orderTtlMinutes: 60,
  tradingMode: 'manual',
  near512Topics: [],
  eveningTraderCategories: [],
  updatedAt: new Date(),
  createdAt: new Date(),
}

describe('TradingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default mocks
    mockPrismaSignal.findUnique.mockResolvedValue(sampleSignal)
    mockPrismaPosition.findFirst.mockResolvedValue(null) // no existing position
    mockPrismaBotConfig.findUnique.mockResolvedValue(sampleBotConfig)

    mockBybitClient.getWalletBalance.mockResolvedValue({
      retCode: 0,
      result: {
        list: [{ coin: [{ coin: 'USDT', walletBalance: '1000' }] }],
      },
    })

    mockExecutor.setLeverage.mockResolvedValue(undefined)
    mockExecutor.determineEntryType.mockResolvedValue({ orderType: 'Market' })
    mockExecutor.placeEntryWithSl.mockResolvedValue({
      orderId: 'order-123',
      orderLinkId: 'sig-1-entry',
    })
    mockExecutor.placeTpOrders.mockResolvedValue(['tp-1', 'tp-2'])

    mockPrismaPosition.create.mockResolvedValue({
      id: 1,
      symbol: 'BTCUSDT',
      type: 'LONG',
      leverage: 10,
      qty: 0.01,
      status: 'OPEN',
      signalId: 1,
      entryOrderId: 'order-123',
      entryOrderLinkId: 'sig-1-entry',
      stopLoss: 93000,
      takeProfits: [98000, 100000],
      tpOrderIds: [],
      closedPct: 0,
      realizedPnl: 0,
      fees: 0,
      createdAt: new Date(),
    })
    mockPrismaPosition.update.mockResolvedValue({})
  })

  // ============================================================
  // executeSignalOrder tests
  // ============================================================
  describe('executeSignalOrder', () => {
    it('creates Position with status OPEN for market orders', async () => {
      mockExecutor.determineEntryType.mockResolvedValue({ orderType: 'Market' })

      await executeSignalOrder(1)

      expect(mockPrismaPosition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'OPEN',
            signalId: 1,
            symbol: 'BTCUSDT',
          }),
        })
      )
    })

    it('creates Position with status PENDING_ENTRY for limit orders', async () => {
      mockExecutor.determineEntryType.mockResolvedValue({
        orderType: 'Limit',
        price: '95500',
      })

      await executeSignalOrder(1)

      expect(mockPrismaPosition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING_ENTRY',
          }),
        })
      )
    })

    it('places TP orders immediately for market entries', async () => {
      mockExecutor.determineEntryType.mockResolvedValue({ orderType: 'Market' })

      await executeSignalOrder(1)

      expect(mockExecutor.placeTpOrders).toHaveBeenCalled()
    })

    it('does NOT place TP orders for limit entries', async () => {
      mockExecutor.determineEntryType.mockResolvedValue({
        orderType: 'Limit',
        price: '95500',
      })

      await executeSignalOrder(1)

      expect(mockExecutor.placeTpOrders).not.toHaveBeenCalled()
    })

    it('rejects duplicate: throws if Position already exists for signalId', async () => {
      mockPrismaPosition.findFirst.mockResolvedValue({ id: 99, status: 'OPEN' })

      await expect(executeSignalOrder(1)).rejects.toThrow(/already exists/)
    })

    it('logs ORDER_PLACED with signalId', async () => {
      await executeSignalOrder(1)

      expect(logOrderAction).toHaveBeenCalledWith(
        'ORDER_PLACED',
        expect.objectContaining({ signalId: 1 })
      )
    })

    it('sets leverage via executor before placing order', async () => {
      await executeSignalOrder(1)

      expect(mockExecutor.setLeverage).toHaveBeenCalledWith('BTCUSDT', 10)
    })

    it('throws if signal not found', async () => {
      mockPrismaSignal.findUnique.mockResolvedValue(null)

      await expect(executeSignalOrder(999)).rejects.toThrow(/not found/)
    })
  })

  // ============================================================
  // TTL checker tests
  // ============================================================
  describe('checkExpiredOrders', () => {
    it('cancels PENDING_ENTRY positions older than TTL', async () => {
      const oldPosition = {
        id: 5,
        symbol: 'ETHUSDT',
        entryOrderId: 'order-old',
        status: 'PENDING_ENTRY',
        createdAt: new Date(Date.now() - 120 * 60 * 1000), // 2 hours ago
        signalId: 2,
      }
      mockPrismaPosition.findMany.mockResolvedValue([oldPosition])
      mockBybitClient.cancelOrder.mockResolvedValue({ retCode: 0 })

      await checkExpiredOrders()

      expect(mockBybitClient.cancelOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'linear',
          symbol: 'ETHUSDT',
          orderId: 'order-old',
        })
      )
      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 5 },
          data: expect.objectContaining({ status: 'EXPIRED' }),
        })
      )
    })

    it('does not cancel OPEN positions', async () => {
      mockPrismaPosition.findMany.mockResolvedValue([])

      await checkExpiredOrders()

      expect(mockBybitClient.cancelOrder).not.toHaveBeenCalled()
    })

    it('logs ORDER_CANCELLED and EXPIRED for cancelled orders', async () => {
      const oldPosition = {
        id: 5,
        symbol: 'ETHUSDT',
        entryOrderId: 'order-old',
        status: 'PENDING_ENTRY',
        createdAt: new Date(Date.now() - 120 * 60 * 1000),
        signalId: 2,
      }
      mockPrismaPosition.findMany.mockResolvedValue([oldPosition])
      mockBybitClient.cancelOrder.mockResolvedValue({ retCode: 0 })

      await checkExpiredOrders()

      expect(logOrderAction).toHaveBeenCalledWith(
        'ORDER_CANCELLED',
        expect.objectContaining({ positionId: 5 })
      )
      expect(logOrderAction).toHaveBeenCalledWith(
        'EXPIRED',
        expect.objectContaining({ positionId: 5 })
      )
    })
  })

  // ============================================================
  // startTtlChecker / stopTtlChecker
  // ============================================================
  describe('startTtlChecker / stopTtlChecker', () => {
    it('returns an interval that can be stopped', () => {
      const interval = startTtlChecker()
      expect(interval).toBeDefined()
      stopTtlChecker(interval)
    })
  })
})
