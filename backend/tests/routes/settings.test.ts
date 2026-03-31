import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

process.env.ENCRYPTION_SECRET = 'test-secret-key-for-unit-tests'

const mockGetWalletBalance = vi.fn()

vi.mock('bybit-api', () => {
  const MockClient = vi.fn(function (this: any) {
    this.getWalletBalance = mockGetWalletBalance
  })
  return { RestClientV5: MockClient }
})

vi.mock('../../src/db/prisma', () => ({
  prisma: {
    botConfig: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('../../src/services/bybit', () => ({
  createBybitClient: vi.fn(),
  validateBybitKeys: vi.fn(),
}))

import { prisma } from '../../src/db/prisma'
import { createBybitClient, validateBybitKeys } from '../../src/services/bybit'
import { encrypt } from '../../src/services/encryption'

const mockPrismaUpsert = vi.mocked(prisma.botConfig.upsert)
const mockPrismaFindUnique = vi.mocked(prisma.botConfig.findUnique)
const mockValidateBybitKeys = vi.mocked(validateBybitKeys)
const mockCreateBybitClient = vi.mocked(createBybitClient)

function makeDefaultConfig(overrides: any = {}) {
  return {
    id: 1,
    apiKey: null as string | null,
    apiSecret: null as string | null,
    useTestnet: true,
    positionSizePct: 10,
    dailyLossLimitPct: 5,
    orderTtlMinutes: 60,
    tradingMode: 'manual',
    near512Topics: '[]',
    eveningTraderCategories: '[]',
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  }
}

async function createApp() {
  const { default: settingsRouter } = await import('../../src/routes/settings')
  const app = express()
  app.use(express.json())
  app.use('/api/settings', settingsRouter)
  return app
}

describe('settings routes', () => {
  let app: express.Express

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await createApp()
  })

  describe('GET /api/settings', () => {
    it('returns config with masked keys and hasKeys boolean', async () => {
      const encKey = encrypt('my-api-key-12345678')
      const encSecret = encrypt('my-secret-12345678')
      mockPrismaUpsert.mockResolvedValue(makeDefaultConfig({
        apiKey: encKey,
        apiSecret: encSecret,
      }))

      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.hasKeys).toBe(true)
      expect(res.body.apiKeyMasked).toBe('my-***678')
      expect(res.body.apiSecretMasked).toBe('my-***678')
      expect(res.body.useTestnet).toBe(true)
      expect(res.body.tradingMode).toBe('manual')
    })

    it('returns defaults when no config exists (upserts id:1)', async () => {
      mockPrismaUpsert.mockResolvedValue(makeDefaultConfig())

      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.hasKeys).toBe(false)
      expect(res.body.apiKeyMasked).toBeNull()
      expect(res.body.apiSecretMasked).toBeNull()
      expect(res.body.positionSizePct).toBe(10)
      expect(res.body.dailyLossLimitPct).toBe(5)
      expect(res.body.orderTtlMinutes).toBe(60)
    })
  })

  describe('PUT /api/settings', () => {
    it('with new keys validates via Bybit, encrypts, and saves', async () => {
      mockValidateBybitKeys.mockResolvedValue({ valid: true, balance: '500.00' })
      // Return config with properly encrypted keys (as upsert would after encrypt)
      mockPrismaUpsert.mockResolvedValue(makeDefaultConfig({
        apiKey: encrypt('new-key-12345'),
        apiSecret: encrypt('new-secret-12345'),
      }))

      const res = await request(app)
        .put('/api/settings')
        .send({
          apiKey: 'new-key-12345',
          apiSecret: 'new-secret-12345',
          useTestnet: true,
        })
      expect(res.status).toBe(200)
      expect(mockValidateBybitKeys).toHaveBeenCalledWith('new-key-12345', 'new-secret-12345', true)
    })

    it('with apiKey=null does NOT overwrite existing encrypted keys', async () => {
      const existingConfig = makeDefaultConfig({
        apiKey: encrypt('existing-key-12345'),
        apiSecret: encrypt('existing-secret-12345'),
      })
      mockPrismaUpsert.mockResolvedValue(existingConfig)

      const res = await request(app)
        .put('/api/settings')
        .send({
          apiKey: null,
          positionSizePct: 15,
        })
      expect(res.status).toBe(200)
      expect(mockValidateBybitKeys).not.toHaveBeenCalled()
    })

    it('with invalid keys returns error but still saves non-key settings', async () => {
      mockValidateBybitKeys.mockResolvedValue({ valid: false, error: 'Invalid api key' })
      mockPrismaUpsert.mockResolvedValue(makeDefaultConfig())

      const res = await request(app)
        .put('/api/settings')
        .send({
          apiKey: 'bad-key',
          apiSecret: 'bad-secret',
          positionSizePct: 20,
          useTestnet: true,
        })
      expect(res.body.keyValidationFailed).toBe(true)
      expect(mockPrismaUpsert).toHaveBeenCalled()
    })

    it('validates positionSizePct is 1-50', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ positionSizePct: 60 })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('positionSizePct')
    })

    it('validates dailyLossLimitPct is 1-30', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ dailyLossLimitPct: 50 })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('dailyLossLimitPct')
    })

    it('validates orderTtlMinutes is 5-1440', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ orderTtlMinutes: 2 })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('orderTtlMinutes')
    })

    it('validates tradingMode must be manual or auto', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ tradingMode: 'invalid' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('tradingMode')
    })
  })

  describe('GET /api/settings/balance', () => {
    it('fetches fresh balance from Bybit', async () => {
      const mockClient = {
        getWalletBalance: vi.fn().mockResolvedValue({
          retCode: 0,
          result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '999.99' }] }] },
        }),
      }
      mockCreateBybitClient.mockResolvedValue(mockClient as any)

      const res = await request(app).get('/api/settings/balance')
      expect(res.status).toBe(200)
      expect(res.body.balance).toBe('999.99')
    })

    it('returns error when no keys configured', async () => {
      mockCreateBybitClient.mockRejectedValue(new Error('Bybit API keys not configured'))

      const res = await request(app).get('/api/settings/balance')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('not configured')
    })
  })
})
