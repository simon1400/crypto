import { describe, it, expect } from 'vitest'
import { parseSignalMessage, extractCategory } from '../../src/services/signalParser'

describe('extractCategory', () => {
  it('extracts "risk-scalp" from Risk Scalp signals', () => {
    expect(extractCategory('Risk Scalp Long $BEAT (Max 3x)')).toBe('risk-scalp')
  })

  it('extracts "scalp" from Scalp signals', () => {
    expect(extractCategory('Scalp Short $MIRA (Leverage 10x)')).toBe('scalp')
  })

  it('extracts "swing" from Swing signals', () => {
    expect(extractCategory('Swing Long $BTC (Max 5x)')).toBe('swing')
  })

  it('returns null for SPOT signals (no category)', () => {
    expect(extractCategory('SPOT $CLANKER')).toBeNull()
  })

  it('returns null for text without category', () => {
    expect(extractCategory('Some random text without category')).toBeNull()
  })
})

describe('parseSignalMessage with category', () => {
  it('includes category field in parsed result', () => {
    const text = 'Risk Scalp Long $BEAT (Max 3x)\nEntry: 0.50\nSL: 0.45\nTP: 0.55 - 0.60'
    const result = parseSignalMessage(text)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('risk-scalp')
    expect(result!.coin).toBe('BEAT')
    expect(result!.type).toBe('LONG')
  })

  it('sets category to undefined for SPOT signals', () => {
    const text = 'SPOT $CLANKER\nEntry: 0.10\nSL: 0.08\nTP: 0.12 - 0.15'
    const result = parseSignalMessage(text)
    expect(result).not.toBeNull()
    expect(result!.category).toBeUndefined()
  })

  it('sets category for Scalp Short signals', () => {
    const text = 'Scalp Short $MIRA (Leverage 10x)\nEntry: 1.20\nSL: 1.30\nTP: 1.10 - 1.00'
    const result = parseSignalMessage(text)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('scalp')
  })
})
