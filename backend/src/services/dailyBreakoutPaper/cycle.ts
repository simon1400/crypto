/**
 * One full paper-trader cycle for a variant:
 *   1. Open new trades from BreakoutSignal (skip for C — limit trader owns entries)
 *   2. Track all open trades (5m candle replay)
 *   3. If any trade terminally closed, try to refill the slot with another signal
 *
 * Called on the 60s timer (lifecycle.ts) and ad-hoc from the scanner route +
 * dailyBreakoutLiveScanner.
 */

import { BreakoutVariant, logTag } from '../breakoutVariant'
import { OpenedTradeInfo } from './types'
import { getOrCreateConfig } from './config'
import { openNewPaperTrades } from './open'
import { trackOpenPaperTrades } from './track'
import { applyDepositDelta } from './deposit'

export async function runBreakoutPaperCycle(variant: BreakoutVariant = 'A'): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number; openedTrades: OpenedTradeInfo[] }> {
  const tag = logTag(variant)
  const cfg = await getOrCreateConfig(variant)
  if (!cfg) return { opened: 0, updated: 0, depositDelta: 0, deposit: 0, openedTrades: [] }
  if (!cfg.enabled) return { opened: 0, updated: 0, depositDelta: 0, deposit: cfg.currentDepositUsd, openedTrades: [] }

  // Variant C использует limit-on-rangeEdge entry — отдельный сервис
  // dailyBreakoutLimitTrader.ts размещает PENDING_LIMIT'ы и filling'ом занимается WS
  // tracker. Здесь для C только tracking уже-FILLED сделок (status=OPEN/TP1_HIT/TP2_HIT).
  const isC = variant === 'C'

  const opened = isC
    ? { opened: 0, depositDelta: 0, openedTrades: [] as OpenedTradeInfo[] }
    : await openNewPaperTrades(cfg, variant)
  if (opened.depositDelta !== 0) {
    const fresh = await getOrCreateConfig(variant)
    if (fresh) await applyDepositDelta(fresh, opened.depositDelta, variant)
  }
  const cfgAfterOpens = await getOrCreateConfig(variant) ?? cfg
  const updated = await trackOpenPaperTrades(cfgAfterOpens, variant)
  if (updated.depositDelta !== 0) await applyDepositDelta(cfgAfterOpens, updated.depositDelta, variant)

  let openedAgain = 0
  let openedAgainDelta = 0
  let openedAgainTrades: OpenedTradeInfo[] = []
  if (!isC && updated.terminalClosed > 0) {
    const cfgFresh = await getOrCreateConfig(variant) ?? cfgAfterOpens
    const r2 = await openNewPaperTrades(cfgFresh, variant)
    openedAgain = r2.opened
    openedAgainDelta = r2.depositDelta
    openedAgainTrades = r2.openedTrades
    if (openedAgainDelta !== 0) {
      const cfgAfterR2 = await getOrCreateConfig(variant)
      if (cfgAfterR2) await applyDepositDelta(cfgAfterR2, openedAgainDelta, variant)
    }
    if (openedAgain > 0) {
      console.log(`${tag} slow: filled ${openedAgain} freed slot(s) inline after ${updated.terminalClosed} terminal close(s)`)
    }
  }

  const final = await getOrCreateConfig(variant)
  return {
    opened: opened.opened + openedAgain,
    updated: updated.updated,
    depositDelta: updated.depositDelta + opened.depositDelta + openedAgainDelta,
    deposit: final?.currentDepositUsd ?? 0,
    openedTrades: [...opened.openedTrades, ...openedAgainTrades],
  }
}
