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
 *
 * Variant routing:
 *   The trader is parameterised by `variant: 'A' | 'B'`. Both variants observe the
 *   same BreakoutSignal stream (one Scanner) but maintain independent deposits and
 *   trade tables (BreakoutPaperConfig/Trade for A, BreakoutPaperConfigB/TradeB for B).
 *   Variant A (legacy prod) also mirrors trade state back into BreakoutSignal so the
 *   "Сигналы" tab and Telegram tracker stay in sync. Variant B does NOT mutate the
 *   shared BreakoutSignal table — it only reads from it. This avoids cross-variant
 *   races on a shared status field.
 */

import { prisma } from '../db/prisma'
import { OHLCV, fetchPricesBatch } from './market'
import { loadHistorical } from '../scalper/historicalLoader'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade, getMaxLeverage } from './marginGuard'
import { sendNotification } from './notifier'
import { BreakoutVariant, configModel, tradeModel, tgPrefix, logTag } from './breakoutVariant'

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

async function getOrCreateConfig(variant: BreakoutVariant): Promise<PaperConfig | null> {
  try {
    const c = await (configModel(variant) as any).upsert({
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
async function marketCloseForMargin(tradeId: number, cfg: PaperConfig, variant: BreakoutVariant): Promise<number> {
  const tm = tradeModel(variant) as any
  const t = await tm.findUnique({ where: { id: tradeId } })
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

  const feeRatePct = t.feesRoundTripPct ?? cfg.feesRoundTripPct
  const newFeesUsd = fillUnits * closePrice * (feeRatePct / 100)
  const totalFeesUsd = (t.feesPaidUsd ?? 0) + newFeesUsd
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

/**
 * Sync BreakoutSignal.status to mirror what paper trade did. Replaces the separate
 * dailyBreakoutTracker cron — paper trader is the single source of truth for
 * live tracking. Used by variant A only (variant B does not mutate shared signals).
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

async function openNewPaperTrades(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ opened: number; depositDelta: number }> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any
  const cm = configModel(variant) as any

  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const signals = await prisma.breakoutSignal.findMany({
    where: {
      createdAt: { gte: since },
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (signals.length === 0) return { opened: 0, depositDelta: 0 }

  const existingTrades = await tm.findMany({
    where: { signalId: { in: signals.map(s => s.id) } },
    select: { signalId: true },
  })
  const existingIds = new Set(existingTrades.map((t: any) => t.signalId))

  let opened = 0
  let depositDelta = 0

  // Variant A writes paperStatus into the shared BreakoutSignal table; variant B
  // does not (would clash with A on the same row). Both variants log to console.
  async function markPaperStatus(signalId: number, status: 'OPENED' | 'SKIPPED', reason: string | null) {
    if (variant !== 'A') return
    try {
      await prisma.breakoutSignal.update({
        where: { id: signalId },
        data: { paperStatus: status, paperReason: reason, paperUpdatedAt: new Date() },
      })
    } catch { /* schema may pre-date column on first cycle after deploy */ }
  }

  // Variant A is allowed to delete shared signals (stale/retraced/overshoot —
  // legacy behavior; this is the source of truth used by Signals tab + Telegram).
  // Variant B never deletes shared signals — it only skips them in its own log
  // (other variants would lose the signal otherwise).
  async function deleteSharedSignal(signalId: number, reason: string, symbol: string) {
    if (variant !== 'A') {
      console.log(`${tag} skip sig ${signalId} ${symbol} — ${reason} (B keeps shared signals)`)
      return
    }
    console.log(`${tag} delete sig ${signalId} ${symbol} — ${reason}`)
    try {
      await prisma.breakoutSignal.delete({ where: { id: signalId } })
    } catch { /* race with another delete — fine */ }
  }

  for (const sig of signals) {
    if (existingIds.has(sig.id)) continue

    const openTrades = await tm.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    if (openTrades.length >= cfg.maxConcurrentPositions) {
      const r = `maxConcurrent=${cfg.maxConcurrentPositions} reached`
      console.log(`${tag} skip sig ${sig.id} — ${r}`)
      await markPaperStatus(sig.id, 'SKIPPED', r)
      continue
    }

    const fresh = await cm.findUnique({ where: { id: 1 } })
    const deposit = fresh?.currentDepositUsd ?? cfg.currentDepositUsd

    // Stale signal guard: if the signal has been waiting > 30 min for a slot
    // (concurrency cap or margin guard), the breakout setup is no longer valid —
    // price has had time to retrace, geometry (SL/TP from rangeHigh/Low) is stale.
    // Backtest assumes instant fill on the triggering candle; long delays make
    // the live trade fundamentally different from what was simulated.
    const STALE_MIN = 30
    const ageMs = Date.now() - new Date(sig.createdAt).getTime()
    if (ageMs > STALE_MIN * 60_000) {
      await deleteSharedSignal(sig.id, `stale (${Math.round(ageMs / 60_000)}min old)`, sig.symbol)
      if (variant === 'B') continue  // B can't delete — just skip and move on
      continue
    }

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
      console.warn(`${tag} live price fetch failed for ${sig.symbol}, using signal entry: ${e.message}`)
    }

    if (livePrice != null) {
      const retraced = sig.side === 'BUY'
        ? livePrice < sig.rangeHigh
        : livePrice > sig.rangeLow
      if (retraced) {
        const edge = sig.side === 'BUY' ? sig.rangeHigh : sig.rangeLow
        await deleteSharedSignal(sig.id, `retraced into range (live ${livePrice.toFixed(4)} vs edge ${edge.toFixed(4)})`, sig.symbol)
        continue
      }

      const tp1 = (sig.tpLadder as number[])[0]
      const overshot = sig.side === 'BUY' ? livePrice >= tp1 : livePrice <= tp1
      if (overshot) {
        await deleteSharedSignal(sig.id, `live overshot TP1 (live ${livePrice.toFixed(6)} vs TP1 ${tp1.toFixed(6)})`, sig.symbol)
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
        console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — ${r}`)
        await markPaperStatus(sig.id, 'SKIPPED', r)
        continue
      }

      if (guard.toClose.length > 0) {
        if (!cfg.marginGuardAutoClose) {
          const r = `would need to close ${guard.toClose.length} winning trade(s), but auto-close disabled`
          console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — ${r}`)
          await markPaperStatus(sig.id, 'SKIPPED', r)
          continue
        }
        console.log(`${tag} margin guard: ${guard.reason} for sig ${sig.id} ${sig.symbol}`)
        for (const tid of guard.toClose) {
          const delta = await marketCloseForMargin(tid, cfg, variant)
          depositDelta += delta
        }
      }

      if (guard.downsizedMargin != null && guard.downsizedLeverage != null) {
        finalMargin = guard.downsizedMargin
        finalLeverage = guard.downsizedLeverage
      }
    }

    const entryAt = new Date()
    await tm.create({
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
    console.log(`${tag} opened sig ${sig.id} ${sig.symbol} ${sig.side}${entryNote} risk $${sizing.riskUsd.toFixed(2)} pos $${sizing.positionSizeUsd.toFixed(2)} lev ${finalLeverage.toFixed(1)}x margin $${finalMargin.toFixed(2)}${lvNote}${dsNote}`)
    await markPaperStatus(sig.id, 'OPENED', `lev ${finalLeverage.toFixed(1)}x · margin $${finalMargin.toFixed(2)}${lvNote}${dsNote}`)
    if (variant === 'A') {
      await syncSignalStatus(sig.id, 'ACTIVE', null, null, null, null)
    }
  }
  return { opened, depositDelta }
}

async function trackOnePaper(trade: any, candles: OHLCV[], cfg: PaperConfig, variant: BreakoutVariant): Promise<{ pnlDelta: number; statusChanged: boolean; terminalClosed: boolean }> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any
  const cm = configModel(variant) as any
  const prefix = tgPrefix(variant)

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
  await tm.update({
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

  // Mirror status / closes / lastPrice to the originating BreakoutSignal.
  // Variant A only — variant B does not mutate the shared signals table.
  if (variant === 'A' && statusChanged && trade.signalId) {
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

  if (events.length > 0) {
    const freshCfg = await cm.findUnique({ where: { id: 1 } })
    const depositUsd = (freshCfg?.currentDepositUsd ?? cfg.currentDepositUsd) + (totalPnlDeltaUsd - newFeesUsd)
    let cumR = trade.realizedR ?? 0
    let cumPnlUsd = trade.realizedPnlUsd ?? 0
    for (const ev of events) {
      cumR += ev.pnlR
      cumPnlUsd += ev.pnlUsd
      const symbolWithPrefix = `${prefix}${trade.symbol}`
      try {
        if (ev.kind === 'TP') {
          await sendNotification(`BREAKOUT_TP${ev.tpIdx}_HIT` as any, {
            symbol: symbolWithPrefix,
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
            symbol: symbolWithPrefix,
            slPrice: ev.price,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
            reasonText: ev.isBE ? 'SL → BE' : 'SL hit',
          })
        } else {
          await sendNotification('BREAKOUT_EXPIRED' as any, {
            symbol: symbolWithPrefix,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
          })
        }
      } catch (e: any) {
        console.error(`${tag} notify ${ev.kind} failed for ${trade.symbol}#${trade.id}: ${e.message}`)
      }
    }
  }

  const terminalClosed = statusChanged && (status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED')
  return { pnlDelta: totalPnlDeltaUsd - newFeesUsd, statusChanged, terminalClosed }
}

async function trackOpenPaperTrades(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ updated: number; depositDelta: number; terminalClosed: number }> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any
  const open = await tm.findMany({
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
        const r = await trackOnePaper(tr, candles, cfg, variant)
        totalDelta += r.pnlDelta
        if (r.statusChanged) updated++
        if (r.terminalClosed) terminalClosed++
      }
    } catch (e: any) {
      console.warn(`${tag} track ${symbol} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta, terminalClosed }
}

async function trackOpenPaperTradesFast(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ updated: number; depositDelta: number; terminalClosed: number }> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any
  const open = await tm.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return { updated: 0, depositDelta: 0, terminalClosed: 0 }

  const symbols: string[] = Array.from(new Set(open.map((t: any) => String(t.symbol))))
  const prices = await fetchPricesBatch(symbols)
  const now = Date.now()
  let totalDelta = 0, updated = 0, terminalClosed = 0
  for (const tr of open) {
    const price = prices[tr.symbol]
    if (!price || price <= 0) continue
    const tick: OHLCV = { time: now, open: price, high: price, low: price, close: price, volume: 0 }
    try {
      const r = await trackOnePaper(tr, [tick], cfg, variant)
      totalDelta += r.pnlDelta
      if (r.statusChanged) updated++
      if (r.terminalClosed) terminalClosed++
    } catch (e: any) {
      console.warn(`${tag}Fast ${tr.symbol}#${tr.id} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta, terminalClosed }
}

async function applyDepositDelta(cfg: PaperConfig, delta: number, variant: BreakoutVariant): Promise<void> {
  if (delta === 0) return
  const cm = configModel(variant) as any
  const tm = tradeModel(variant) as any

  const newDeposit = cfg.currentDepositUsd + delta
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0

  const trades = await tm.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
  })
  const closedStatuses = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])
  const closedOnly = trades.filter((t: any) => closedStatuses.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter((t: any) => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter((t: any) => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a: number, t: any) => {
    const realizedNet = closedStatuses.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
    return a + realizedNet
  }, 0)

  await cm.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}

export async function runBreakoutPaperCycle(variant: BreakoutVariant = 'A'): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number }> {
  const tag = logTag(variant)
  const cfg = await getOrCreateConfig(variant)
  if (!cfg) return { opened: 0, updated: 0, depositDelta: 0, deposit: 0 }
  if (!cfg.enabled) return { opened: 0, updated: 0, depositDelta: 0, deposit: cfg.currentDepositUsd }

  const opened = await openNewPaperTrades(cfg, variant)
  if (opened.depositDelta !== 0) {
    const fresh = await getOrCreateConfig(variant)
    if (fresh) await applyDepositDelta(fresh, opened.depositDelta, variant)
  }
  const cfgAfterOpens = await getOrCreateConfig(variant) ?? cfg
  const updated = await trackOpenPaperTrades(cfgAfterOpens, variant)
  if (updated.depositDelta !== 0) await applyDepositDelta(cfgAfterOpens, updated.depositDelta, variant)

  let openedAgain = 0
  let openedAgainDelta = 0
  if (updated.terminalClosed > 0) {
    const cfgFresh = await getOrCreateConfig(variant) ?? cfgAfterOpens
    const r2 = await openNewPaperTrades(cfgFresh, variant)
    openedAgain = r2.opened
    openedAgainDelta = r2.depositDelta
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
  }
}

export async function runBreakoutPaperCycleFast(variant: BreakoutVariant = 'A'): Promise<{ updated: number; depositDelta: number; opened?: number }> {
  const tag = logTag(variant)
  const cfg = await getOrCreateConfig(variant)
  if (!cfg || !cfg.enabled) return { updated: 0, depositDelta: 0 }
  const r = await trackOpenPaperTradesFast(cfg, variant)
  if (r.depositDelta !== 0) await applyDepositDelta(cfg, r.depositDelta, variant)

  let opened = 0
  if (r.terminalClosed > 0) {
    const cfgFresh = await getOrCreateConfig(variant)
    if (cfgFresh) {
      const r2 = await openNewPaperTrades(cfgFresh, variant)
      opened = r2.opened
      if (r2.depositDelta !== 0) {
        const cfgAfter = await getOrCreateConfig(variant)
        if (cfgAfter) await applyDepositDelta(cfgAfter, r2.depositDelta, variant)
      }
      if (opened > 0) {
        console.log(`${tag}Fast: filled ${opened} freed slot(s) inline after ${r.terminalClosed} terminal close(s)`)
      }
    }
  }

  return { updated: r.updated, depositDelta: r.depositDelta, opened }
}

/**
 * Force-open a paper trade for a signal that auto-flow skipped (margin/concurrent/etc).
 * Bypasses ALL guards except: signal exists, no existing trade for it, free margin >= $10.
 */
export async function forceOpenSignal(signalId: number, variant: BreakoutVariant = 'A'): Promise<{
  ok: boolean
  reason?: string
  tradeId?: number
  marginUsd?: number
  leverage?: number
  positionSizeUsd?: number
  entryPrice?: number
}> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any

  const cfg = await getOrCreateConfig(variant)
  if (!cfg) return { ok: false, reason: 'paper config missing' }

  const sig = await prisma.breakoutSignal.findUnique({ where: { id: signalId } })
  if (!sig) return { ok: false, reason: 'signal not found' }

  const existing = await tm.findFirst({
    where: { signalId },
    select: { id: true },
  })
  if (existing) return { ok: false, reason: `paper trade #${existing.id} already exists for this signal` }

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

  const openTrades = await tm.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  const sumActive = openTrades.reduce((s: number, t: any) => {
    const closes = (t.closes as any[]) ?? []
    const closedFrac = closes.reduce((a: number, c: any) => a + (c.percent ?? 0), 0) / 100
    const lev = t.leverage && t.leverage > 0 ? t.leverage : 1
    const remainingPos = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
    return s + remainingPos / Math.max(1e-9, lev)
  }, 0)
  const free = cfg.currentDepositUsd - sumActive

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

  const trade = await tm.create({
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
  if (variant === 'A') {
    await prisma.breakoutSignal.update({
      where: { id: sig.id },
      data: {
        paperStatus: 'OPENED',
        paperReason: `lev ${finalLeverage.toFixed(1)}x · margin $${finalMargin.toFixed(2)}${dsNote}`,
        paperUpdatedAt: new Date(),
      },
    })
    await syncSignalStatus(sig.id, 'ACTIVE', null, null, null, null)
  }

  console.log(`${tag} FORCE opened sig ${sig.id} ${sig.symbol} ${sig.side} entry ${entryPrice.toFixed(4)} risk $${sizing.riskUsd.toFixed(2)} pos $${sizing.positionSizeUsd.toFixed(2)} lev ${finalLeverage.toFixed(1)}x margin $${finalMargin.toFixed(2)}${dsNote}`)

  return {
    ok: true,
    tradeId: trade.id,
    marginUsd: finalMargin,
    leverage: finalLeverage,
    positionSizeUsd: sizing.positionSizeUsd,
    entryPrice,
  }
}

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

// Independent timers per variant — both tickers run side-by-side.
const paperIntervals: Record<BreakoutVariant, NodeJS.Timeout | null> = { A: null, B: null }
const paperFastIntervals: Record<BreakoutVariant, NodeJS.Timeout | null> = { A: null, B: null }
// Reentrancy guards — fastTick runs every 2s, but a single tick may take longer
// (Bybit fetch + Telegram notify). Without a guard, overlapping ticks read the
// same trade row before the first one's UPDATE commits, both see the same TP
// hit and both fire notifications. Skip-if-busy: a missed 2s tick is harmless.
const paperSlowBusy: Record<BreakoutVariant, boolean> = { A: false, B: false }
const paperFastBusy: Record<BreakoutVariant, boolean> = { A: false, B: false }

export function startBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const tag = logTag(variant)
  if (paperIntervals[variant]) return
  const slowTick = async () => {
    if (paperSlowBusy[variant]) return
    paperSlowBusy[variant] = true
    try {
      const r = await runBreakoutPaperCycle(variant)
      if (r.opened > 0 || r.updated > 0) {
        console.log(`${tag} slow: opened=${r.opened} updated=${r.updated} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) { console.error(`${tag} slow tick error:`, e.message) }
    finally { paperSlowBusy[variant] = false }
  }
  const fastTick = async () => {
    if (paperFastBusy[variant]) return
    paperFastBusy[variant] = true
    try {
      const r = await runBreakoutPaperCycleFast(variant)
      if (r.updated > 0) {
        console.log(`${tag} fast: updated=${r.updated} delta=${r.depositDelta.toFixed(2)}`)
      }
    } catch (e: any) { console.error(`${tag} fast tick error:`, e.message) }
    finally { paperFastBusy[variant] = false }
  }
  // Stagger boot: A starts at +90s, B at +95s — avoids both Bybit-fetching the
  // same symbol cluster at the exact same instant on first tick.
  const slowDelay = variant === 'A' ? 90_000 : 95_000
  setTimeout(slowTick, slowDelay)
  paperIntervals[variant] = setInterval(slowTick, 5 * 60_000)
  paperFastIntervals[variant] = setInterval(fastTick, 2_000)
  console.log(`${tag} started (slow=5min, fast=2s)`)
}
export function stopBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const i1 = paperIntervals[variant]
  const i2 = paperFastIntervals[variant]
  if (i1) { clearInterval(i1); paperIntervals[variant] = null }
  if (i2) { clearInterval(i2); paperFastIntervals[variant] = null }
}
