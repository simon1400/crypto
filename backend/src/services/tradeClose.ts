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
  // Lifecycle context
  exitReason?: string          // INITIAL_STOP, BE_STOP, TRAILING_STOP, TIME_STOP, MANUAL_EXIT, TP1_PARTIAL, etc.
  tpNumber?: number            // which TP was hit (1, 2, 3)
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
 * Returns: { newStopLoss, stopMovedToBe, trailingActivated, stopMoveReason }
 */
function computeTrailingSl(trade: Trade, closePrice: number, newClosedPct: number): {
  newStopLoss: number
  stopMovedToBe: boolean
  trailingActivated: boolean
  stopMoveReason: string | null
} {
  const tps = (trade.takeProfits as any[]).map((tp: any) => tp.price).sort(
    (a: number, b: number) => (trade.type === 'LONG' ? a - b : b - a),
  )
  let tpHitIndex = tps.findIndex((tp: number) => Math.abs(closePrice - tp) / tp < 0.005)
  if (tpHitIndex === -1) {
    tpHitIndex = Math.round(newClosedPct / (100 / tps.length)) - 1
  }

  if (tpHitIndex === 0) {
    return {
      newStopLoss: trade.entryPrice,
      stopMovedToBe: true,
      trailingActivated: false,
      stopMoveReason: `TP1 hit → SL moved to BE ($${trade.entryPrice})`,
    }
  }
  if (tpHitIndex > 0) {
    return {
      newStopLoss: tps[tpHitIndex - 1],
      stopMovedToBe: true,
      trailingActivated: true,
      stopMoveReason: `TP${tpHitIndex + 1} hit → SL trailing to TP${tpHitIndex} ($${tps[tpHitIndex - 1]})`,
    }
  }
  return {
    newStopLoss: trade.stopLoss,
    stopMovedToBe: false,
    trailingActivated: false,
    stopMoveReason: null,
  }
}

/**
 * Determine exit reason from context
 */
function resolveExitReason(opts: CloseOptions, trade: Trade, tpsHitCount: number): string {
  if (opts.exitReason) return opts.exitReason
  if (opts.isSL) {
    if (tpsHitCount > 0) {
      if (trade.stopMovedToBe && !trade.trailingActivated) return 'BE_STOP'
      if (trade.trailingActivated) return 'TRAILING_STOP'
    }
    return 'INITIAL_STOP'
  }
  if (opts.tpNumber === 1) return 'TP1_PARTIAL'
  if (opts.tpNumber === 2) return 'TP2_PARTIAL'
  if (opts.tpNumber === 3) return 'TP3_FINAL'
  return 'MANUAL_EXIT'
}

/**
 * Универсальное закрытие портиона сделки.
 * Now also populates lifecycle tracking fields.
 */
export async function closeTradePortion(
  trade: Trade,
  opts: CloseOptions,
): Promise<CloseResult> {
  const { price: closePrice, percent, isSL = false, forceFullClose = false } = opts

  const actualPct = forceFullClose ? (100 - trade.closedPct) : percent

  const { pnlPercent, portionAmount, pnlUsdt } = computePortionPnl(trade, closePrice, actualPct)
  const exitFee = await calcExitFee(portionAmount, trade.leverage)

  // P&L − fee (маржа не трогаем — она освобождается через getUsedMargin при смене статуса)
  await adjustVirtualBalance(
    pnlUsdt - exitFee,
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

  // Determine status
  let newStatus: string
  if (isSL) newStatus = 'SL_HIT'
  else if (isFull) newStatus = 'CLOSED'
  else newStatus = 'PARTIALLY_CLOSED'

  // === Trailing SL + lifecycle tracking ===
  let trailingData: Record<string, any> = {}

  if (!isFull && !isSL) {
    const trailing = computeTrailingSl(trade, closePrice, newClosedPct)
    trailingData = {
      stopLoss: trailing.newStopLoss,
      currentStop: trailing.newStopLoss,
    }
    if (trailing.stopMovedToBe && !trade.stopMovedToBe) {
      trailingData.stopMovedToBe = true
      trailingData.stopMoveReason = trailing.stopMoveReason
    }
    if (trailing.trailingActivated && !trade.trailingActivated) {
      trailingData.trailingActivated = true
      trailingData.trailingActivationTime = new Date()
    }
  }

  // TP hit timestamps
  const tpTimestamps: Record<string, any> = {}
  if (opts.tpNumber === 1 && !trade.tp1HitTimestamp) tpTimestamps.tp1HitTimestamp = new Date()
  if (opts.tpNumber === 2 && !trade.tp2HitTimestamp) tpTimestamps.tp2HitTimestamp = new Date()
  if (opts.tpNumber === 3 && !trade.tp3HitTimestamp) tpTimestamps.tp3HitTimestamp = new Date()

  // Exit reason and time in trade
  const closedData: Record<string, any> = {}
  if (isFull || isSL) {
    const tpsHitBefore = closes.filter((c: any) => !c.isSL).length
    closedData.exitReason = resolveExitReason(opts, trade, tpsHitBefore)
    closedData.closedAt = new Date()
    // Time in trade
    const openTime = trade.openedAt?.getTime() || trade.createdAt.getTime()
    closedData.timeInTradeMin = Math.round((Date.now() - openTime) / 60000)
  }

  const updated = await prisma.trade.update({
    where: { id: trade.id },
    data: {
      closes,
      closedPct: newClosedPct,
      realizedPnl: newRealizedPnl,
      fees: newFees,
      status: newStatus,
      stopLoss: trailingData.stopLoss ?? trade.stopLoss,
      ...trailingData,
      ...tpTimestamps,
      ...closedData,
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
export async function cancelPendingTrade(trade: Trade, reason?: string): Promise<Trade> {
  if (trade.fees > 0) {
    await adjustVirtualBalance(trade.fees, `refund pending entry fee #${trade.id}`)
  }
  return prisma.trade.update({
    where: { id: trade.id },
    data: {
      status: 'CANCELLED',
      closedAt: new Date(),
      exitReason: reason || 'MANUAL_CANCEL',
    },
  })
}
