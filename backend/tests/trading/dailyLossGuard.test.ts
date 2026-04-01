import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrismaPosition, mockPrismaBotConfig, mockBybitClient } = vi.hoisted(() => ({
  mockPrismaPosition: {
    findMany: vi.fn(),
  },
  mockPrismaBotConfig: {
    findUnique: vi.fn(),
  },
  mockBybitClient: {
    getWalletBalance: vi.fn(),
  },
}))

vi.mock('../../src/db/prisma', () => ({
  prisma: {
    position: mockPrismaPosition,
    botConfig: mockPrismaBotConfig,
  },
}))

vi.mock('../../src/services/bybit', () => ({
  createBybitClient: vi.fn(async () => mockBybitClient),
}))

import { checkDailyLoss, DailyLossCheck } from '../../src/trading/dailyLossGuard'

function mockBalance(balance: string) {
  mockBybitClient.getWalletBalance.mockResolvedValue({
    retCode: 0,
    result: {
      list: [{
        coin: [{ coin: 'USDT', walletBalance: balance }],
      }],
    },
  })
}

function mockConfig(dailyLossLimitPct = 5) {
  mockPrismaBotConfig.findUnique.mockResolvedValue({
    id: 1,
    dailyLossLimitPct,
  })
}

describe('checkDailyLoss', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('returns allowed=true when no closed positions today and no open positions', async () => {
    mockConfig(5)
    mockBalance('1000')
    mockPrismaPosition.findMany.mockResolvedValue([])

    const result = await checkDailyLoss()

    expect(result.allowed).toBe(true)
    expect(result.realizedLossToday).toBe(0)
    expect(result.prospectiveWorstCase).toBe(0)
    expect(result.totalWorstCase).toBe(0)
    expect(result.limitAmount).toBe(50) // 5% of 1000
  })

  it('calculates realizedLossToday as sum of negative realizedPnl from positions closed since midnight', async () => {
    mockConfig(5)
    mockBalance('1000')

    // First call: closed positions today
    mockPrismaPosition.findMany
      .mockResolvedValueOnce([
        { realizedPnl: -20 },
        { realizedPnl: -10 },
        { realizedPnl: 15 }, // win - should NOT reduce loss
      ])
      // Second call: open positions
      .mockResolvedValueOnce([])

    const result = await checkDailyLoss()

    expect(result.realizedLossToday).toBe(-30) // only -20 + -10
    expect(result.totalWorstCase).toBe(30) // |−30| + 0
  })

  it('calculates prospectiveWorstCase from open positions SL distances', async () => {
    mockConfig(5)
    mockBalance('2000')

    mockPrismaPosition.findMany
      .mockResolvedValueOnce([]) // no closed positions today
      .mockResolvedValueOnce([
        { entryPrice: 100, stopLoss: 90, qty: 1, closedPct: 0, status: 'OPEN' },
        { entryPrice: 50, stopLoss: 45, qty: 10, closedPct: 0, status: 'OPEN' },
      ])

    const result = await checkDailyLoss()

    // pos1: 1 * |100 - 90| = 10
    // pos2: 10 * |50 - 45| = 50
    expect(result.prospectiveWorstCase).toBe(60)
    expect(result.totalWorstCase).toBe(60)
  })

  it('returns allowed=false when totalWorstCase >= limitAmount', async () => {
    mockConfig(5)
    mockBalance('1000') // limit = 50

    mockPrismaPosition.findMany
      .mockResolvedValueOnce([{ realizedPnl: -30 }])
      .mockResolvedValueOnce([
        { entryPrice: 100, stopLoss: 80, qty: 1, closedPct: 0, status: 'OPEN' },
      ])

    const result = await checkDailyLoss()

    // realizedLoss = -30, prospective = 1 * 20 = 20, total = 30 + 20 = 50
    expect(result.totalWorstCase).toBe(50)
    expect(result.limitAmount).toBe(50)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeDefined()
  })

  it('returns allowed=true when totalWorstCase < limitAmount', async () => {
    mockConfig(10)
    mockBalance('1000') // limit = 100

    mockPrismaPosition.findMany
      .mockResolvedValueOnce([{ realizedPnl: -20 }])
      .mockResolvedValueOnce([
        { entryPrice: 100, stopLoss: 95, qty: 1, closedPct: 0, status: 'OPEN' },
      ])

    const result = await checkDailyLoss()

    // realizedLoss = -20, prospective = 1 * 5 = 5, total = 25
    expect(result.totalWorstCase).toBe(25)
    expect(result.limitAmount).toBe(100)
    expect(result.allowed).toBe(true)
  })

  it('positions with positive realizedPnl do NOT reduce the realized loss total', async () => {
    mockConfig(5)
    mockBalance('1000')

    mockPrismaPosition.findMany
      .mockResolvedValueOnce([
        { realizedPnl: -40 },
        { realizedPnl: 100 }, // big win — should be ignored
      ])
      .mockResolvedValueOnce([])

    const result = await checkDailyLoss()

    expect(result.realizedLossToday).toBe(-40) // NOT -40 + 100
    expect(result.totalWorstCase).toBe(40)
  })

  it('midnight reset — positions closed yesterday are excluded', async () => {
    vi.useFakeTimers()
    // Set current time to 2026-04-01 10:00:00 local
    vi.setSystemTime(new Date(2026, 3, 1, 10, 0, 0))

    mockConfig(5)
    mockBalance('1000')

    // The findMany call should use gte: todayMidnight
    // We verify by checking what arguments were passed
    mockPrismaPosition.findMany
      .mockResolvedValueOnce([]) // closed today
      .mockResolvedValueOnce([]) // open

    await checkDailyLoss()

    // Check the first findMany was called with correct midnight filter
    const closedQuery = mockPrismaPosition.findMany.mock.calls[0][0]
    const midnightFilter = closedQuery.where.closedAt.gte

    // Should be midnight of 2026-04-01
    const expectedMidnight = new Date(2026, 3, 1, 0, 0, 0, 0)
    expect(midnightFilter.getTime()).toBe(expectedMidnight.getTime())
  })

  it('PARTIALLY_CLOSED positions use remainingQty for prospective calc', async () => {
    mockConfig(5)
    mockBalance('1000')

    mockPrismaPosition.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { entryPrice: 100, stopLoss: 90, qty: 10, closedPct: 60, status: 'PARTIALLY_CLOSED' },
      ])

    const result = await checkDailyLoss()

    // remainingQty = 10 * (1 - 60/100) = 4
    // worstCase = 4 * |100 - 90| = 40
    expect(result.prospectiveWorstCase).toBe(40)
  })
})
