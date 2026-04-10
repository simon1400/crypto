import { prisma } from '../db/prisma'
import { getVirtualBalance, getVirtualBalanceInfo } from './virtualBalance'
import { calcEntryFee, OrderType } from './fees'

export class BudgetError extends Error {
  constructor(
    message: string,
    public readonly balance: number,
    public readonly usedMargin: number,
    public readonly requested: number,
  ) {
    super(message)
    this.name = 'BudgetError'
  }
}

/**
 * Считает сумму маржи по активным сделкам (OPEN/PENDING_ENTRY/PARTIALLY_CLOSED).
 * Частично закрытые — только остаток.
 */
export async function getUsedMargin(): Promise<number> {
  const trades = await prisma.trade.findMany({
    where: { status: { in: ['OPEN', 'PENDING_ENTRY', 'PARTIALLY_CLOSED'] } },
    select: { amount: true, closedPct: true, status: true },
  })

  let used = 0
  for (const t of trades) {
    const remainingPct = t.status === 'PENDING_ENTRY' ? 100 : (100 - t.closedPct)
    used += t.amount * (remainingPct / 100)
  }
  return Math.round(used * 100) / 100
}

export interface BudgetStatus {
  balance: number        // виртуальный баланс
  used: number           // маржа в рынке
  available: number      // balance - used
  start: number          // стартовый депозит
  pnl: number            // общий P&L относительно старта
  roiPct: number
}

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const [info, used] = await Promise.all([getVirtualBalanceInfo(), getUsedMargin()])
  return {
    balance: info.balance,
    used,
    available: Math.round((info.balance - used) * 100) / 100,
    start: info.start,
    pnl: info.pnl,
    roiPct: info.roiPct,
  }
}

/**
 * Проверяет, можно ли открыть сделку с заданной маржой и плечом.
 * Учитывает entry fee (market → taker, limit → maker).
 * Кидает BudgetError при нехватке.
 */
export async function assertBudget(
  newAmount: number,
  leverage: number = 1,
  orderType: OrderType = 'market',
): Promise<{ entryFee: number }> {
  const balance = await getVirtualBalance()
  const used = await getUsedMargin()
  const available = balance - used

  const entryFee = await calcEntryFee(newAmount, leverage, orderType)
  const totalNeeded = newAmount + entryFee

  if (totalNeeded > available) {
    throw new BudgetError(
      `Недостаточно бюджета: свободно $${available.toFixed(2)} из $${balance.toFixed(2)} ` +
        `(занято $${used.toFixed(2)}), запрошено $${newAmount.toFixed(2)} + fee $${entryFee.toFixed(2)}`,
      balance,
      used,
      newAmount,
    )
  }

  return { entryFee }
}
