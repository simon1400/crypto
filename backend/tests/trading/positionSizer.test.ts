import { describe, it, expect } from 'vitest'
import { calculatePositionQty, alignToTickSize } from '../../src/trading/positionSizer'
import { InstrumentInfo } from '../../src/trading/types'

function makeInstrument(overrides: Partial<InstrumentInfo> = {}): InstrumentInfo {
  return {
    symbol: 'BTCUSDT',
    minOrderQty: '0.001',
    qtyStep: '0.001',
    tickSize: '0.01',
    ...overrides,
  }
}

describe('positionSizer', () => {
  describe('calculatePositionQty', () => {
    it('calculates correct qty: balance=1000, pct=10, entry=50000, lev=10, step=0.001', () => {
      // margin = 1000 * 10 / 100 = 100
      // notional = 100 * 10 = 1000
      // qty = 1000 / 50000 = 0.02
      const result = calculatePositionQty('1000', 10, 50000, 10, makeInstrument())
      expect(result).toBe('0.02')
    })

    it('calculates correct qty: balance=500, pct=5, entry=0.5, lev=20, step=1', () => {
      // margin = 500 * 5 / 100 = 25
      // notional = 25 * 20 = 500
      // qty = 500 / 0.5 = 1000
      const result = calculatePositionQty('500', 5, 0.5, 20, makeInstrument({
        qtyStep: '1',
        minOrderQty: '1',
      }))
      expect(result).toBe('1000')
    })

    it('throws when qty < minOrderQty', () => {
      // margin = 10 * 1 / 100 = 0.1
      // notional = 0.1 * 1 = 0.1
      // qty = 0.1 / 50000 = 0.000002 -> floored to 0 (step 0.001)
      expect(() =>
        calculatePositionQty('10', 1, 50000, 1, makeInstrument())
      ).toThrow('Position too small')
    })

    it('floors to qtyStep correctly (0.0234 with step 0.001 -> 0.023)', () => {
      // margin = 1170 * 10 / 100 = 117
      // notional = 117 * 10 = 1170
      // qty = 1170 / 50000 = 0.0234
      // floored to step 0.001 -> 0.023
      const result = calculatePositionQty('1170', 10, 50000, 10, makeInstrument())
      expect(result).toBe('0.023')
    })

    it('handles large qty with small step correctly', () => {
      // margin = 10000 * 50 / 100 = 5000
      // notional = 5000 * 100 = 500000
      // qty = 500000 / 0.01 = 50000000
      const result = calculatePositionQty('10000', 50, 0.01, 100, makeInstrument({
        qtyStep: '1',
        minOrderQty: '1',
      }))
      expect(result).toBe('50000000')
    })
  })

  describe('alignToTickSize', () => {
    it('floors price to tick size', () => {
      expect(alignToTickSize(97432.57, '0.1', 'floor')).toBe('97432.5')
    })

    it('ceils price to tick size', () => {
      expect(alignToTickSize(97432.51, '0.1', 'ceil')).toBe('97432.6')
    })

    it('handles exact tick alignment', () => {
      expect(alignToTickSize(97432.5, '0.1', 'floor')).toBe('97432.5')
      expect(alignToTickSize(97432.5, '0.1', 'ceil')).toBe('97432.5')
    })
  })
})
