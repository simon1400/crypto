import Decimal from 'decimal.js'
import { InstrumentInfo } from './types'

/**
 * Calculate position quantity in base coin.
 *
 * Formula: qty = (balance * positionSizePct / 100 * leverage) / entryPrice
 * Then floor to instrument's qtyStep and validate against minOrderQty.
 *
 * All arithmetic uses decimal.js to avoid IEEE 754 errors.
 */
export function calculatePositionQty(
  balanceUsdt: string,
  positionSizePct: number,
  entryPrice: number,
  leverage: number,
  instrument: InstrumentInfo
): string {
  const balance = new Decimal(balanceUsdt)
  const margin = balance.times(positionSizePct).div(100)
  const notional = margin.times(leverage)
  const qty = notional.div(entryPrice)

  // Floor to instrument's qtyStep
  const step = new Decimal(instrument.qtyStep)
  const floored = qty.div(step).floor().times(step)

  // Check minimum order quantity
  const minQty = new Decimal(instrument.minOrderQty)
  if (floored.lt(minQty)) {
    throw new Error(
      `Position too small: ${floored.toString()} < min ${minQty.toString()}`
    )
  }

  return floored.toString()
}

/**
 * Align a price to the instrument's tick size.
 *
 * direction: 'floor' rounds down, 'ceil' rounds up.
 * Returns aligned price as string.
 */
export function alignToTickSize(
  price: number,
  tickSize: string,
  direction: 'floor' | 'ceil'
): string {
  const tick = new Decimal(tickSize)
  const p = new Decimal(price)

  if (direction === 'floor') {
    return p.div(tick).floor().times(tick).toString()
  }
  return p.div(tick).ceil().times(tick).toString()
}
