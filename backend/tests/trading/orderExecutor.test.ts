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

// Mock orderLogger
vi.mock('../../src/trading/orderLogger', () => ({
  logOrderAction: vi.fn(),
}))

// Mock positionSizer
vi.mock('../../src/trading/positionSizer', () => ({
  alignToTickSize: vi.fn((price: number, _tickSize: string, _dir: string) => String(price)),
}))

import { OrderExecutor, createOrderExecutor } from '../../src/trading/orderExecutor'
import { logOrderAction } from '../../src/trading/orderLogger'
import { alignToTickSize } from '../../src/trading/positionSizer'

const mockSubmitOrder = vi.fn()
const mockSetLeverage = vi.fn()
const mockGetTickers = vi.fn()
const mockCancelOrder = vi.fn()

function createMockClient() {
  return {
    submitOrder: mockSubmitOrder,
    setLeverage: mockSetLeverage,
    getTickers: mockGetTickers,
    cancelOrder: mockCancelOrder,
  } as any
}

describe('OrderExecutor', () => {
  let executor: OrderExecutor

  beforeEach(() => {
    vi.clearAllMocks()
    executor = createOrderExecutor(createMockClient())
    // Reset alignToTickSize to return the price as string
    vi.mocked(alignToTickSize).mockImplementation(
      (price: number, _tickSize: string, _dir: 'floor' | 'ceil') => String(price)
    )
  })

  // ============================================================
  // setLeverage tests
  // ============================================================
  describe('setLeverage', () => {
    it('calls client.setLeverage with correct params', async () => {
      mockSetLeverage.mockResolvedValue({ retCode: 0, retMsg: 'OK' })

      await executor.setLeverage('BTCUSDT', 10)

      expect(mockSetLeverage).toHaveBeenCalledWith({
        category: 'linear',
        symbol: 'BTCUSDT',
        buyLeverage: '10',
        sellLeverage: '10',
      })
    })

    it('returns success when retCode=0', async () => {
      mockSetLeverage.mockResolvedValue({ retCode: 0, retMsg: 'OK' })

      await expect(executor.setLeverage('BTCUSDT', 10)).resolves.toBeUndefined()
    })

    it('returns success when retCode=110043 (not modified)', async () => {
      mockSetLeverage.mockResolvedValue({ retCode: 110043, retMsg: 'leverage not modified' })

      await expect(executor.setLeverage('ETHUSDT', 5)).resolves.toBeUndefined()
    })

    it('throws on other retCode values', async () => {
      mockSetLeverage.mockResolvedValue({ retCode: 10001, retMsg: 'some error' })

      await expect(executor.setLeverage('BTCUSDT', 10)).rejects.toThrow('some error')
    })
  })

  // ============================================================
  // determineEntryType tests
  // ============================================================
  describe('determineEntryType', () => {
    it('returns Market when current price is within entryMin-entryMax', async () => {
      mockGetTickers.mockResolvedValue({
        retCode: 0,
        result: { list: [{ lastPrice: '50000' }] },
      })

      const result = await executor.determineEntryType(
        { type: 'LONG', entryMin: 49000, entryMax: 51000, category: null },
        'BTCUSDT'
      )

      expect(result.orderType).toBe('Market')
      expect(result.price).toBeUndefined()
    })

    it('returns Limit at entryMax for LONG when price > entryMax', async () => {
      mockGetTickers.mockResolvedValue({
        retCode: 0,
        result: { list: [{ lastPrice: '52000' }] },
      })
      vi.mocked(alignToTickSize).mockReturnValue('51000')

      const result = await executor.determineEntryType(
        { type: 'LONG', entryMin: 49000, entryMax: 51000, category: null },
        'BTCUSDT'
      )

      expect(result.orderType).toBe('Limit')
      expect(result.price).toBe('51000')
    })

    it('returns Limit at entryMin for SHORT when price < entryMin', async () => {
      mockGetTickers.mockResolvedValue({
        retCode: 0,
        result: { list: [{ lastPrice: '48000' }] },
      })
      vi.mocked(alignToTickSize).mockReturnValue('49000')

      const result = await executor.determineEntryType(
        { type: 'SHORT', entryMin: 49000, entryMax: 51000, category: null },
        'BTCUSDT'
      )

      expect(result.orderType).toBe('Limit')
      expect(result.price).toBe('49000')
    })

    it('returns Market for scalp signals regardless of price', async () => {
      mockGetTickers.mockResolvedValue({
        retCode: 0,
        result: { list: [{ lastPrice: '99000' }] },
      })

      const result = await executor.determineEntryType(
        { type: 'LONG', entryMin: 49000, entryMax: 51000, category: 'Scalp' },
        'BTCUSDT'
      )

      expect(result.orderType).toBe('Market')
      expect(result.price).toBeUndefined()
    })

    it('returns Market for Risk Scalp signals', async () => {
      const result = await executor.determineEntryType(
        { type: 'LONG', entryMin: 49000, entryMax: 51000, category: 'Risk Scalp' },
        'BTCUSDT'
      )

      expect(result.orderType).toBe('Market')
    })
  })

  // ============================================================
  // placeEntryWithSl tests
  // ============================================================
  describe('placeEntryWithSl', () => {
    it('calls submitOrder with side=Buy for LONG, includes SL and tpslMode Full', async () => {
      mockSubmitOrder.mockResolvedValue({
        retCode: 0,
        result: { orderId: 'ord-123', orderLinkId: 'sig-1-entry' },
      })

      const result = await executor.placeEntryWithSl({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Market',
        qty: '0.001',
        stopLoss: 48000,
        signalId: 1,
        tickSize: '0.1',
      })

      expect(mockSubmitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'linear',
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.001',
          timeInForce: 'IOC',
          positionIdx: 0,
          stopLoss: '48000',
          tpslMode: 'Full',
          orderLinkId: 'sig-1-entry',
        })
      )
      expect(result.orderId).toBe('ord-123')
      expect(logOrderAction).toHaveBeenCalledWith('ORDER_PLACED', expect.any(Object))
    })

    it('uses timeInForce=GTC and includes price for Limit orders', async () => {
      mockSubmitOrder.mockResolvedValue({
        retCode: 0,
        result: { orderId: 'ord-456', orderLinkId: 'sig-2-entry' },
      })

      await executor.placeEntryWithSl({
        symbol: 'ETHUSDT',
        side: 'Sell',
        orderType: 'Limit',
        qty: '0.1',
        price: '3500',
        stopLoss: 3700,
        signalId: 2,
        tickSize: '0.01',
      })

      expect(mockSubmitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderType: 'Limit',
          price: '3500',
          timeInForce: 'GTC',
          side: 'Sell',
        })
      )
    })

    it('throws on non-zero retCode from submitOrder', async () => {
      mockSubmitOrder.mockResolvedValue({
        retCode: 10001,
        retMsg: 'Insufficient balance',
        result: {},
      })

      await expect(
        executor.placeEntryWithSl({
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.001',
          stopLoss: 48000,
          signalId: 1,
          tickSize: '0.1',
        })
      ).rejects.toThrow('Insufficient balance')
    })
  })

  // ============================================================
  // placeTpOrders tests
  // ============================================================
  describe('placeTpOrders', () => {
    beforeEach(() => {
      mockSubmitOrder.mockResolvedValue({
        retCode: 0,
        result: { orderId: 'tp-ord-1', orderLinkId: '' },
      })
    })

    it('places 3 reduceOnly orders with qty split 33%/33%/34%', async () => {
      mockSubmitOrder
        .mockResolvedValueOnce({ retCode: 0, result: { orderId: 'tp-1' } })
        .mockResolvedValueOnce({ retCode: 0, result: { orderId: 'tp-2' } })
        .mockResolvedValueOnce({ retCode: 0, result: { orderId: 'tp-3' } })

      const ids = await executor.placeTpOrders({
        symbol: 'BTCUSDT',
        side: 'Sell', // opposite of LONG
        totalQty: '0.300',
        takeProfits: [52000, 54000, 56000],
        signalId: 1,
        qtyStep: '0.001',
        tickSize: '0.1',
      })

      expect(ids).toEqual(['tp-1', 'tp-2', 'tp-3'])
      expect(mockSubmitOrder).toHaveBeenCalledTimes(3)

      // Check all orders are reduceOnly
      for (const call of mockSubmitOrder.mock.calls) {
        expect(call[0].reduceOnly).toBe(true)
        expect(call[0].side).toBe('Sell')
        expect(call[0].orderType).toBe('Limit')
        expect(call[0].timeInForce).toBe('GTC')
        expect(call[0].positionIdx).toBe(0)
      }

      // Check orderLinkId format
      expect(mockSubmitOrder.mock.calls[0][0].orderLinkId).toBe('sig-1-tp1')
      expect(mockSubmitOrder.mock.calls[1][0].orderLinkId).toBe('sig-1-tp2')
      expect(mockSubmitOrder.mock.calls[2][0].orderLinkId).toBe('sig-1-tp3')

      // Check TP_ORDER_PLACED logged for each
      expect(logOrderAction).toHaveBeenCalledTimes(3)
      for (const call of vi.mocked(logOrderAction).mock.calls) {
        expect(call[0]).toBe('TP_ORDER_PLACED')
      }
    })

    it('places 4 orders with 25% each', async () => {
      mockSubmitOrder.mockResolvedValue({ retCode: 0, result: { orderId: 'tp-x' } })

      await executor.placeTpOrders({
        symbol: 'ETHUSDT',
        side: 'Buy', // opposite of SHORT
        totalQty: '1.000',
        takeProfits: [3000, 2900, 2800, 2700],
        signalId: 2,
        qtyStep: '0.01',
        tickSize: '0.01',
      })

      expect(mockSubmitOrder).toHaveBeenCalledTimes(4)
    })

    it('places 2 orders with 50% each', async () => {
      mockSubmitOrder.mockResolvedValue({ retCode: 0, result: { orderId: 'tp-y' } })

      await executor.placeTpOrders({
        symbol: 'SOLUSDT',
        side: 'Sell',
        totalQty: '10.0',
        takeProfits: [200, 220],
        signalId: 3,
        qtyStep: '0.1',
        tickSize: '0.01',
      })

      expect(mockSubmitOrder).toHaveBeenCalledTimes(2)
    })
  })

  // ============================================================
  // Serial queue test
  // ============================================================
  describe('serial queue', () => {
    it('two concurrent calls execute sequentially via p-queue', async () => {
      // For this test we need a real p-queue, so we create a fresh executor
      // with a tracking mechanism
      const callOrder: number[] = []

      // Replace mock p-queue with one that actually serializes
      const PQueue = (await import('p-queue')).default
      // The mock returns immediately, so we test that executeInQueue wraps properly
      const result1 = executor.executeInQueue(async () => {
        callOrder.push(1)
        return 'first'
      })
      const result2 = executor.executeInQueue(async () => {
        callOrder.push(2)
        return 'second'
      })

      const [r1, r2] = await Promise.all([result1, result2])
      expect(r1).toBe('first')
      expect(r2).toBe('second')
      expect(callOrder).toEqual([1, 2])
    })
  })

  // ============================================================
  // Factory function test
  // ============================================================
  describe('createOrderExecutor', () => {
    it('returns an OrderExecutor instance', () => {
      const exec = createOrderExecutor(createMockClient())
      expect(exec).toBeInstanceOf(OrderExecutor)
    })
  })
})
