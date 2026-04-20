import { describe, it, expect } from 'vitest'
import { parseSignalUpdate } from '../../src/services/signalUpdateParser'

describe('parseSignalUpdate', () => {
  it('parses trailing stoploss close as TRAILING_WIN', () => {
    const text = `#ALPINE/USDT Closed at trailing stoploss after reaching take profit
Profit: 38.1168%`
    const r = parseSignalUpdate(text)!
    expect(r).not.toBeNull()
    expect(r.coin).toBe('ALPINE')
    expect(r.status).toBe('TRAILING_WIN')
    expect(r.pnlPct).toBe(38.1168)
  })

  it('parses Stop Target Hit as SL_HIT with negative pnl', () => {
    const text = `#KITE/USDT Stop Target Hit
Loss: 40.9725%`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('KITE')
    expect(r.status).toBe('SL_HIT')
    expect(r.pnlPct).toBe(-40.9725)
  })

  it('parses Manually Cancelled with 0% as CANCELLED', () => {
    const text = `#LISTA/USDT Manually Cancelled
Profit: 0.0%
Period: 1 day 3 hr`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('LISTA')
    expect(r.status).toBe('CANCELLED')
    expect(r.pnlPct).toBe(0)
    expect(r.period).toBe('1 day 3 hr')
  })

  it('parses Manually Cancelled with positive profit as MANUAL_WIN', () => {
    const text = `#H/USDT Manually Cancelled
Profit: 73.9807%
Period: 20 hr 38 min`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('H')
    expect(r.status).toBe('MANUAL_WIN')
    expect(r.pnlPct).toBe(73.9807)
    expect(r.period).toBe('20 hr 38 min')
  })

  it('parses Take-Profit target N as TPn_HIT', () => {
    const text = `#ALPINE/USDT Take-Profit target 2 ✅
Profit: 58.6412%
Period: 2 days 8 hr`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('ALPINE')
    expect(r.status).toBe('TP2_HIT')
    expect(r.pnlPct).toBe(58.6412)
  })

  it('returns null for a regular signal message', () => {
    const text = `Scalp Long $MMT (Leverage 7x)
Entry: 0.1261 - 0.1326
TP: 0.1382 - 0.1459
SL: 0.1225`
    expect(parseSignalUpdate(text)).toBeNull()
  })

  it('returns null for unrelated text', () => {
    expect(parseSignalUpdate('hello world')).toBeNull()
  })

  it('parses "Entry target hit" as ACTIVE (limit order fill)', () => {
    const text = '#RAVE/USDT Entry target hit'
    const r = parseSignalUpdate(text)!
    expect(r).not.toBeNull()
    expect(r.coin).toBe('RAVE')
    expect(r.status).toBe('ACTIVE')
    expect(r.pnlPct).toBe(0)
  })

  it('parses "Entry target 1 hit" with target number as ACTIVE', () => {
    const text = '#EDGE/USDT Entry target 1 hit'
    const r = parseSignalUpdate(text)!
    expect(r.status).toBe('ACTIVE')
  })

  it('parses "Entry filled" as ACTIVE', () => {
    const text = '#SIGN/USDT Entry filled'
    const r = parseSignalUpdate(text)!
    expect(r.status).toBe('ACTIVE')
  })

  it('parses ETG "Entry 1" partial fill with avg entry', () => {
    const text = `#ZRO/USDT Entry 1 ✅
Average Entry Price: 1.579`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('ZRO')
    expect(r.status).toBe('ACTIVE')
    expect(r.averageEntry).toBe(1.579)
    expect(r.allEntriesAchieved).toBeUndefined()
  })

  it('parses ETG "All entries achieved" as ACTIVE with avg entry + flag', () => {
    const text = `#ORDI/USDT All entries achieved
Average Entry Price: 4.76`
    const r = parseSignalUpdate(text)!
    expect(r.coin).toBe('ORDI')
    expect(r.status).toBe('ACTIVE')
    expect(r.averageEntry).toBe(4.76)
    expect(r.allEntriesAchieved).toBe(true)
  })
})
