import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getInstrumentInfo, clearInstrumentCache } from '../../src/trading/instrumentCache'

// Create a mock client
function createMockClient() {
  return {
    getInstrumentsInfo: vi.fn(),
  } as any
}

describe('instrumentCache', () => {
  beforeEach(() => {
    clearInstrumentCache()
  })

  it('fetches from Bybit API and caches result', async () => {
    const client = createMockClient()
    client.getInstrumentsInfo.mockResolvedValue({
      retCode: 0,
      result: {
        list: [{
          symbol: 'BTCUSDT',
          lotSizeFilter: {
            qtyStep: '0.001',
            minOrderQty: '0.001',
          },
          priceFilter: {
            tickSize: '0.01',
          },
        }],
      },
    })

    const info = await getInstrumentInfo(client, 'BTCUSDT')
    expect(info).toEqual({
      symbol: 'BTCUSDT',
      minOrderQty: '0.001',
      qtyStep: '0.001',
      tickSize: '0.01',
    })
    expect(client.getInstrumentsInfo).toHaveBeenCalledTimes(1)
    expect(client.getInstrumentsInfo).toHaveBeenCalledWith({
      category: 'linear',
      symbol: 'BTCUSDT',
    })
  })

  it('returns cached result on second call (no API call)', async () => {
    const client = createMockClient()
    client.getInstrumentsInfo.mockResolvedValue({
      retCode: 0,
      result: {
        list: [{
          symbol: 'ETHUSDT',
          lotSizeFilter: {
            qtyStep: '0.01',
            minOrderQty: '0.01',
          },
          priceFilter: {
            tickSize: '0.01',
          },
        }],
      },
    })

    await getInstrumentInfo(client, 'ETHUSDT')
    const info2 = await getInstrumentInfo(client, 'ETHUSDT')
    expect(info2.symbol).toBe('ETHUSDT')
    expect(client.getInstrumentsInfo).toHaveBeenCalledTimes(1)
  })

  it('returns correct fields from API response', async () => {
    const client = createMockClient()
    client.getInstrumentsInfo.mockResolvedValue({
      retCode: 0,
      result: {
        list: [{
          symbol: 'DOGEUSDT',
          lotSizeFilter: {
            qtyStep: '1',
            minOrderQty: '1',
          },
          priceFilter: {
            tickSize: '0.00001',
          },
        }],
      },
    })

    const info = await getInstrumentInfo(client, 'DOGEUSDT')
    expect(info.symbol).toBe('DOGEUSDT')
    expect(info.qtyStep).toBe('1')
    expect(info.minOrderQty).toBe('1')
    expect(info.tickSize).toBe('0.00001')
  })

  it('throws on API error', async () => {
    const client = createMockClient()
    client.getInstrumentsInfo.mockResolvedValue({
      retCode: 10001,
      retMsg: 'Invalid symbol',
      result: { list: [] },
    })

    await expect(getInstrumentInfo(client, 'INVALID')).rejects.toThrow()
  })
})
