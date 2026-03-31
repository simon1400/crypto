import { describe, it, expect, vi, beforeEach } from 'vitest'

// Set env before imports
process.env.ENCRYPTION_SECRET = 'test-secret-key-for-unit-tests'

const mockGetWalletBalance = vi.fn()

// Mock bybit-api with a real constructor function
vi.mock('bybit-api', () => {
  const MockClient = vi.fn(function (this: any) {
    this.getWalletBalance = mockGetWalletBalance
  })
  return { RestClientV5: MockClient }
})

// Mock prisma
vi.mock('../../src/db/prisma', () => ({
  prisma: {
    botConfig: {
      findUnique: vi.fn(),
    },
  },
}))

import { RestClientV5 } from 'bybit-api'
import { prisma } from '../../src/db/prisma'
import { encrypt } from '../../src/services/encryption'
import { createBybitClient, validateBybitKeys } from '../../src/services/bybit'

const MockRestClientV5 = vi.mocked(RestClientV5)
const mockFindUnique = vi.mocked(prisma.botConfig.findUnique)

describe('bybit service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createBybitClient', () => {
    it('reads BotConfig from DB, decrypts keys, returns RestClientV5', async () => {
      const encKey = encrypt('test-api-key')
      const encSecret = encrypt('test-api-secret')

      mockFindUnique.mockResolvedValue({
        id: 1,
        apiKey: encKey,
        apiSecret: encSecret,
        useTestnet: true,
        positionSizePct: 10,
        dailyLossLimitPct: 5,
        orderTtlMinutes: 60,
        tradingMode: 'manual',
        near512Topics: '[]',
        eveningTraderCategories: '[]',
        updatedAt: new Date(),
        createdAt: new Date(),
      })

      const client = await createBybitClient()
      expect(client).toBeDefined()
      expect(MockRestClientV5).toHaveBeenCalledWith({
        key: 'test-api-key',
        secret: 'test-api-secret',
        testnet: true,
      })
    })

    it('throws when no config exists', async () => {
      mockFindUnique.mockResolvedValue(null)
      await expect(createBybitClient()).rejects.toThrow('Bybit API keys not configured')
    })

    it('throws when apiKey is null', async () => {
      mockFindUnique.mockResolvedValue({
        id: 1,
        apiKey: null,
        apiSecret: null,
        useTestnet: true,
        positionSizePct: 10,
        dailyLossLimitPct: 5,
        orderTtlMinutes: 60,
        tradingMode: 'manual',
        near512Topics: '[]',
        eveningTraderCategories: '[]',
        updatedAt: new Date(),
        createdAt: new Date(),
      })
      await expect(createBybitClient()).rejects.toThrow('Bybit API keys not configured')
    })
  })

  describe('validateBybitKeys', () => {
    it('returns valid true with balance on success', async () => {
      mockGetWalletBalance.mockResolvedValue({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [{
            coin: [{ coin: 'USDT', walletBalance: '1234.56' }],
          }],
        },
      })

      const result = await validateBybitKeys('key', 'secret', true)
      expect(result).toEqual({ valid: true, balance: '1234.56' })
      expect(MockRestClientV5).toHaveBeenCalledWith({
        key: 'key',
        secret: 'secret',
        testnet: true,
      })
    })

    it('returns valid false with error on auth failure', async () => {
      mockGetWalletBalance.mockResolvedValue({
        retCode: 10003,
        retMsg: 'Invalid api key',
        result: { list: [] },
      })

      const result = await validateBybitKeys('bad-key', 'bad-secret', false)
      expect(result).toEqual({ valid: false, error: 'Invalid api key' })
    })

    it('passes testnet flag to RestClientV5 constructor', async () => {
      mockGetWalletBalance.mockResolvedValue({
        retCode: 0,
        retMsg: 'OK',
        result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '0' }] }] },
      })

      await validateBybitKeys('key', 'secret', false)
      expect(MockRestClientV5).toHaveBeenCalledWith({
        key: 'key',
        secret: 'secret',
        testnet: false,
      })
    })

    it('returns valid false on connection error', async () => {
      mockGetWalletBalance.mockRejectedValue(new Error('Connection failed'))

      const result = await validateBybitKeys('key', 'secret', true)
      expect(result).toEqual({ valid: false, error: 'Connection failed' })
    })
  })
})
