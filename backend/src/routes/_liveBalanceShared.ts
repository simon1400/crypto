/**
 * Shared helper for pulling the effective deposit from Binance for Variant C
 * live. Lives outside the route file so the trader service can import it
 * without circular dep on Express routes.
 */

import { prisma } from '../db/prisma'
import type { BinanceFuturesClient } from '../services/exchanges/binanceFutures'

export async function refreshLiveBalance(client: BinanceFuturesClient): Promise<{ available: number; total: number }> {
  const acc = await client.getAccount()
  const usdt = acc.assets.find((a) => a.asset === 'USDT')
  const available = usdt ? Number(usdt.availableBalance) : 0
  const total = usdt ? Number(usdt.walletBalance) : 0
  await prisma.breakoutLiveConfigC.update({
    where: { id: 1 },
    data: { currentDepositUsd: available },
  })
  return { available, total }
}
