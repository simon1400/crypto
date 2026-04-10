import { prisma } from '../db/prisma'

/**
 * Bybit VIP 0 дефолты (USDT Perpetual)
 * Maker: 0.02% (0.0002)  — лимитный ордер, добавляет ликвидность
 * Taker: 0.055% (0.00055) — market / лимит, который исполняется сразу
 */
export const BYBIT_DEFAULT_FEES = {
  taker: 0.00055,
  maker: 0.0002,
}

export type OrderType = 'market' | 'limit'

/**
 * Получить текущие ставки из BotConfig (на случай если пользователь переопределит).
 */
export async function getFeeRates(): Promise<{ taker: number; maker: number }> {
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  return {
    taker: config?.takerFeeRate ?? BYBIT_DEFAULT_FEES.taker,
    maker: config?.makerFeeRate ?? BYBIT_DEFAULT_FEES.maker,
  }
}

/**
 * Комиссия на конкретной стороне сделки.
 * notional = margin × leverage (размер позиции в USDT)
 *
 * Правило:
 * - Вход market → taker
 * - Вход limit → maker (если исполнился по цене лимита) — на практике принимаем оптимистично
 * - Выход TP/SL на Bybit обычно исполняется как market (taker)
 */
export function calcFeeSync(notional: number, rate: number): number {
  if (!notional || notional <= 0) return 0
  return Math.round(notional * rate * 1e8) / 1e8
}

export async function calcEntryFee(
  margin: number,
  leverage: number,
  orderType: OrderType,
): Promise<number> {
  const rates = await getFeeRates()
  const rate = orderType === 'limit' ? rates.maker : rates.taker
  return calcFeeSync(margin * leverage, rate)
}

/**
 * Fee за выход. TP/SL/close по умолчанию исполняются как market (taker).
 * Если в будущем добавим лимитные закрытия — можно расширить.
 */
export async function calcExitFee(
  closedMargin: number,
  leverage: number,
): Promise<number> {
  const rates = await getFeeRates()
  return calcFeeSync(closedMargin * leverage, rates.taker)
}
