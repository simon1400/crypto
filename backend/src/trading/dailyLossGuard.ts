import { prisma } from '../db/prisma'
import { createBybitClient } from '../services/bybit'

export interface DailyLossCheck {
  allowed: boolean
  realizedLossToday: number    // sum of negative realizedPnl (negative number)
  prospectiveWorstCase: number // sum of worst-case SL losses (positive number)
  totalWorstCase: number       // |realizedLoss| + prospectiveWorstCase
  limitAmount: number          // dailyLossLimitPct * balance / 100
  reason?: string              // why blocked (if !allowed)
}

export async function checkDailyLoss(): Promise<DailyLossCheck> {
  // 1. Get config
  const config = await prisma.botConfig.findUnique({ where: { id: 1 } })
  const dailyLossLimitPct = config?.dailyLossLimitPct ?? 5

  // 2. Calculate today's midnight (server local time per D-08)
  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)

  // 3. Query positions closed today
  const closedToday = await prisma.position.findMany({
    where: {
      closedAt: { gte: todayMidnight },
      status: { in: ['CLOSED', 'SL_HIT', 'CLOSED_EXTERNAL', 'PARTIALLY_CLOSED'] },
    },
  })

  // 4. Sum only negative realizedPnl (wins don't reduce loss)
  const realizedLossToday = closedToday.reduce(
    (sum: number, p: any) => sum + Math.min(0, p.realizedPnl),
    0
  )

  // 5. Query open positions for prospective worst-case
  const openPositions = await prisma.position.findMany({
    where: {
      status: { in: ['OPEN', 'PARTIALLY_CLOSED'] },
    },
  })

  // 6. Calculate prospective worst-case: each open position hitting SL
  let prospectiveWorstCase = 0
  for (const pos of openPositions) {
    if (pos.entryPrice == null) continue
    const remainingQty = pos.qty * (1 - pos.closedPct / 100)
    const worstCaseLoss = remainingQty * Math.abs(pos.entryPrice - pos.stopLoss)
    prospectiveWorstCase += worstCaseLoss
  }

  // 7. Get USDT balance from Bybit
  const client = await createBybitClient()
  const balanceResp = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' })
  const balanceStr = balanceResp.result.list[0]?.coin?.find(
    (c: any) => c.coin === 'USDT'
  )?.walletBalance || '0'
  const balance = parseFloat(balanceStr)

  // 8. Calculate limit
  const limitAmount = (balance * dailyLossLimitPct) / 100

  // 9. Calculate total worst-case
  const totalWorstCase = Math.abs(realizedLossToday) + prospectiveWorstCase

  // 10. Determine if allowed
  const allowed = totalWorstCase < limitAmount

  const result: DailyLossCheck = {
    allowed,
    realizedLossToday,
    prospectiveWorstCase,
    totalWorstCase,
    limitAmount,
  }

  if (!allowed) {
    result.reason = `Daily loss limit: worst-case ${totalWorstCase.toFixed(2)} >= limit ${limitAmount.toFixed(2)}`
  }

  return result
}
