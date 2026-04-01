import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrismaPosition, mockBybitClient, mockExecutor } = vi.hoisted(() => ({
  mockPrismaPosition: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  mockBybitClient: {
    getPositionInfo: vi.fn(),
    cancelOrder: vi.fn(),
  },
  mockExecutor: {
    placeTpOrders: vi.fn(),
  },
}))

// Mock p-queue
vi.mock('p-queue', () => {
  class MockPQueue {
    add(fn: () => Promise<any>) { return fn() }
  }
  return { default: MockPQueue }
})

vi.mock('../../src/db/prisma', () => ({
  prisma: {
    position: mockPrismaPosition,
    botConfig: { findUnique: vi.fn() },
  },
}))

vi.mock('../../src/services/bybit', () => ({
  createBybitClient: vi.fn(() => mockBybitClient),
}))

vi.mock('../../src/trading/orderExecutor', () => ({
  createOrderExecutor: vi.fn(() => mockExecutor),
}))

vi.mock('../../src/trading/instrumentCache', () => ({
  getInstrumentInfo: vi.fn(() =>
    Promise.resolve({ symbol: 'BTCUSDT', minOrderQty: '0.001', qtyStep: '0.001', tickSize: '0.01' })
  ),
}))

vi.mock('../../src/trading/positionSizer', () => ({
  alignToTickSize: vi.fn((price: number) => String(price)),
}))

vi.mock('../../src/trading/orderLogger', () => ({
  logOrderAction: vi.fn(),
}))

vi.mock('../../src/services/encryption', () => ({
  decrypt: vi.fn((v: string) => v),
}))

import { handleOrderUpdate, handlePositionUpdate, reconcilePositions } from '../../src/trading/positionManager'
import { logOrderAction } from '../../src/trading/orderLogger'

describe('PositionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecutor.placeTpOrders.mockResolvedValue(['tp-1', 'tp-2'])
    mockPrismaPosition.update.mockResolvedValue({})
  })

  // ============================================================
  // handleOrderUpdate tests
  // ============================================================
  describe('handleOrderUpdate', () => {
    it('entry fill updates Position to OPEN and triggers TP placement', async () => {
      const position = {
        id: 1,
        symbol: 'BTCUSDT',
        type: 'LONG',
        qty: 0.01,
        takeProfits: [98000, 100000],
        tpOrderIds: [],
        signalId: 1,
        status: 'PENDING_ENTRY',
        entryOrderId: 'order-123',
      }
      mockPrismaPosition.findFirst.mockResolvedValue(position)

      await handleOrderUpdate([{
        orderId: 'order-123',
        orderLinkId: 'sig-1-entry',
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        price: '95000',
        qty: '0.01',
        cumExecQty: '0.01',
        avgPrice: '95100',
        orderStatus: 'Filled',
        stopOrderType: '',
        reduceOnly: false,
      }])

      // Position should be updated to OPEN
      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({ status: 'OPEN' }),
        })
      )

      // TP orders should be placed
      expect(mockExecutor.placeTpOrders).toHaveBeenCalled()

      // ORDER_FILLED should be logged
      expect(logOrderAction).toHaveBeenCalledWith(
        'ORDER_FILLED',
        expect.objectContaining({ positionId: 1 })
      )
    })

    it('SL trigger updates Position to SL_HIT', async () => {
      const position = {
        id: 2,
        symbol: 'ETHUSDT',
        type: 'LONG',
        status: 'OPEN',
        signalId: 1,
      }
      mockPrismaPosition.findFirst.mockResolvedValue(position)

      await handleOrderUpdate([{
        orderId: 'sl-order-1',
        orderLinkId: 'unknown',
        symbol: 'ETHUSDT',
        side: 'Sell',
        orderType: 'Market',
        price: '0',
        qty: '0.05',
        cumExecQty: '0.05',
        avgPrice: '3100',
        orderStatus: 'Filled',
        stopOrderType: 'StopLoss',
        reduceOnly: true,
      }])

      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 2 },
          data: expect.objectContaining({ status: 'SL_HIT' }),
        })
      )

      expect(logOrderAction).toHaveBeenCalledWith(
        'SL_TRIGGERED',
        expect.objectContaining({ positionId: 2 })
      )
    })

    it('TP fill updates closedPct and logs TP_HIT', async () => {
      const position = {
        id: 3,
        symbol: 'BTCUSDT',
        type: 'LONG',
        status: 'OPEN',
        closedPct: 0,
        takeProfits: [98000, 100000],
        tpOrderIds: ['tp-order-1', 'tp-order-2'],
        signalId: 1,
      }
      mockPrismaPosition.findMany.mockResolvedValue([position])

      await handleOrderUpdate([{
        orderId: 'tp-order-1',
        orderLinkId: 'sig-1-tp1',
        symbol: 'BTCUSDT',
        side: 'Sell',
        orderType: 'Limit',
        price: '98000',
        qty: '0.005',
        cumExecQty: '0.005',
        avgPrice: '98000',
        orderStatus: 'Filled',
        stopOrderType: '',
        reduceOnly: true,
      }])

      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 3 },
          data: expect.objectContaining({ closedPct: 50 }),
        })
      )

      expect(logOrderAction).toHaveBeenCalledWith(
        'TP1_HIT',
        expect.objectContaining({ positionId: 3 })
      )
    })
  })

  // ============================================================
  // handlePositionUpdate tests
  // ============================================================
  describe('handlePositionUpdate', () => {
    it('size=0 marks position as CLOSED_EXTERNAL', async () => {
      const position = {
        id: 4,
        symbol: 'SOLUSDT',
        status: 'OPEN',
        signalId: 2,
      }
      mockPrismaPosition.findFirst.mockResolvedValue(position)

      await handlePositionUpdate([{
        symbol: 'SOLUSDT',
        side: 'None',
        size: '0',
        entryPrice: '0',
        leverage: '10',
        unrealisedPnl: '0',
        cumRealisedPnl: '15.5',
        liqPrice: '0',
      }])

      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 4 },
          data: expect.objectContaining({ status: 'CLOSED_EXTERNAL' }),
        })
      )

      expect(logOrderAction).toHaveBeenCalledWith(
        'CLOSED_EXTERNAL',
        expect.objectContaining({ positionId: 4 })
      )
    })
  })

  // ============================================================
  // reconcilePositions tests
  // ============================================================
  describe('reconcilePositions', () => {
    it('DB position not on Bybit -> CLOSED_EXTERNAL', async () => {
      mockBybitClient.getPositionInfo.mockResolvedValue({
        retCode: 0,
        result: { list: [] }, // no positions on Bybit
      })

      mockPrismaPosition.findMany.mockResolvedValue([
        { id: 5, symbol: 'BTCUSDT', status: 'OPEN', signalId: 1 },
      ])

      await reconcilePositions()

      expect(mockPrismaPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 5 },
          data: expect.objectContaining({ status: 'CLOSED_EXTERNAL' }),
        })
      )

      expect(logOrderAction).toHaveBeenCalledWith(
        'CLOSED_EXTERNAL',
        expect.objectContaining({ positionId: 5 })
      )
    })
  })
})
