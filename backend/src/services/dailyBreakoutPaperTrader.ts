/**
 * Daily Breakout Paper Trader — virtual ($) trading engine.
 *
 * Two cycles run in parallel:
 *   - Slow (every 5 min): opens new paper trades, replays 5m klines for TP/SL/expiry.
 *   - Fast (every 2 sec): polls last-price via Bybit batch endpoint.
 *
 * Trailing: FULL (TP1→BE, TP2→TP1, TP3→TP2) — как в backtest где Daily Breakout
 * показал TEST R/tr +0.34. Это отличается от Levels (там было только TP1→BE).
 *
 * Splits: 50/30/20 (default ladder).
 */

import { prisma } from '../db/prisma'
import { OHLCV, fetchPricesBatch } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade, getMaxLeverage } from './marginGuard'
import { sendNotification } from './notifier'

const SPLITS = [0.5, 0.3, 0.2]

interface PaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feesRoundTripPct: number
  autoTrailingSL: boolean
  targetMarginPct: number
  marginGuardEnabled: boolean
  marginGuardAutoClose: boolean
  dailyLossLimitPct: number
  weeklyLossLimitPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  totalTrades: number
  totalWins: number
  totalLosses: number
  totalPnLUsd: number
  peakDepositUsd: number
  maxDrawdownPct: number
}

interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MARGIN'
}

async function getOrCreateConfig(): Promise<PaperConfig | null> {
  try {
    const c = await prisma.breakoutPaperConfig.upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    return c as PaperConfig
  } catch (e: any) {
    if (e?.message?.includes('does not exist')) return null
    throw e
  }
}

async function loadRecent5m(symbol: string): Promise<OHLCV[]> {
  return loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
}

function buildExistingTrade(t: any): ExistingTrade {
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
 */
async function marketCloseForMargin(tradeId: number, cfg: PaperConfig): Promise<number> {
  const t = await prisma.breakoutPaperTrade.findUnique({ where: { id: tradeId } })
  if (!t) return 0
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(t.status)) return 0

  const closes = ((t.closes as any[]) ?? []) as CloseRecord[]
  const closedFrac = closes.reduce((a, c) => a + c.percent, 0) / 100
  const remainingFrac = Math.max(0, 1 - closedFrac)
  if (remainingFrac < 1e-6) return 0

  const closePrice = t.lastPriceCheck ?? t.entryPrice
  const isLong = t.side === 'BUY'
  const initialRisk = Math.abs(t.entryPrice - t.initialStop)
  const fillUnits = t.positionUnits * remainingFrac
  const pnlUsd = (isLong ? closePrice - t.entryPrice : t.entryPrice - closePrice) * fillUnits
  const pnlR = initialRisk > 0
    ? ((isLong ? closePrice - t.entryPrice : t.entryPrice - closePrice) / initialRisk) * remainingFrac
    : 0

  closes.push({
    price: closePrice,
    percent: remainingFrac * 100,
    pnlR, pnlUsd,
    closedAt: new Date().toISOString(),
    reason: 'MARGIN',
  })

  // Add fees on this fill
  const feeRatePct = t.feesRoundTripPct ?? cfg.feesRoundTripPct
  const newFeesUsd = fillUnits * closePrice * (feeRatePct / 100)
  const totalFeesUsd = (t.feesPaidUsd ?? 0) + newFeesUsd
  const realizedR = (t.realizedR ?? 0) + pnlR
  const realizedPnlUsd = (t.realizedPnlUsd ?? 0) + pnlUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd

  await prisma.breakoutPaperTrade.update({
    where: { id: tradeId },
    data: {
      status: 'CLOSED',
      realizedR,
      realizedPnlUsd,
      feesPaidUsd: totalFeesUsd,
      netPnlUsd,
      closes: closes as any,
      closedAt: new Date(),
    },
  })

  if (t.signalId) {
    await syncSignalStatus(t.signalId, 'CLOSED', realizedR, closePrice, new Date(), closes)
  }

  console.log(`[BreakoutPaper] margin-close trade #${tradeId} ${t.symbol} ${t.side} @ $${closePrice.toFixed(6)} pnl $${pnlUsd.toFixed(2)} (${pnlR.toFixed(2)}R)`)

  // Return net P&L delta to apply to deposit
  return pnlUsd - newFeesUsd
}

/**
 * Sync BreakoutSignal.status to mirror what paper trade did. Replaces the separate
 * dailyBreakoutTracker cron — paper trader is the single source of truth for
 * live tracking, since we already pull klines / last-prices for it.
 */
export async function syncSignalStatus(
  signalId: number,
  newStatus: 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'CLOSED' | 'SL_HIT' | 'EXPIRED',
  realizedR: number | null,
  lastPriceCheck: number | null,
  closedAt: Date | null,
  closes: any[] | null,
): Promise<void> {
  try {
    const data: any = { status: newStatus }
    if (realizedR != null) data.realizedR = realizedR
    if (lastPriceCheck != null) {
      data.lastPriceCheck = lastPriceCheck
      data.lastPriceCheckAt = new Date()
    }
    if (closedAt) data.closedAt = closedAt
    if (closes) data.closes = closes
    await prisma.breakoutSignal.update({ where: { id: signalId }, data })
  } catch { /* signal may have been deleted manually — ignore */ }
}

async function openNewPaperTrades(cfg: PaperConfig): Promise<{ opened: number; depositDelta: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const signals = await prisma.breakoutSignal.findMany({
    where: {
      createdAt: { gte: since },
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (signals.length === 0) return { opened: 0, depositDelta: 0 }

  const existingTrades = await prisma.breakoutPaperTrade.findMany({
    where: { signalId: { in: signals.map(s => s.id) } },
    select: { signalId: true },
  })
  const existingIds = new Set(existingTrades.map(t => t.signalId))

  let opened = 0
  let depositDelta = 0

  async function markPaperStatus(signalId: number, status: 'OPENED' | 'SKIPPED', reason: string | null) {
    try {
      await prisma.breakoutSignal.update({
        where: { id: signalId },
        data: { paperStatus: status, paperReason: reason, paperUpdatedAt: new Date() },
      })
    } catch { /* schema may pre-date column on first cycle after deploy */ }
  }

  for (const sig of signals) {
    if (existingIds.has(sig.id)) continue

    // Re-read open trades each iteration since previous opens / margin-closes mutate state.
    const openTrades = await prisma.breakoutPaperTrade.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    if (openTrades.length >= cfg.maxConcurrentPositions) {
      const r = `maxConcurrent=${cfg.maxConcurrentPositions} reached`
      console.log(`[BreakoutPaper] skip sig ${sig.id} — ${r}`)
      await markPaperStatus(sig.id, 'SKIPPED', r)
      continue
    }

    // Use current deposit (deposit may have shifted via prior margin-closes this cycle).
    const fresh = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
    const deposit = fresh?.currentDepositUsd ?? cfg.currentDepositUsd

    // Stale signal guard: if the signal has been waiting > 30 min for a slot
    // (concurrency cap or margin guard), the breakout setup is no longer valid —
    // price has had time to retrace, geometry (SL/TP from rangeHigh/Low) is stale.
    // Backtest assumes instant fill on the triggering candle; long delays make
    // the live trade fundamentally different from what was simulated.
    // Delete the signal entirely (don't keep as SKIPPED) — geometry is dead and
    // cluttering the Signals tab adds no diagnostic value (unlike margin/sizing skips).
    const STALE_MIN = 30
    const ageMs = Date.now() - new Date(sig.createdAt).getTime()
    if (ageMs > STALE_MIN * 60_000) {
      console.log(`[BreakoutPaper] delete sig ${sig.id} ${sig.symbol} — stale (${Math.round(ageMs / 60_000)}min old)`)
      await prisma.breakoutSignal.delete({ where: { id: sig.id } })
      continue
    }

    // Realistic market fill: use the live last-trade price at the moment we open,
    // not the close of the breakout candle (which may be 1–5 min old by the time
    // the slow loop opens the trade — causing an instant unrealized loss when
    // price has moved away from c.close). Fallback to sig.entryPrice if the live
    // fetch fails. SL/TP are unchanged (anchored to range geometry); sizing is
    // recomputed against the new entry so risk = riskPct × deposit holds.
    let entryPrice = sig.entryPrice
    let livePrice: number | null = null
    try {
      const prices = await fetchPricesBatch([sig.symbol])
      const live = prices[sig.symbol]
      if (live && live > 0) {
        entryPrice = live
        livePrice = live
      }
    } catch (e: any) {
      console.warn(`[BreakoutPaper] live price fetch failed for ${sig.symbol}, using signal entry: ${e.message}`)
    }

    // Retrace guard: if live price has come back inside the range, the breakout
    // is invalidated — opening now is a counter-setup. Only check when we have a
    // live price (no live → fallback to sig.entryPrice which by definition
    // already broke the range). Delete the signal — same rationale as stale.
    if (livePrice != null) {
      const retraced = sig.side === 'BUY'
        ? livePrice < sig.rangeHigh   // BUY: price pulled back below rangeHigh
        : livePrice > sig.rangeLow    // SELL: price pulled back above rangeLow
      if (retraced) {
        const edge = sig.side === 'BUY' ? sig.rangeHigh : sig.rangeLow
        console.log(`[BreakoutPaper] delete sig ${sig.id} ${sig.symbol} — retraced into range (live ${livePrice.toFixed(4)} vs edge ${edge.toFixed(4)})`)
        await prisma.breakoutSignal.delete({ where: { id: sig.id } })
        continue
      }

      // TP1-overshoot guard: TP ladder anchored to signal's entryPrice (close of
      // breakout candle). If live price has already reached/passed TP1 by the
      // time we open, the trade would instantly fill TP1 — sometimes at a loss
      // because live entry > TP1, then trailing SL→BE flushes the rest. Same
      // rationale as the engine-level overshoot check, but applied to live fill.
      const tp1 = (sig.tpLadder as number[])[0]
      const overshot = sig.side === 'BUY' ? livePrice >= tp1 : livePrice <= tp1
      if (overshot) {
        console.log(`[BreakoutPaper] delete sig ${sig.id} ${sig.symbol} — live overshot TP1 (live ${livePrice.toFixed(6)} vs TP1 ${tp1.toFixed(6)})`)
        await prisma.breakoutSignal.delete({ where: { id: sig.id } })
        continue
      }
    }

    const sizing = computeSizing({
      symbol: sig.symbol,
      deposit,
      riskPct: cfg.riskPctPerTrade,
      targetMarginPct: cfg.targetMarginPct,
      entry: entryPrice,
      sl: sig.stopLoss,
    })
    if (!sizing || sizing.positionUnits <= 0) {
      await markPaperStatus(sig.id, 'SKIPPED', 'sizing failed (zero position)')
      continue
    }

    // Final values applied to the trade record. Mutated below if margin guard
    // returns a downsized margin (free < target, but trade still fits at higher
    // leverage within Bybit maxLev — risk and positionSize unchanged).
    let finalMargin = sizing.marginUsd
    let finalLeverage = sizing.leverage

    if (cfg.marginGuardEnabled) {
      const existing: ExistingTrade[] = openTrades.map(buildExistingTrade)
      const guard = evaluateOpenWithGuard(
        deposit, sizing.marginUsd, existing,
        sizing.positionSizeUsd, sig.symbol,
      )

      if (!guard.canOpen) {
        const r = `${guard.reason} (need $${guard.marginRequired.toFixed(2)}, free $${guard.marginAvailableBefore.toFixed(2)})`
        console.log(`[BreakoutPaper] skip sig ${sig.id} ${sig.symbol} — ${r}`)
        await markPaperStatus(sig.id, 'SKIPPED', r)
        continue
      }

      if (guard.toClose.length > 0) {
        if (!cfg.marginGuardAutoClose) {
          const r = `would need to close ${guard.toClose.length} winning trade(s), but auto-close disabled`
          console.log(`[BreakoutPaper] skip sig ${sig.id} ${sig.symbol} — ${r}`)
          await markPaperStatus(sig.id, 'SKIPPED', r)
          continue
        }
        console.log(`[BreakoutPaper] margin guard: ${guard.reason} for sig ${sig.id} ${sig.symbol}`)
        for (const tid of guard.toClose) {
          const delta = await marketCloseForMargin(tid, cfg)
          depositDelta += delta
        }
      }

      if (guard.downsizedMargin != null && guard.downsizedLeverage != null) {
        finalMargin = guard.downsizedMargin
        finalLeverage = guard.downsizedLeverage
      }
    }

    const entryAt = new Date()
    await prisma.breakoutPaperTrade.create({
      data: {
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.side,
        entryPrice,
        stopLoss: sig.stopLoss,
        initialStop: sig.initialStop,
        currentStop: sig.currentStop,
        tpLadder: sig.tpLadder as any,
        openedAt: entryAt,
        depositAtEntryUsd: deposit,
        riskUsd: sizing.riskUsd,
        positionSizeUsd: sizing.positionSizeUsd,
        positionUnits: sizing.positionUnits,
        leverage: finalLeverage,
        marginUsd: finalMargin,
        feesRoundTripPct: cfg.feesRoundTripPct,
        autoTrailingSL: cfg.autoTrailingSL,
        status: 'OPEN',
        expiresAt: sig.expiresAt,
      },
    })
    opened++
    const lvNote = sizing.cappedByMaxLeverage ? ` (capped at ${getMaxLeverage(sig.symbol)}x)` : ''
    const dsNote = finalMargin !== sizing.marginUsd
      ? ` [downsized $${sizing.marginUsd.toFixed(2)}→$${finalMargin.toFixed(2)}]`
      : ''
    const entryNote = entryPrice !== sig.entryPrice
      ? ` entry ${entryPrice.toFixed(4)} (sig was ${sig.entryPrice.toFixed(4)})`
      : ` entry ${entryPrice.toFixed(4)}`
    console.log(`[BreakoutPaper] opened sig ${sig.id} ${sig.symbol} ${sig.side}${entryNote} risk $${sizing.riskUsd.toFixed(2)} pos $${sizing.positionSizeUsd.toFixed(2)} lev ${finalLeverage.toFixed(1)}x margin $${finalMargin.toFixed(2)}${lvNote}${dsNote}`)
    await markPaperStatus(sig.id, 'OPENED', `lev ${finalLeverage.toFixed(1)}x · margin $${finalMargin.toFixed(2)}${lvNote}${dsNote}`)
    // Mirror to BreakoutSignal so /api/breakout/signals reflects live state without separate tracker.
    await syncSignalStatus(sig.id, 'ACTIVE', null, null, null, null)
  }
  return { opened, depositDelta }
}

async function trackOnePaper(trade: any, candles: OHLCV[], cfg: PaperConfig): Promise<{ pnlDelta: number; statusChanged: boolean; terminalClosed: boolean }> {
  const sinceMs = trade.lastPriceCheckAt
    ? new Date(trade.lastPriceCheckAt).getTime()
    : new Date(trade.openedAt).getTime()
  const newCandles = candles.filter(c => c.time > sinceMs)
  if (newCandles.length === 0) return { pnlDelta: 0, statusChanged: false, terminalClosed: false }

  const tpLadder: number[] = (trade.tpLadder as any[]) ?? []
  const isLong = trade.side === 'BUY'
  const entry = trade.entryPrice
  const initialRisk = Math.abs(entry - trade.initialStop)

  let nextTpIdx = 0
  let remainingFrac = 1
  const fills: CloseRecord[] = ((trade.closes as any[]) ?? []).map((c) => c as CloseRecord)
  for (const f of fills) {
    remainingFrac -= f.percent / 100
    if (f.reason === 'TP1') nextTpIdx = Math.max(nextTpIdx, 1)
    else if (f.reason === 'TP2') nextTpIdx = Math.max(nextTpIdx, 2)
    else if (f.reason === 'TP3') nextTpIdx = Math.max(nextTpIdx, 3)
  }
  if (remainingFrac < 1e-6) return { pnlDelta: 0, statusChanged: false, terminalClosed: false }

  let currentStop: number = trade.currentStop
  let realizedR: number = trade.realizedR ?? 0
  let realizedPnlUsd: number = trade.realizedPnlUsd ?? 0
  let status: string = trade.status
  const positionUnits: number = trade.positionUnits

  let totalPnlDeltaUsd = 0
  let statusChanged = false

  type FillEvent =
    | { kind: 'TP'; tpIdx: 1 | 2 | 3; price: number; percent: number; pnlR: number; pnlUsd: number }
    | { kind: 'SL'; price: number; pnlR: number; pnlUsd: number; isBE: boolean }
    | { kind: 'EXPIRED'; price: number; pnlR: number; pnlUsd: number }
  const events: FillEvent[] = []

  for (const c of newCandles) {
    // SL
    const slHit = isLong ? c.low <= currentStop : c.high >= currentStop
    if (slHit) {
      const pnlR = ((isLong ? currentStop - entry : entry - currentStop) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? currentStop - entry : entry - currentStop) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      fills.push({
        price: currentStop, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: 'SL',
      })
      events.push({ kind: 'SL', price: currentStop, pnlR, pnlUsd, isBE: realizedR >= 0 })
      remainingFrac = 0
      status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      statusChanged = true
      break
    }

    // TPs
    while (nextTpIdx < tpLadder.length && remainingFrac > 1e-6) {
      const tp = tpLadder[nextTpIdx]
      const tpHit = isLong ? c.high >= tp : c.low <= tp
      if (!tpHit) break

      const splitFrac = SPLITS[nextTpIdx] ?? remainingFrac
      const fillFrac = Math.min(splitFrac, remainingFrac)
      const pnlR = ((isLong ? tp - entry : entry - tp) / initialRisk) * fillFrac
      const fillUnits = positionUnits * fillFrac
      const pnlUsd = (isLong ? tp - entry : entry - tp) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      const tpName = (`TP${nextTpIdx + 1}`) as 'TP1' | 'TP2' | 'TP3'
      fills.push({
        price: tp, percent: fillFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: tpName,
      })
      events.push({
        kind: 'TP', tpIdx: (nextTpIdx + 1) as 1 | 2 | 3,
        price: tp, percent: fillFrac * 100, pnlR, pnlUsd,
      })
      remainingFrac -= fillFrac

      // Full trailing (как в backtest): TP1→BE, TP2→TP1, TP3→TP2.
      // autoTrailingSL flag respected — если выключен, оставляем initialStop без движения.
      const trailEnabled = trade.autoTrailingSL ?? cfg.autoTrailingSL
      if (trailEnabled) {
        if (nextTpIdx === 0) currentStop = entry
        else currentStop = tpLadder[nextTpIdx - 1]
      }

      status = nextTpIdx === 0 ? 'TP1_HIT' : nextTpIdx === 1 ? 'TP2_HIT' : 'TP3_HIT'
      statusChanged = true
      nextTpIdx++
      if (remainingFrac <= 1e-6) { status = 'CLOSED'; break }
    }
    if (status === 'CLOSED' || status === 'SL_HIT') break
  }

  // Expiry (end of UTC day)
  if (status !== 'CLOSED' && status !== 'SL_HIT' && trade.expiresAt && new Date(trade.expiresAt) < new Date()) {
    if (remainingFrac > 1e-6) {
      const lastPrice = newCandles[newCandles.length - 1].close
      const pnlR = ((isLong ? lastPrice - entry : entry - lastPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? lastPrice - entry : entry - lastPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      fills.push({
        price: lastPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date().toISOString(), reason: 'EXPIRED',
      })
      events.push({ kind: 'EXPIRED', price: lastPrice, pnlR, pnlUsd })
    }
    status = 'EXPIRED'
    statusChanged = true
  }

  // Fees
  const feeRatePct = trade.feesRoundTripPct ?? cfg.feesRoundTripPct
  const newFills = fills.slice((trade.closes as any[]).length)
  let newFeesUsd = 0
  for (const f of newFills) {
    const notional = positionUnits * f.price * (f.percent / 100)
    newFeesUsd += notional * (feeRatePct / 100)
  }
  const totalFeesUsd = (trade.feesPaidUsd ?? 0) + newFeesUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd

  const lastCandle = newCandles[newCandles.length - 1]
  await prisma.breakoutPaperTrade.update({
    where: { id: trade.id },
    data: {
      status, currentStop, realizedR, realizedPnlUsd,
      feesPaidUsd: totalFeesUsd, netPnlUsd,
      closes: fills as any,
      lastPriceCheck: lastCandle.close,
      lastPriceCheckAt: new Date(lastCandle.time),
      ...(status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED'
        ? { closedAt: new Date() } : {}),
    },
  })

  // Mirror status / closes / lastPrice to the originating BreakoutSignal so the
  // signals tab + Telegram tracker stay in sync without a separate cron.
  if (statusChanged && trade.signalId) {
    const isTerminal = status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED'
    await syncSignalStatus(
      trade.signalId,
      status as any,
      realizedR,
      lastCandle.close,
      isTerminal ? new Date() : null,
      fills,
    )
  }

  // Telegram notifications: one per fill event (TP1/TP2/TP3/SL/EXPIRED).
  // Cumulative R/PnL grow event-by-event; final values match post-update DB state.
  if (events.length > 0) {
    const freshCfg = await prisma.breakoutPaperConfig.findUnique({ where: { id: 1 } })
    const depositUsd = (freshCfg?.currentDepositUsd ?? cfg.currentDepositUsd) + (totalPnlDeltaUsd - newFeesUsd)
    let cumR = trade.realizedR ?? 0
    let cumPnlUsd = trade.realizedPnlUsd ?? 0
    for (const ev of events) {
      cumR += ev.pnlR
      cumPnlUsd += ev.pnlUsd
      try {
        if (ev.kind === 'TP') {
          await sendNotification(`BREAKOUT_TP${ev.tpIdx}_HIT` as any, {
            symbol: trade.symbol,
            tpPrice: ev.price,
            percent: ev.percent,
            pnlR: ev.pnlR,
            pnlUsd: ev.pnlUsd,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
          })
        } else if (ev.kind === 'SL') {
          await sendNotification('BREAKOUT_SL_HIT' as any, {
            symbol: trade.symbol,
            slPrice: ev.price,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
            reasonText: ev.isBE ? 'SL → BE' : 'SL hit',
          })
        } else {
          await sendNotification('BREAKOUT_EXPIRED' as any, {
            symbol: trade.symbol,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
          })
        }
      } catch (e: any) {
        console.error(`[BreakoutPaper] notify ${ev.kind} failed for ${trade.symbol}#${trade.id}: ${e.message}`)
      }
    }
  }

  // terminalClosed: сделка полностью завершилась (CLOSED/SL_HIT/EXPIRED) на этом
  // тике — caller'у нужно немедленно запустить openNewPaperTrades, чтобы свежий
  // сигнал занял освободившийся слот без ожидания следующего 5-min cron.
  const terminalClosed = statusChanged && (status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED')
  return { pnlDelta: totalPnlDeltaUsd - newFeesUsd, statusChanged, terminalClosed }
}

async function trackOpenPaperTrades(cfg: PaperConfig): Promise<{ updated: number; depositDelta: number; terminalClosed: number }> {
  const open = await prisma.breakoutPaperTrade.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return { updated: 0, depositDelta: 0, terminalClosed: 0 }

  const bySymbol = new Map<string, any[]>()
  for (const t of open) {
    const list = bySymbol.get(t.symbol) ?? []
    list.push(t); bySymbol.set(t.symbol, list)
  }

  let totalDelta = 0, updated = 0, terminalClosed = 0
  for (const [symbol, trades] of bySymbol) {
    try {
      const candles = await loadRecent5m(symbol)
      for (const tr of trades) {
        const r = await trackOnePaper(tr, candles, cfg)
        totalDelta += r.pnlDelta
        if (r.statusChanged) updated++
        if (r.terminalClosed) terminalClosed++
      }
    } catch (e: any) {
      console.warn(`[BreakoutPaper] track ${symbol} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta, terminalClosed }
}

async function trackOpenPaperTradesFast(cfg: PaperConfig): Promise<{ updated: number; depositDelta: number; terminalClosed: number }> {
  const open = await prisma.breakoutPaperTrade.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return { updated: 0, depositDelta: 0, terminalClosed: 0 }

  const symbols = [...new Set(open.map(t => t.symbol))]
  const prices = await fetchPricesBatch(symbols)
  const now = Date.now()
  let totalDelta = 0, updated = 0, terminalClosed = 0
  for (const tr of open) {
    const price = prices[tr.symbol]
    if (!price || price <= 0) continue
    const tick: OHLCV = { time: now, open: price, high: price, low: price, close: price, volume: 0 }
    try {
      const r = await trackOnePaper(tr, [tick], cfg)
      totalDelta += r.pnlDelta
      if (r.statusChanged) updated++
      if (r.terminalClosed) terminalClosed++
    } catch (e: any) {
      console.warn(`[BreakoutPaperFast] ${tr.symbol}#${tr.id} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta, terminalClosed }
}

async function applyDepositDelta(cfg: PaperConfig, delta: number): Promise<void> {
  if (delta === 0) return
  const newDeposit = cfg.currentDepositUsd + delta
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0

  // Учитываем и полностью закрытые, и реализованную часть открытых (TP1_HIT/TP2_HIT) —
  // иначе Total P&L отстаёт от депозита (депозит обновляется на каждый partial close).
  const trades = await prisma.breakoutPaperTrade.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
  })
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
  const closedOnly = trades.filter(t => closedStatuses.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter(t => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter(t => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a, t) => {
    const realizedNet = closedStatuses.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
    return a + realizedNet
  }, 0)

  await prisma.breakoutPaperConfig.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}

export async function runBreakoutPaperCycle(): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number }> {
  const cfg = await getOrCreateConfig()
  if (!cfg) return { opened: 0, updated: 0, depositDelta: 0, deposit: 0 }
  if (!cfg.enabled) return { opened: 0, updated: 0, depositDelta: 0, deposit: cfg.currentDepositUsd }

  const opened = await openNewPaperTrades(cfg)
  // Apply any margin-close P&L from the open phase BEFORE tracking, so subsequent reads see fresh deposit.
  if (opened.depositDelta !== 0) {
    const fresh = await getOrCreateConfig()
    if (fresh) await applyDepositDelta(fresh, opened.depositDelta)
  }
  const cfgAfterOpens = await getOrCreateConfig() ?? cfg
  const updated = await trackOpenPaperTrades(cfgAfterOpens)
  if (updated.depositDelta !== 0) await applyDepositDelta(cfgAfterOpens, updated.depositDelta)

  // If any trade fully closed during tracking, immediately try to fill the freed
  // slot from a fresh signal (≤ 30 min old, retrace guard) instead of waiting for
  // the next 5-min cron. This keeps maxConcurrent slots saturated.
  let openedAgain = 0
  let openedAgainDelta = 0
  if (updated.terminalClosed > 0) {
    const cfgFresh = await getOrCreateConfig() ?? cfgAfterOpens
    const r2 = await openNewPaperTrades(cfgFresh)
    openedAgain = r2.opened
    openedAgainDelta = r2.depositDelta
    if (openedAgainDelta !== 0) {
      const cfgAfterR2 = await getOrCreateConfig()
      if (cfgAfterR2) await applyDepositDelta(cfgAfterR2, openedAgainDelta)
    }
    if (openedAgain > 0) {
      console.log(`[BreakoutPaper] slow: filled ${openedAgain} freed slot(s) inline after ${updated.terminalClosed} terminal close(s)`)
    }
  }

  const final = await getOrCreateConfig()
  return {
    opened: opened.opened + openedAgain,
    updated: updated.updated,
    depositDelta: updated.depositDelta + opened.depositDelta + openedAgainDelta,
    deposit: final?.currentDepositUsd ?? 0,
  }
}

export async function runBreakoutPaperCycleFast(): Promise<{ updated: number; depositDelta: number; opened?: number }> {
  const cfg = await getOrCreateConfig()
  if (!cfg || !cfg.enabled) return { updated: 0, depositDelta: 0 }
  const r = await trackOpenPaperTradesFast(cfg)
  if (r.depositDelta !== 0) await applyDepositDelta(cfg, r.depositDelta)

  // Fast loop normally only tracks. But if a TP3/SL hit on a 2-sec tick,
  // we want to occupy the freed slot ASAP — don't wait the rest of the 5-min
  // window. openNewPaperTrades is heavier (32-symbol price fetch + margin guard),
  // so we only call it on actual terminal closes, not every fast tick.
  let opened = 0
  if (r.terminalClosed > 0) {
    const cfgFresh = await getOrCreateConfig()
    if (cfgFresh) {
      const r2 = await openNewPaperTrades(cfgFresh)
      opened = r2.opened
      if (r2.depositDelta !== 0) {
        const cfgAfter = await getOrCreateConfig()
        if (cfgAfter) await applyDepositDelta(cfgAfter, r2.depositDelta)
      }
      if (opened > 0) {
        console.log(`[BreakoutPaperFast] filled ${opened} freed slot(s) inline after ${r.terminalClosed} terminal close(s)`)
      }
    }
  }

  return { updated: r.updated, depositDelta: r.depositDelta, opened }
}

/**
 * Force-open a paper trade for a signal that auto-flow skipped (margin/concurrent/etc).
 * Bypasses ALL guards except: signal exists, no existing trade for it, free margin >= $10.
 * Uses live last-price for entry (same as auto-flow), recomputes sizing against the
 * current free margin so leverage rises to fit available capacity (positionSize and
 * 2% risk are preserved, capped at Bybit maxLev for the symbol).
 */
export async function forceOpenSignal(signalId: number): Promise<{
  ok: boolean
  reason?: string
  tradeId?: number
  marginUsd?: number
  leverage?: number
  positionSizeUsd?: number
  entryPrice?: number
}> {
  const cfg = await getOrCreateConfig()
  if (!cfg) return { ok: false, reason: 'paper config missing' }

  const sig = await prisma.breakoutSignal.findUnique({ where: { id: signalId } })
  if (!sig) return { ok: false, reason: 'signal not found' }

  const existing = await prisma.breakoutPaperTrade.findFirst({
    where: { signalId },
    select: { id: true },
  })
  if (existing) return { ok: false, reason: `paper trade #${existing.id} already exists for this signal` }

  // Live entry (same as auto-flow). Fallback to signal entry if fetch fails.
  let entryPrice = sig.entryPrice
  try {
    const prices = await fetchPricesBatch([sig.symbol])
    const live = prices[sig.symbol]
    if (live && live > 0) entryPrice = live
  } catch { /* fallback */ }

  const sizing = computeSizing({
    symbol: sig.symbol,
    deposit: cfg.currentDepositUsd,
    riskPct: cfg.riskPctPerTrade,
    targetMarginPct: cfg.targetMarginPct,
    entry: entryPrice,
    sl: sig.stopLoss,
  })
  if (!sizing || sizing.positionUnits <= 0) {
    return { ok: false, reason: 'sizing failed (zero position)' }
  }

  // Compute free margin from currently open trades.
  const openTrades = await prisma.breakoutPaperTrade.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  const sumActive = openTrades.reduce((s, t) => {
    const closes = (t.closes as any[]) ?? []
    const closedFrac = closes.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
    const lev = t.leverage && t.leverage > 0 ? t.leverage : 1
    const remainingPos = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
    return s + remainingPos / Math.max(1e-9, lev)
  }, 0)
  const free = cfg.currentDepositUsd - sumActive

  // Decide actual margin to use: target if it fits, otherwise downsize to free margin
  // (with leverage bumped within Bybit maxLev).
  let finalMargin = sizing.marginUsd
  let finalLeverage = sizing.leverage

  if (sizing.marginUsd > free) {
    if (free < 10) {
      return { ok: false, reason: `free margin $${free.toFixed(2)} below $10 minimum` }
    }
    const requiredLev = sizing.positionSizeUsd / free
    const maxLev = getMaxLeverage(sig.symbol)
    if (requiredLev > maxLev) {
      return { ok: false, reason: `required leverage ${requiredLev.toFixed(1)}x exceeds max ${maxLev}x for ${sig.symbol}` }
    }
    finalMargin = free
    finalLeverage = requiredLev
  }

  const trade = await prisma.breakoutPaperTrade.create({
    data: {
      signalId: sig.id,
      symbol: sig.symbol,
      side: sig.side,
      entryPrice,
      stopLoss: sig.stopLoss,
      initialStop: sig.initialStop,
      currentStop: sig.currentStop,
      tpLadder: sig.tpLadder as any,
      openedAt: new Date(),
      depositAtEntryUsd: cfg.currentDepositUsd,
      riskUsd: sizing.riskUsd,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: finalLeverage,
      marginUsd: finalMargin,
      feesRoundTripPct: cfg.feesRoundTripPct,
      autoTrailingSL: cfg.autoTrailingSL,
      status: 'OPEN',
      expiresAt: sig.expiresAt,
    },
  })

  const dsNote = finalMargin !== sizing.marginUsd
    ? ` [forced downsize $${sizing.marginUsd.toFixed(2)}→$${finalMargin.toFixed(2)}]`
    : ' [forced]'
  await prisma.breakoutSignal.update({
    where: { id: sig.id },
    data: {
      paperStatus: 'OPENED',
      paperReason: `lev ${finalLeverage.toFixed(1)}x · margin $${finalMargin.toFixed(2)}${dsNote}`,
      paperUpdatedAt: new Date(),
    },
  })
  await syncSignalStatus(sig.id, 'ACTIVE', null, null, null, null)

  console.log(`[BreakoutPaper] FORCE opened sig ${sig.id} ${sig.symbol} ${sig.side} entry ${entryPrice.toFixed(4)} risk $${sizing.riskUsd.toFixed(2)} pos $${sizing.positionSizeUsd.toFixed(2)} lev ${finalLeverage.toFixed(1)}x margin $${finalMargin.toFixed(2)}${dsNote}`)

  return {
    ok: true,
    tradeId: trade.id,
    marginUsd: finalMargin,
    leverage: finalLeverage,
    positionSizeUsd: sizing.positionSizeUsd,
    entryPrice,
  }
}

export async function resetBreakoutPaperAccount(newStartingDeposit?: number): Promise<PaperConfig> {
  const cfg = await getOrCreateConfig()
  if (!cfg) throw new Error('Breakout paper config table missing — migration not applied yet')
  const start = newStartingDeposit ?? cfg.startingDepositUsd
  await prisma.breakoutPaperTrade.updateMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    data: { status: 'EXPIRED', closedAt: new Date() },
  })
  const updated = await prisma.breakoutPaperConfig.update({
    where: { id: 1 },
    data: {
      startingDepositUsd: start, currentDepositUsd: start, peakDepositUsd: start,
      maxDrawdownPct: 0, totalTrades: 0, totalWins: 0, totalLosses: 0, totalPnLUsd: 0,
      resetAt: new Date(),
    },
  })
  return updated as PaperConfig
}

let paperInterval: NodeJS.Timeout | null = null
let paperFastInterval: NodeJS.Timeout | null = null

export function startBreakoutPaperTrader(): void {
  if (paperInterval) return
  const slowTick = async () => {
    try {
      const r = await runBreakoutPaperCycle()
      if (r.opened > 0 || r.updated > 0) {
        console.log(`[BreakoutPaper] slow: opened=${r.opened} updated=${r.updated} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) { console.error('[BreakoutPaper] slow tick error:', e.message) }
  }
  const fastTick = async () => {
    try {
      const r = await runBreakoutPaperCycleFast()
      if (r.updated > 0) {
        console.log(`[BreakoutPaper] fast: updated=${r.updated} delta=${r.depositDelta.toFixed(2)}`)
      }
    } catch (e: any) { console.error('[BreakoutPaper] fast tick error:', e.message) }
  }
  setTimeout(slowTick, 90_000)
  paperInterval = setInterval(slowTick, 5 * 60_000)
  paperFastInterval = setInterval(fastTick, 2_000)
  console.log('[BreakoutPaper] started (slow=5min, fast=2s)')
}
export function stopBreakoutPaperTrader(): void {
  if (paperInterval) { clearInterval(paperInterval); paperInterval = null }
  if (paperFastInterval) { clearInterval(paperFastInterval); paperFastInterval = null }
}
