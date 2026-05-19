/**
 * Margin-driven actions — currently just `marketCloseForMargin`, used by the
 * margin guard to free capacity for new signals.
 *
 * Also exposes `buildExistingTrade` — the adaptor that turns a Prisma trade
 * row into the `ExistingTrade` shape that `marginGuard.evaluateOpenWithGuard`
 * expects.
 */

import { BreakoutVariant, tradeModel, logTag } from '../breakoutVariant'
import { ExistingTrade } from '../marginGuard'
import { PaperConfig, CloseRecord } from './types'
import { getRealisticRates, takerFillPrice } from './fees'
import { syncSignalStatus } from './signalSync'

export function buildExistingTrade(t: any): ExistingTrade {
  const closes = (t.closes as any[]) ?? []
  const closedFrac = closes.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
  const lev = t.leverage && t.leverage > 0
    ? t.leverage
    : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
      ? Math.max(1, Math.min(100, t.positionSizeUsd / t.depositAtEntryUsd))
      : 1)
  const initialRisk = Math.abs(t.entryPrice - t.initialStop)
  const ref = t.lastPriceCheck ?? t.entryPrice
  const unrealizedR = initialRisk > 0
    ? (t.side === 'BUY' ? (ref - t.entryPrice) : (t.entryPrice - ref)) / initialRisk
    : 0
  return {
    id: t.id,
    symbol: t.symbol,
    status: t.status,
    positionSizeUsd: t.positionSizeUsd,
    closedFrac,
    leverage: lev,
    unrealizedR,
    hasTP1: t.status === 'TP1_HIT' || t.status === 'TP2_HIT',
    hasTP2: t.status === 'TP2_HIT',
  }
}

/**
 * Market-close a trade's remaining position at last known price with reason='MARGIN'.
 * Used by margin guard to free capacity for new signals.
 *
 * Returns the net P&L delta (gross P&L - new fees) for caller's depositDelta
 * accumulator.
 */
export async function marketCloseForMargin(tradeId: number, cfg: PaperConfig, variant: BreakoutVariant): Promise<number> {
  const tm = tradeModel(variant) as any
  const t = await tm.findUnique({ where: { id: tradeId } })
  if (!t) return 0
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)) return 0

  const closes = ((t.closes as any[]) ?? []) as CloseRecord[]
  const closedFrac = closes.reduce((a, c) => a + c.percent, 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  if (remainingFrac < 1e-6) return 0

  const refPrice = t.lastPriceCheck ?? t.entryPrice
  // Margin-close is a taker market exit — slip pushes price worse.
  const realRates = getRealisticRates(t, cfg)
  const slipFrac = (realRates?.slipPct ?? 0) / 100
  const closePrice = takerFillPrice(refPrice, t.side, 'exit', slipFrac)
  const isLong = t.side === 'BUY'
  const initialRisk = Math.abs(t.entryPrice - t.initialStop)
  const fillUnits = t.positionUnits * remainingFrac
  const pnlUsd = (isLong ? closePrice - t.entryPrice : t.entryPrice - closePrice) * fillUnits
  const pnlR = initialRisk > 0
    ? ((isLong ? closePrice - t.entryPrice : t.entryPrice - closePrice) / initialRisk) * remainingFrac
    : 0
  const slipUsdNew = fillUnits * Math.abs(closePrice - refPrice)

  closes.push({
    price: closePrice,
    percent: remainingFrac * 100,
    pnlR, pnlUsd,
    closedAt: new Date().toISOString(),
    reason: 'MARGIN',
  })

  // Fee = taker rate (market close). Falls back to legacy flat rate if realistic
  // rates aren't set on this trade.
  const newFeesUsd = realRates
    ? fillUnits * closePrice * (realRates.takerPct / 100)
    : fillUnits * closePrice * ((t.feesRoundTripPct ?? cfg.feesRoundTripPct) / 100)
  const totalFeesUsd = (t.feesPaidUsd ?? 0) + newFeesUsd
  const totalSlipUsd = (t.slipPaidUsd ?? 0) + slipUsdNew
  const realizedR = (t.realizedR ?? 0) + pnlR
  const realizedPnlUsd = (t.realizedPnlUsd ?? 0) + pnlUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd

  await tm.update({
    where: { id: tradeId },
    data: {
      status: 'CLOSED',
      realizedR,
      realizedPnlUsd,
      feesPaidUsd: totalFeesUsd,
      slipPaidUsd: totalSlipUsd,
      netPnlUsd,
      closes: closes as any,
      closedAt: new Date(),
    },
  })

  // Only variant A mirrors back to the shared BreakoutSignal table.
  if (variant === 'A' && t.signalId) {
    await syncSignalStatus(t.signalId, 'CLOSED', realizedR, closePrice, new Date(), closes)
  }

  console.log(`${logTag(variant)} margin-close trade #${tradeId} ${t.symbol} ${t.side} @ $${closePrice.toFixed(6)} pnl $${pnlUsd.toFixed(2)} (${pnlR.toFixed(2)}R)`)

  return pnlUsd - newFeesUsd
}
