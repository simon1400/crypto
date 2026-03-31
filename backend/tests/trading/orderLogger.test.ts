import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma
vi.mock('../../src/db/prisma', () => ({
  prisma: {
    orderLog: {
      create: vi.fn(),
    },
  },
}))

import { prisma } from '../../src/db/prisma'
import { logOrderAction } from '../../src/trading/orderLogger'

const mockCreate = vi.mocked(prisma.orderLog.create)

describe('orderLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({
      id: 1,
      positionId: null,
      signalId: null,
      action: 'ORDER_PLACED',
      details: {},
      createdAt: new Date(),
    } as any)
  })

  it('creates OrderLog record with correct action', async () => {
    await logOrderAction('ORDER_PLACED', {})

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: 'ORDER_PLACED',
        positionId: undefined,
        signalId: undefined,
        details: {},
      },
    })
  })

  it('sets positionId and signalId when provided', async () => {
    await logOrderAction('ORDER_FILLED', {
      positionId: 42,
      signalId: 7,
    })

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: 'ORDER_FILLED',
        positionId: 42,
        signalId: 7,
        details: {},
      },
    })
  })

  it('stores details JSON correctly', async () => {
    const details = {
      orderId: 'bybit-order-123',
      orderType: 'Market',
      qty: '0.05',
      price: '97432.50',
    }

    await logOrderAction('ORDER_PLACED', {
      positionId: 1,
      signalId: 3,
      details,
    })

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: 'ORDER_PLACED',
        positionId: 1,
        signalId: 3,
        details,
      },
    })
  })

  it('handles all action types without error', async () => {
    const actions = [
      'ORDER_PLACED', 'ORDER_FILLED', 'ORDER_CANCELLED',
      'SL_TRIGGERED', 'TP1_HIT', 'POSITION_CLOSED', 'ERROR',
    ] as const

    for (const action of actions) {
      await logOrderAction(action, { positionId: 1 })
    }

    expect(mockCreate).toHaveBeenCalledTimes(actions.length)
  })
})
