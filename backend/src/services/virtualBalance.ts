import { prisma } from '../db/prisma'

/**
 * Виртуальный баланс для симуляции торговли.
 * Весь P&L, fees и funding изменяют это значение.
 * Реальный Bybit баланс не трогаем — он только для справки.
 */

export interface VirtualBalanceInfo {
  balance: number        // текущий виртуальный баланс
  start: number          // стартовый депозит
  startedAt: string      // когда запущена симуляция
  pnl: number            // balance - start
  roiPct: number         // (balance / start - 1) * 100
}

export async function getVirtualBalanceInfo(): Promise<VirtualBalanceInfo> {
  const config = await prisma.botConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  })

  const balance = config.virtualBalance
  const start = config.virtualBalanceStart
  const pnl = balance - start
  const roiPct = start > 0 ? ((balance / start) - 1) * 100 : 0

  return {
    balance: Math.round(balance * 100) / 100,
    start: Math.round(start * 100) / 100,
    startedAt: config.virtualStartedAt.toISOString(),
    pnl: Math.round(pnl * 100) / 100,
    roiPct: Math.round(roiPct * 100) / 100,
  }
}

export async function getVirtualBalance(): Promise<number> {
  const config = await prisma.botConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  })
  return config.virtualBalance
}

/**
 * Атомарная корректировка виртуального баланса.
 * delta > 0 — начисление (P&L+, funding получен, возврат маржи)
 * delta < 0 — списание (fee, loss, funding платим)
 */
export async function adjustVirtualBalance(delta: number, reason?: string): Promise<number> {
  if (delta === 0) {
    const current = await getVirtualBalance()
    return current
  }

  const updated = await prisma.botConfig.update({
    where: { id: 1 },
    data: {
      virtualBalance: { increment: delta },
    },
  })

  if (reason) {
    const sign = delta >= 0 ? '+' : ''
    console.log(`[VirtualBalance] ${sign}${delta.toFixed(4)} USDT → ${updated.virtualBalance.toFixed(2)} (${reason})`)
  }

  return updated.virtualBalance
}

/**
 * Установить новый стартовый баланс — "сбросить" симуляцию.
 * Также обнуляет journal если clearTrades = true (вызывающий сам удалит trades).
 */
export async function setVirtualBalance(
  newBalance: number,
  resetStart = true,
): Promise<VirtualBalanceInfo> {
  await prisma.botConfig.upsert({
    where: { id: 1 },
    update: {
      virtualBalance: newBalance,
      ...(resetStart && {
        virtualBalanceStart: newBalance,
        virtualStartedAt: new Date(),
      }),
    },
    create: {
      id: 1,
      virtualBalance: newBalance,
      virtualBalanceStart: newBalance,
      virtualStartedAt: new Date(),
    },
  })

  console.log(`[VirtualBalance] Set to ${newBalance} USDT (resetStart=${resetStart})`)
  return getVirtualBalanceInfo()
}
