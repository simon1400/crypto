import { Trade } from '@prisma/client'
import { prisma } from '../db/prisma'
import { adjustVirtualBalance } from './virtualBalance'
import { calcExitFee } from './fees'

export interface CloseOptions {
  price: number
  percent: number              // 0-100, доля ОТ ТЕКУЩЕГО remaining
  isSL?: boolean               // true если это SL hit
  forceFullClose?: boolean     // true для SL/close-all — закрывает до 100%
  logContext?: string          // для adjustVirtualBalance reason
}

export interface CloseResult {
  updated: Trade
  pnlUsdt: number
  pnlPercent: number
  exitFee: number
  newClosedPct: number
  isFull: boolean
}

/**
 * Считает P&L для закрытия портиона позиции (симметрично для LONG и SHORT).
 * Принимает объект с полями type/entryPrice/leverage/amount.
 * Для `GeneratedSignal` (где поле называется `entry`) — используй computePortionPnlFromEntry.
 */
export function computePortionPnl(
  trade: Pick<Trade, 'type' | 'entryPrice' | 'leverage' | 'amount'>,
  closePrice: number,
  closePct: number,
) {
  return computePortionPnlFromEntry(
    { type: trade.type, entry: trade.entryPrice, leverage: trade.leverage, amount: trade.amount },
    closePrice,
    closePct,
  )
}

/**
 * Core P&L math — работает с generic объектом где поле entry'а называется `entry`.
 * Используется и для Trade (через обёртку computePortionPnl), и для GeneratedSignal.
 */
export function computePortionPnlFromEntry(
  pos: { type: string; entry: number; leverage: number; amount: number },
  closePrice: number,
  closePct: number,
) {
  const direction = pos.type === 'LONG' ? 1 : -1
  const priceDiff = (closePrice - pos.entry) * direction
  const pnlPercent = (priceDiff / pos.entry) * 100 * pos.leverage
  const portionAmount = pos.amount * (closePct / 100)
  const pnlUsdt = portionAmount * (pnlPercent / 100)
  return { direction, pnlPercent, portionAmount, pnlUsdt }
}

/**
 * Trailing SL: после TP1 → SL = entry, после TPn → SL = TP(n-1).
 */
function computeTrailingSl(trade: Trade, closePrice: number, newClosedPct: number): number {
  const tps = (trade.takeProfits as any[]).map((tp: any) => tp.price).sort(
    (a: number, b: number) => (trade.type === 'LONG' ? a - b : b - a),
  )
  // Определяем по цене какой TP закрылся
  let tpHitIndex = tps.findIndex((tp: number) => Math.abs(closePrice - tp) / tp < 0.005)
  if (tpHitIndex === -1) {
    // Fallback: по накопленному closedPct
    tpHitIndex = Math.round(newClosedPct / (100 / tps.length)) - 1
  }

  if (tpHitIndex === 0) return trade.entryPrice
  if (tpHitIndex > 0) return tps[tpHitIndex - 1]
  return trade.stopLoss
}

/**
 * Универсальное закрытие портиона сделки.
 *
 * Используется:
 * - POST /trades/:id/close — частичное/полное ручное закрытие
 * - POST /trades/:id/sl-hit — полное закрытие по SL (isSL + forceFullClose)
 * - POST /trades/close-all — массовое закрытие по рынку (forceFullClose)
 * - scannerTracker — автоматическое закрытие на TP/SL
 *
 * Делает:
 * 1. Считает P&L + exit fee (taker)
 * 2. Списывает/начисляет virtualBalance (возврат маржи + P&L − fee)
 * 3. Записывает запись в trade.closes[]
 * 4. Обновляет trade (status/closedPct/realizedPnl/fees/stopLoss)
 */
export async function closeTradePortion(
  trade: Trade,
  opts: CloseOptions,
): Promise<CloseResult> {
  const { price: closePrice, percent, isSL = false, forceFullClose = false } = opts

  // Для SL/close-all закрываем весь остаток
  const actualPct = forceFullClose ? (100 - trade.closedPct) : percent

  const { pnlPercent, portionAmount, pnlUsdt } = computePortionPnl(trade, closePrice, actualPct)
  const exitFee = await calcExitFee(portionAmount, trade.leverage)

  // Возврат маржи + P&L − fee
  await adjustVirtualBalance(
    portionAmount + pnlUsdt - exitFee,
    opts.logContext ??
      `${isSL ? 'SL' : 'close'} ${trade.coin} #${trade.id} ${actualPct}% pnl=${pnlUsdt.toFixed(2)} fee=${exitFee.toFixed(4)}`,
  )

  const closes = Array.isArray(trade.closes) ? [...(trade.closes as any[])] : []
  closes.push({
    price: closePrice,
    percent: actualPct,
    pnl: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    fee: Math.round(exitFee * 1e6) / 1e6,
    closedAt: new Date().toISOString(),
    ...(isSL && { isSL: true }),
  })

  const newClosedPct = Math.min(100, trade.closedPct + actualPct)
  const newRealizedPnl = Math.round((trade.realizedPnl + pnlUsdt) * 100) / 100
  const newFees = Math.round((trade.fees + exitFee) * 1e6) / 1e6
  const isFull = newClosedPct >= 100

  // Определение нового status
  let newStatus: string
  if (isSL) newStatus = 'SL_HIT'
  else if (isFull) newStatus = 'CLOSED'
  else newStatus = 'PARTIALLY_CLOSED'

  // Trailing SL только для частичного non-SL закрытия
  const newStopLoss = !isFull && !isSL
    ? computeTrailingSl(trade, closePrice, newClosedPct)
    : trade.stopLoss

  const updated = await prisma.trade.update({
    where: { id: trade.id },
    data: {
      closes,
      closedPct: newClosedPct,
      realizedPnl: newRealizedPnl,
      fees: newFees,
      status: newStatus,
      stopLoss: newStopLoss,
      closedAt: isFull || isSL ? new Date() : null,
    },
  })

  return {
    updated,
    pnlUsdt: Math.round(pnlUsdt * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    exitFee: Math.round(exitFee * 1e6) / 1e6,
    newClosedPct,
    isFull,
  }
}

/**
 * Отмена PENDING_ENTRY сделки: возврат зарезервированной entry fee.
 */
export async function cancelPendingTrade(trade: Trade): Promise<Trade> {
  if (trade.fees > 0) {
    await adjustVirtualBalance(trade.fees, `refund pending entry fee #${trade.id}`)
  }
  return prisma.trade.update({
    where: { id: trade.id },
    data: { status: 'CANCELLED', closedAt: new Date() },
  })
}
