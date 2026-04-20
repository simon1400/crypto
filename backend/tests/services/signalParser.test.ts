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

describe('ETG x CSF Copytrading compact format', () => {
  it('parses Scalp Long with leverage + TP range', () => {
    const text = `Scalp Long $MMT (Leverage 7x)
Entry: 0.1261 - 0.1326
TP: 0.1382 - 0.1459 - 0.1546 - 0.1642
SL: 0.1225`
    const r = parseSignalMessage(text)!
    expect(r).not.toBeNull()
    expect(r.type).toBe('LONG')
    expect(r.coin).toBe('MMT')
    expect(r.leverage).toBe(7)
    expect(r.entryMin).toBe(0.1261)
    expect(r.entryMax).toBe(0.1326)
    expect(r.takeProfits).toEqual([0.1382, 0.1459, 0.1546, 0.1642])
    expect(r.stopLoss).toBe(0.1225)
    expect(r.category).toBe('scalp')
  })

  it('parses Scalp Short $ZRO', () => {
    const text = `Scalp Short $ZRO (Leverage 5x)
Entry: 1.579 - 1.690
TP: 1.454 - 1.307 - 1.220 - 1.119 - 0.936
SL: 1.775`
    const r = parseSignalMessage(text)!
    expect(r.type).toBe('SHORT')
    expect(r.coin).toBe('ZRO')
    expect(r.leverage).toBe(5)
    expect(r.takeProfits).toHaveLength(5)
    expect(r.stopLoss).toBe(1.775)
  })

  it('parses Risk Limit Scalp Short with category', () => {
    const text = `Risk Limit Scalp Short $RAVE (Leverage 4x)
Entry: 19.9572 - 21.6700
TP: 18.1865 - 15.6200 - 10.8900 - 7.9933
SL: 23.0000`
    const r = parseSignalMessage(text)!
    expect(r.coin).toBe('RAVE')
    expect(r.category).toBe('risk-limit-scalp')
  })

  it('parses Limit Scalp Short $EDGE', () => {
    const text = `Limit Scalp Short $EDGE (Leverage 4x)
Entry: 1.3253 - 1.4136
TP: 1.2135 - 1.0949 - 0.9204 - 0.6985
SL: 1.4980`
    const r = parseSignalMessage(text)!
    expect(r.category).toBe('limit-scalp')
    expect(r.type).toBe('SHORT')
  })

  it('handles multi-ticker like $1000PEPE - $PEPE (picks last)', () => {
    const text = `Limit Scalp Long $1000PEPE - $PEPE (Leverage 7x)
Entry: 0.003607 - 0.003784
TP: 0.004007 - 0.004279 - 0.004555 - 0.004931 - 0.005688
SL: 0.003480`
    const r = parseSignalMessage(text)!
    expect(r.coin).toBe('PEPE')
    expect(r.type).toBe('LONG')
  })
})

describe('ETG full format with numbered TPs', () => {
  it('parses #ETH / USDT – LONG with TP1..TP4', () => {
    const text = `🟢 #ETH / USDT – LONG
⚡ 20x Leverage
📍 Entry: 2,325.82 – 2,363.06

🎯 Targets:
TP1: 2,401.83
TP2: 2,466.56
TP3: 2,522.26
TP4: 2,582.92

🛑 Stop Loss: 2,287.30
⚠️ Risk maximum 5% of your account.`
    const r = parseSignalMessage(text)!
    expect(r).not.toBeNull()
    expect(r.type).toBe('LONG')
    expect(r.coin).toBe('ETH')
    expect(r.leverage).toBe(20)
    expect(r.entryMin).toBe(2325.82)
    expect(r.entryMax).toBe(2363.06)
    expect(r.takeProfits).toEqual([2401.83, 2466.56, 2522.26, 2582.92])
    expect(r.stopLoss).toBe(2287.30)
  })
})

describe('status update messages are rejected', () => {
  it('rejects "Closed at trailing stoploss"', () => {
    const text = `#ALPINE/USDT Closed at trailing stoploss after reaching take profit
Profit: 38.1168%`
    expect(parseSignalMessage(text)).toBeNull()
  })

  it('rejects "Stop Target Hit"', () => {
    const text = `#KITE/USDT Stop Target Hit
Loss: 40.9725%`
    expect(parseSignalMessage(text)).toBeNull()
  })

  it('rejects "Manually Cancelled"', () => {
    const text = `#LISTA/USDT Manually Cancelled
Profit: 0.0%
Period: 1 day 3 hr`
    expect(parseSignalMessage(text)).toBeNull()
  })

  it('rejects "Take-Profit target 2"', () => {
    const text = `#ALPINE/USDT Take-Profit target 2 ✅
Profit: 58.6412%
Period: 2 days 8 hr`
    expect(parseSignalMessage(text)).toBeNull()
  })
})
