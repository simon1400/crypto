import { BreakoutVariant, configModel, tradeModel } from '../breakoutVariant'
import { PaperConfig } from './types'
import { getOrCreateConfig } from './config'

export async function resetBreakoutPaperAccount(newStartingDeposit?: number, variant: BreakoutVariant = 'A'): Promise<PaperConfig> {
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any

  const cfg = await getOrCreateConfig(variant)
  if (!cfg) throw new Error(`Breakout paper config (${variant}) table missing — migration not applied yet`)
  const start = newStartingDeposit ?? cfg.startingDepositUsd
  await tm.updateMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    data: { status: 'EXPIRED', closedAt: new Date() },
  })
  const updated = await cm.update({
    where: { id: 1 },
    data: {
      startingDepositUsd: start, currentDepositUsd: start, peakDepositUsd: start,
      maxDrawdownPct: 0, totalTrades: 0, totalWins: 0, totalLosses: 0, totalPnLUsd: 0,
      resetAt: new Date(),
    },
  })
  return updated as PaperConfig
}
