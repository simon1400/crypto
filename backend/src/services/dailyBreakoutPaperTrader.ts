/**
 * Daily Breakout Paper Trader — virtual ($) trading engine.
 *
 * Tick architecture:
 *   - 60s tick (this file): opens new paper trades from BreakoutSignal stream and
 *     replays 5m klines as a SAFETY-NET for SL/TP detection.
 *   - WebSocket tracker (breakoutWsTracker.ts): real-time SL/TP detection via Bybit
 *     publicTrade stream — every actual trade triggers trackOnePaper for matching
 *     symbols, with 200ms per-symbol throttle. Replaces the old 2s fast-poll tick.
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
import { sendNotification, VariantOpenInfo } from './notifier'
import { BreakoutVariant, configModel, tradeModel, tgPrefix, logTag } from './breakoutVariant'

const SPLITS = [0.5, 0.3, 0.2]

interface PaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  // Legacy flat round-trip fee — used as fallback when realistic-model fields are zero
  feesRoundTripPct: number
  // Realistic Binance-style fee model
  feeTakerPct: number      // % per side, taker (entry market + SL/EXPIRED market)
  feeMakerPct: number      // % per side, maker (TP limit fills — sit in book)
  slipTakerPct: number     // % per side slippage on taker fills only
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

/**
 * Realistic fee/slip model: TP fills are maker (limit at TP price, no slip),
 * everything else (entry market, SL stop-market, EXPIRED manual close, MARGIN
 * close, manual market close) is taker (paid taker fee + slip applied to fill price).
 */
export function isMakerFill(reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MARGIN' | 'MANUAL'): boolean {
  return reason === 'TP1' || reason === 'TP2' || reason === 'TP3'
}

/**
 * Slip-adjusted price for a TAKER fill at structural price `p`.
 * Long entry (taker buy) — slip pushes price UP.
 * Long exit (taker sell) — slip pushes price DOWN.
 * Short entry (taker sell) — DOWN. Short exit (taker buy) — UP.
 */
export function takerFillPrice(structPrice: number, side: 'BUY' | 'SELL', kind: 'entry' | 'exit', slipFrac: number): number {
  if (slipFrac <= 0) return structPrice
  if (kind === 'entry') {
    return side === 'BUY' ? structPrice * (1 + slipFrac) : structPrice * (1 - slipFrac)
  } else {
    return side === 'BUY' ? structPrice * (1 - slipFrac) : structPrice * (1 + slipFrac)
  }
}

/**
 * Picks effective rates for a trade. Per-trade override takes priority, otherwise
 * config defaults are used. Returns undefined if no realistic-model rates set
 * (caller should fall back to legacy flat fee model).
 */
export function getRealisticRates(trade: any, cfg: PaperConfig): { takerPct: number; makerPct: number; slipPct: number } | null {
  const takerPct = trade.feeTakerPct ?? cfg.feeTakerPct
  const makerPct = trade.feeMakerPct ?? cfg.feeMakerPct
  const slipPct = trade.slipTakerPct ?? cfg.slipTakerPct
  if (takerPct == null || makerPct == null || slipPct == null) return null
  return { takerPct, makerPct, slipPct }
}

interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MARGIN'
}

export interface OpenedTradeInfo {
  signalId: number
  symbol: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  tpLadder: number[]
  rangeHigh: number
  rangeLow: number
  rangeSize: number
  riskPctPerTrade: number
  riskUsd: number
  positionSizeUsd: number
  positionUnits: number
  leverage: number
  marginUsd: number
  depositUsd: number
  targetMarginPct: number
  cappedByMaxLeverage: boolean
  reason: string
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

/**
 * Returns true if a variant already "took" the symbol for this UTC day and
 * should not open another trade on it. A variant is considered busy when:
 *   1. There is any trade with openedAt in the current UTC day (regardless of
 *      its current status — OPEN, TP1_HIT, CLOSED, SL_HIT, EXPIRED — once today's
 *      slot was used, it stays used until midnight UTC).
 *   2. There is an active trade right now (OPEN/TP1_HIT/TP2_HIT) regardless of
 *      open date — covers a TP1+ trade carrying over from a previous day. Such a
 *      position is still in the market and a new entry would conflict on Bybit.
 *
 * A trade that opened yesterday and closed earlier today is NOT busy: that's
 * yesterday's setup running to completion, today's slot is still free for a
 * fresh breakout.
 */
export async function isVariantBusyOnSymbol(
  symbol: string,
  utcDate: string,
  variant: BreakoutVariant,
): Promise<boolean> {
  const tm = tradeModel(variant) as any
  const dayStart = new Date(`${utcDate}T00:00:00.000Z`)
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`)

  const found = await tm.findFirst({
    where: {
      symbol,
      OR: [
        // Rule 1: any trade opened today (regardless of current status)
        { openedAt: { gte: dayStart, lte: dayEnd } },
        // Rule 2: any currently active trade (carrying over from prior day)
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      ],
    },
    select: { id: true },
  })
  return !!found
}

async function openNewPaperTrades(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ opened: number; depositDelta: number; openedTrades: OpenedTradeInfo[] }> {
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
  if (signals.length === 0) return { opened: 0, depositDelta: 0, openedTrades: [] }

  const existingTrades = await tm.findMany({
    where: { signalId: { in: signals.map(s => s.id) } },
    select: { signalId: true },
  })
  const existingIds = new Set(existingTrades.map((t: any) => t.signalId))

  let opened = 0
  let depositDelta = 0
  const openedTrades: OpenedTradeInfo[] = []

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

    // Same-day-per-symbol guard: skip if this variant already took a trade on
    // this symbol today, OR has an active carry-over trade from a previous day.
    // Mirrors the backtest's "one breakout per UTC day per coin" rule and
    // prevents the duplicate-signal bug when the shared signal is recreated
    // after stale-deletion.
    if (await isVariantBusyOnSymbol(sig.symbol, sig.rangeDate, variant)) {
      const r = `${sig.symbol} already taken today (or carry-over still active) in variant ${variant}`
      console.log(`${tag} skip sig ${sig.id} — ${r}`)
      await markPaperStatus(sig.id, 'SKIPPED', r)
      continue
    }

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

    // Realistic-fee model: entry is a taker market order. Apply slip BEFORE
    // sizing so risk-per-trade is measured from the actual fill price (not the
    // structural rangeEdge). This way risk stays at riskPct% regardless of slip.
    const slipFracEntry = (cfg.slipTakerPct ?? 0) / 100
    const slippedEntry = takerFillPrice(entryPrice, sig.side as 'BUY' | 'SELL', 'entry', slipFracEntry)

    const sizing = computeSizing({
      symbol: sig.symbol,
      deposit,
      riskPct: cfg.riskPctPerTrade,
      targetMarginPct: cfg.targetMarginPct,
      entry: slippedEntry,
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

    // Realistic-fee model — charge entry taker fee + record entry slip USD.
    // The trade row stores feesPaidUsd starting with the entry fee (was 0 in
    // the legacy flat model where only close-side fees were tracked). Slip is
    // recorded separately in slipPaidUsd for reporting; it is already baked
    // into the realised PnL via the slipped entry price used for sizing.
    const entryFeeUsd = sizing.positionUnits * slippedEntry * (cfg.feeTakerPct / 100)
    const entrySlipUsd = sizing.positionUnits * Math.abs(slippedEntry - entryPrice)
    depositDelta -= entryFeeUsd

    const entryAt = new Date()
    await tm.create({
      data: {
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.side,
        entryPrice: slippedEntry,
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
        feeTakerPct: cfg.feeTakerPct,
        feeMakerPct: cfg.feeMakerPct,
        slipTakerPct: cfg.slipTakerPct,
        feesPaidUsd: entryFeeUsd,
        slipPaidUsd: entrySlipUsd,
        autoTrailingSL: cfg.autoTrailingSL,
        status: 'OPEN',
        expiresAt: sig.expiresAt,
      },
    })
    opened++
    openedTrades.push({
      signalId: sig.id,
      symbol: sig.symbol,
      side: sig.side as 'BUY' | 'SELL',
      entryPrice: slippedEntry,
      stopLoss: sig.stopLoss,
      tpLadder: sig.tpLadder as number[],
      rangeHigh: sig.rangeHigh,
      rangeLow: sig.rangeLow,
      rangeSize: sig.rangeSize,
      riskPctPerTrade: cfg.riskPctPerTrade,
      riskUsd: sizing.riskUsd,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: finalLeverage,
      marginUsd: finalMargin,
      depositUsd: deposit,
      targetMarginPct: cfg.targetMarginPct,
      cappedByMaxLeverage: sizing.cappedByMaxLeverage,
      reason: sig.reason,
    })
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
  return { opened, depositDelta, openedTrades }
}

async function trackOnePaper(trade: any, candles: OHLCV[], cfg: PaperConfig, variant: BreakoutVariant, isFastTick: boolean = false): Promise<{ pnlDelta: number; statusChanged: boolean; terminalClosed: boolean }> {
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
    // trailLevel = number of TPs already taken at the moment SL fired:
    //   0 — SL still on initial stop (full loss)
    //   1 — SL was trailed to entry (break-even)
    //   2 — SL was trailed to TP1 (locked profit)
    //   3 — SL was trailed to TP2 (locked bigger profit) — only possible if TP3 wasn't reached
    | { kind: 'SL'; price: number; pnlR: number; pnlUsd: number; trailLevel: 0 | 1 | 2 | 3 }
    | { kind: 'EXPIRED'; price: number; pnlR: number; pnlUsd: number }
  const events: FillEvent[] = []

  // Realistic fee model — per-event taker/maker rates + slip on taker fills.
  // TP fills: maker (limit at TP price, exact fill, no slip)
  // SL/EXPIRED: taker (market/stop-market, slip pushes price worse)
  const realRates = getRealisticRates(trade, cfg)
  const slipFracExit = (realRates?.slipPct ?? 0) / 100

  // Track slip USD on each new fill (sum into trade.slipPaidUsd at end)
  let newSlipUsd = 0

  for (const c of newCandles) {
    const slHit = isLong ? c.low <= currentStop : c.high >= currentStop
    if (slHit) {
      // Taker fill on SL — slip worsens the fill price
      const slipFillPrice = takerFillPrice(currentStop, trade.side, 'exit', slipFracExit)
      const pnlR = ((isLong ? slipFillPrice - entry : entry - slipFillPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? slipFillPrice - entry : entry - slipFillPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      newSlipUsd += fillUnits * Math.abs(slipFillPrice - currentStop)
      fills.push({
        price: slipFillPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(), reason: 'SL',
      })
      events.push({ kind: 'SL', price: slipFillPrice, pnlR, pnlUsd, trailLevel: nextTpIdx as 0 | 1 | 2 | 3 })
      remainingFrac = 0
      status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      statusChanged = true
      break
    }

    while (nextTpIdx < tpLadder.length && remainingFrac > 1e-6) {
      const tp = tpLadder[nextTpIdx]
      const tpHit = isLong ? c.high >= tp : c.low <= tp
      if (!tpHit) break

      // Maker fill on TP — exact price, no slip (limit order sat at TP).
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

  // EOD-NO-TP1 policy: expire only if TP1 NOT yet hit. If TP1 reached, the trailing
  // SL is already at BE (or TP-1) so the trade can either run further into TP2/TP3 or
  // close at break-even on a reversal — no reason to force-close at 23:55 UTC.
  // Backtest 2026-05-10 showed +0.02-0.03 R/tr improvement and lower DD across A/B.
  if (status !== 'CLOSED' && status !== 'SL_HIT' && nextTpIdx === 0 && trade.expiresAt && new Date(trade.expiresAt) < new Date()) {
    if (remainingFrac > 1e-6) {
      const lastPrice = newCandles[newCandles.length - 1].close
      // Taker fill on EXPIRED (manual market close at EOD) — slip applies.
      const slipFillPrice = takerFillPrice(lastPrice, trade.side, 'exit', slipFracExit)
      const pnlR = ((isLong ? slipFillPrice - entry : entry - slipFillPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? slipFillPrice - entry : entry - slipFillPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      newSlipUsd += fillUnits * Math.abs(slipFillPrice - lastPrice)
      fills.push({
        price: slipFillPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date().toISOString(), reason: 'EXPIRED',
      })
      events.push({ kind: 'EXPIRED', price: slipFillPrice, pnlR, pnlUsd })
    }
    status = 'EXPIRED'
    statusChanged = true
  }

  // Per-event fee calculation: TP = maker rate, SL/EXPIRED/MARGIN/MANUAL = taker rate.
  // Falls back to legacy flat round-trip rate if realistic-model rates aren't set
  // (older trades from before the migration, or external override).
  const newFills = fills.slice((trade.closes as any[]).length)
  let newFeesUsd = 0
  if (realRates) {
    for (const f of newFills) {
      const notional = positionUnits * f.price * (f.percent / 100)
      const rate = isMakerFill(f.reason) ? realRates.makerPct : realRates.takerPct
      newFeesUsd += notional * (rate / 100)
    }
  } else {
    const feeRatePct = trade.feesRoundTripPct ?? cfg.feesRoundTripPct
    for (const f of newFills) {
      const notional = positionUnits * f.price * (f.percent / 100)
      newFeesUsd += notional * (feeRatePct / 100)
    }
  }
  const totalFeesUsd = (trade.feesPaidUsd ?? 0) + newFeesUsd
  const totalSlipUsd = (trade.slipPaidUsd ?? 0) + newSlipUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd

  const lastCandle = newCandles[newCandles.length - 1]
  // Fast tick uses synthetic ticks with time=Date.now(), but real 5m candles have
  // time=bucket-start (e.g. 08:20:00). If we wrote now() as lastPriceCheckAt, the
  // next slow tick would filter out the not-yet-closed 5m candle that contained
  // a real low/high crossing of SL/TP — and the wick would never be detected.
  // For fast ticks, anchor lastPriceCheckAt to the start of the CURRENT 5m bucket
  // minus 1ms, so the slow tick always re-evaluates the freshly-closed candle.
  let nextCheckAt: Date
  if (isFastTick) {
    const bucketStart = Math.floor(lastCandle.time / (5 * 60_000)) * (5 * 60_000)
    nextCheckAt = new Date(bucketStart - 1)
  } else {
    nextCheckAt = new Date(lastCandle.time)
  }
  await tm.update({
    where: { id: trade.id },
    data: {
      status, currentStop, realizedR, realizedPnlUsd,
      feesPaidUsd: totalFeesUsd, slipPaidUsd: totalSlipUsd, netPnlUsd,
      closes: fills as any,
      lastPriceCheck: lastCandle.close,
      lastPriceCheckAt: nextCheckAt,
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
          const reasonText =
            ev.trailLevel === 0 ? 'SL сработал' :
            ev.trailLevel === 1 ? 'SL (безубыток)' :
            ev.trailLevel === 2 ? 'SL → TP1 (зафиксирован профит)' :
            'SL → TP2 (зафиксирован профит)'
          await sendNotification('BREAKOUT_SL_HIT' as any, {
            symbol: symbolWithPrefix,
            slPrice: ev.price,
            realizedR: cumR,
            realizedPnlUsd: cumPnlUsd,
            depositUsd,
            reasonText,
            trailLevel: ev.trailLevel,
          })
        } else {
          // EXPIRED notifications are suppressed here — they are aggregated into
          // a single EOD daily summary message at 23:55 UTC by sendBreakoutEodSummary().
          // Per-trade EXPIRED spam (10+ messages at once) is replaced by two summaries:
          // one for EOD-closed trades, one for those surviving past midnight (had TP1).
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

/**
 * WebSocket entrypoint — обрабатывает один трейд (или одну агрегированную свечу) для
 * конкретного символа. Идёт по обоим вариантам (A и B), применяет depositDelta,
 * шлёт terminal-close уведомления через notifySingleVariantOpens-аналог сделан внутри
 * trackOnePaper. После terminal close — пытается тут же открыть новые сделки в этом же
 * варианте (slot refill), как это делал fast tick.
 *
 * Вызывается из breakoutWsTracker.ts на каждый publicTrade event (с throttle).
 */
export async function runTrackForSymbol(symbol: string, tick: OHLCV): Promise<void> {
  for (const variant of ['A', 'B'] as BreakoutVariant[]) {
    try {
      const cfg = await getOrCreateConfig(variant)
      if (!cfg || !cfg.enabled) continue

      const tm = tradeModel(variant) as any
      const open = await tm.findMany({
        where: { symbol, status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
      })
      if (open.length === 0) continue

      let totalDelta = 0
      let terminalClosed = 0
      for (const tr of open) {
        try {
          const r = await trackOnePaper(tr, [tick], cfg, variant, true)
          totalDelta += r.pnlDelta
          if (r.terminalClosed) terminalClosed++
        } catch (e: any) {
          console.warn(`${logTag(variant)}WS ${symbol}#${tr.id} failed: ${e.message}`)
        }
      }
      if (totalDelta !== 0) await applyDepositDelta(cfg, totalDelta, variant)

      // Slot refill — после terminal close сразу пробуем открыть новые сделки.
      // Та же логика что в runBreakoutPaperCycleFast.
      if (terminalClosed > 0) {
        const cfgFresh = await getOrCreateConfig(variant)
        if (cfgFresh) {
          const r2 = await openNewPaperTrades(cfgFresh, variant)
          if (r2.depositDelta !== 0) await applyDepositDelta(cfgFresh, r2.depositDelta, variant)
          if (r2.openedTrades.length > 0) await notifySingleVariantOpens(r2.openedTrades, variant)
        }
      }
    } catch (e: any) {
      console.warn(`[BreakoutWS] ${variant} ${symbol} cycle failed: ${e.message}`)
    }
  }
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

export async function runBreakoutPaperCycle(variant: BreakoutVariant = 'A'): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number; openedTrades: OpenedTradeInfo[] }> {
  const tag = logTag(variant)
  const cfg = await getOrCreateConfig(variant)
  if (!cfg) return { opened: 0, updated: 0, depositDelta: 0, deposit: 0, openedTrades: [] }
  if (!cfg.enabled) return { opened: 0, updated: 0, depositDelta: 0, deposit: cfg.currentDepositUsd, openedTrades: [] }

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
  let openedAgainTrades: OpenedTradeInfo[] = []
  if (updated.terminalClosed > 0) {
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
  const cm = configModel(variant) as any

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

  // Force-open is also a taker market entry — apply slip before sizing.
  const slipFracEntry = (cfg.slipTakerPct ?? 0) / 100
  const slippedEntry = takerFillPrice(entryPrice, sig.side as 'BUY' | 'SELL', 'entry', slipFracEntry)

  const sizing = computeSizing({
    symbol: sig.symbol,
    deposit: cfg.currentDepositUsd,
    riskPct: cfg.riskPctPerTrade,
    targetMarginPct: cfg.targetMarginPct,
    entry: slippedEntry,
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

  // Charge entry taker fee + record entry slip
  const entryFeeUsd = sizing.positionUnits * slippedEntry * (cfg.feeTakerPct / 100)
  const entrySlipUsd = sizing.positionUnits * Math.abs(slippedEntry - entryPrice)
  // Deduct entry fee from deposit by adjusting via applyDepositDelta caller chain
  // — easiest path is to record it on the trade so applyDepositDelta in subsequent
  // ticks recomputes from net of all closes. But for force-open we want immediate
  // depo reflection. Apply directly here:
  await cm.update({
    where: { id: 1 },
    data: { currentDepositUsd: { decrement: entryFeeUsd } },
  })

  const trade = await tm.create({
    data: {
      signalId: sig.id,
      symbol: sig.symbol,
      side: sig.side,
      entryPrice: slippedEntry,
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
      feeTakerPct: cfg.feeTakerPct,
      feeMakerPct: cfg.feeMakerPct,
      slipTakerPct: cfg.slipTakerPct,
      feesPaidUsd: entryFeeUsd,
      slipPaidUsd: entrySlipUsd,
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

/**
 * Telegram notify for trades opened off-cycle (timer-driven slow/fast tick when
 * scanner inline didn't fire — e.g. boot, refill after terminal close, manual
 * scan). Sends one message per signal with this variant's sizing block. The
 * scanner itself uses its own consolidated path (A+B in one message) and
 * does NOT call this helper.
 */
async function notifySingleVariantOpens(opened: OpenedTradeInfo[], variant: BreakoutVariant): Promise<void> {
  for (const t of opened) {
    const v: VariantOpenInfo = {
      variant,
      depositUsd: t.depositUsd,
      riskPctPerTrade: t.riskPctPerTrade,
      riskUsd: t.riskUsd,
      positionSizeUsd: t.positionSizeUsd,
      positionUnits: t.positionUnits,
      marginUsd: t.marginUsd,
      leverage: t.leverage,
      cappedByMaxLeverage: t.cappedByMaxLeverage,
      targetMarginPct: t.targetMarginPct,
    }
    try {
      await sendNotification('BREAKOUT_OPENED', {
        symbol: t.symbol,
        side: t.side,
        reason: t.reason,
        variants: [v],
      })
      if (variant === 'A') {
        try {
          await prisma.breakoutSignal.update({
            where: { id: t.signalId },
            data: { notifiedTelegram: true },
          })
        } catch { /* signal may have been deleted — ignore */ }
      }
    } catch (e: any) {
      console.error(`${logTag(variant)} OPENED notify failed for sig ${t.signalId}: ${e.message}`)
    }
  }
}

/**
 * Build EOD summaries for both variants for a given UTC date and send two
 * Telegram messages: one for trades EOD-closed (status=EXPIRED, also includes
 * any CLOSED/SL_HIT that happened during the same day), and one for "surviving"
 * trades that hit TP1+ and stay open past midnight.
 *
 * Idempotency: marker `eodSentForDate` is stored in BreakoutConfig.lastScanResult
 * — sendBreakoutEodSummary is a no-op if it has already run for that date.
 */
async function buildVariantEodSummary(
  variant: BreakoutVariant,
  utcDate: string,
): Promise<{ closed: import('./notifier').EodVariantSummary; surviving: import('./notifier').EodVariantSummary }> {
  const tm = tradeModel(variant) as any
  const cm = configModel(variant) as any

  const dayStart = new Date(`${utcDate}T00:00:00.000Z`).getTime()
  const dayEnd = new Date(`${utcDate}T23:59:59.999Z`).getTime()

  const cfg = await cm.findUnique({ where: { id: 1 } })
  const deposit = cfg?.currentDepositUsd ?? 0

  // CLOSED rows = ONE row per trade, aggregating all close-events of that trade
  // that happened during this UTC day. A trade that hit TP1+TP2+SL the same day
  // appears as a single row "TP1+TP2+SL" with summed P&L. A trade whose TP1 fired
  // today but final SL tomorrow appears here today as "TP1" only, and tomorrow's
  // EOD will show the SL row separately. Σ matches dashboard's "P&L дня".
  const tradesWithCloses = await tm.findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      id: true, symbol: true, side: true, closes: true,
      positionUnits: true, feesRoundTripPct: true, openedAt: true,
    },
  })
  const feeRateDefault = cfg?.feesRoundTripPct ?? 0.08
  const closedRows: import('./notifier').EodTradeRow[] = []
  for (const t of tradesWithCloses) {
    const arr = ((t.closes as any[]) ?? []) as Array<{
      price: number; percent: number; pnlUsd: number; pnlR: number;
      closedAt: string; reason: string;
    }>
    const feeRatePct = t.feesRoundTripPct ?? feeRateDefault
    let pnlSum = 0
    let rSum = 0
    const reasons: string[] = []
    for (const c of arr) {
      const ts = c.closedAt ? new Date(c.closedAt).getTime() : new Date(t.openedAt).getTime()
      if (ts < dayStart || ts > dayEnd) continue
      const notional = t.positionUnits * c.price * (c.percent / 100)
      const fee = notional * (feeRatePct / 100)
      pnlSum += (c.pnlUsd ?? 0) - fee
      rSum += c.pnlR ?? 0
      if (c.reason) reasons.push(c.reason)
    }
    if (reasons.length === 0) continue
    closedRows.push({
      symbol: t.symbol,
      side: t.side as 'BUY' | 'SELL',
      pnlUsd: pnlSum,
      pnlR: rSum,
      reasons: reasons.join('+'),
    })
  }
  closedRows.sort((a, b) => a.symbol.localeCompare(b.symbol))
  const closedTotal = closedRows.reduce((s, r) => s + r.pnlUsd, 0)

  // SURVIVING = trades that hit TP1+ today and continue past midnight.
  // pnlUsd = realised net so far from partial closes (the remainder is still open).
  const survivingToday = await tm.findMany({
    where: {
      status: { in: ['TP1_HIT', 'TP2_HIT'] },
      openedAt: { gte: new Date(dayStart), lte: new Date(dayEnd) },
    },
    orderBy: { openedAt: 'asc' },
  })
  const survivingRows: import('./notifier').EodTradeRow[] = survivingToday.map((t: any) => ({
    symbol: t.symbol,
    side: t.side as 'BUY' | 'SELL',
    pnlUsd: (t.realizedPnlUsd ?? 0) - (t.feesPaidUsd ?? 0),
    pnlR: t.realizedR ?? 0,
  }))
  const survivingTotal = survivingRows.reduce((s, r) => s + r.pnlUsd, 0)

  return {
    closed: { variant, trades: closedRows, totalPnlUsd: closedTotal, depositUsd: deposit },
    surviving: { variant, trades: survivingRows, totalPnlUsd: survivingTotal, depositUsd: deposit },
  }
}

export async function sendBreakoutEodSummary(utcDate: string): Promise<void> {
  // Idempotency check via BreakoutConfig.lastScanResult.eodSentForDate.
  const cfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  const marker = ((cfg?.lastScanResult as any) || {}).eodSentForDate
  if (marker === utcDate) {
    console.log(`[BreakoutEOD] summary for ${utcDate} already sent — skipping`)
    return
  }

  const a = await buildVariantEodSummary('A', utcDate)
  const b = await buildVariantEodSummary('B', utcDate)

  try {
    await sendNotification('BREAKOUT_EOD_CLOSED', {
      utcDate,
      summaries: [a.closed, b.closed],
    })
  } catch (e: any) {
    console.error(`[BreakoutEOD] CLOSED notify failed: ${e.message}`)
  }

  try {
    await sendNotification('BREAKOUT_EOD_SURVIVING', {
      utcDate,
      summaries: [a.surviving, b.surviving],
    })
  } catch (e: any) {
    console.error(`[BreakoutEOD] SURVIVING notify failed: ${e.message}`)
  }

  // Mark this date so we don't re-send on restart / cron restart within minutes.
  try {
    const prev = (cfg?.lastScanResult as any) || {}
    await prisma.breakoutConfig.update({
      where: { id: 1 },
      data: { lastScanResult: { ...prev, eodSentForDate: utcDate } as any },
    })
  } catch (e: any) {
    console.warn(`[BreakoutEOD] failed to persist marker: ${e.message}`)
  }

  console.log(`[BreakoutEOD] summary sent for ${utcDate}: A closed=${a.closed.trades.length} surviving=${a.surviving.trades.length}; B closed=${b.closed.trades.length} surviving=${b.surviving.trades.length}`)
}

// Single timer per variant. Тики опрашивают БД на новые BreakoutSignal-ы и проигрывают
// 5m свечи как safety-net — реалтайм SL/TP detection делает breakoutWsTracker через
// Bybit publicTrade WebSocket. Этот тимер запускается каждую минуту: достаточно частый
// чтобы быстро открыть новую сделку при появлении сигнала, и держит 5m candle replay
// как fallback если WS отвалится.
const paperIntervals: Record<BreakoutVariant, NodeJS.Timeout | null> = { A: null, B: null }
const paperBusy: Record<BreakoutVariant, boolean> = { A: false, B: false }

export function startBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const tag = logTag(variant)
  if (paperIntervals[variant]) return
  const tick = async () => {
    if (paperBusy[variant]) return
    paperBusy[variant] = true
    try {
      const r = await runBreakoutPaperCycle(variant)
      if (r.opened > 0 || r.updated > 0) {
        console.log(`${tag} tick: opened=${r.opened} updated=${r.updated} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
      if (r.openedTrades.length > 0) {
        await notifySingleVariantOpens(r.openedTrades, variant)
      }
    } catch (e: any) { console.error(`${tag} tick error:`, e.message) }
    finally { paperBusy[variant] = false }
  }
  // Stagger boot: A starts at +60s, B at +65s — avoids both Bybit-fetching the
  // same symbol cluster at the exact same instant on first tick.
  const startDelay = variant === 'A' ? 60_000 : 65_000
  setTimeout(tick, startDelay)
  paperIntervals[variant] = setInterval(tick, 60_000)
  console.log(`${tag} started (tick=60s, realtime SL/TP via WebSocket)`)
}
export function stopBreakoutPaperTrader(variant: BreakoutVariant = 'A'): void {
  const i = paperIntervals[variant]
  if (i) { clearInterval(i); paperIntervals[variant] = null }
}

// === EOD daily summary cron ===
// Single global timer: runs every minute, fires sendBreakoutEodSummary after
// 23:55 UTC each day. Idempotent (marker in BreakoutConfig.lastScanResult), so
// process restarts mid-window don't re-send. Per-trade EXPIRED notifications
// are suppressed in trackOnePaper — this aggregate replaces them.
let eodInterval: NodeJS.Timeout | null = null
let eodBusy = false

export function startBreakoutEodSummary(): void {
  if (eodInterval) return
  const tick = async () => {
    if (eodBusy) return
    eodBusy = true
    try {
      const now = new Date()
      // Only fire in the 5-minute window 23:55–23:59 UTC. Marker prevents repeats.
      const utcHour = now.getUTCHours()
      const utcMin = now.getUTCMinutes()
      if (utcHour !== 23 || utcMin < 55) return
      const utcDate = now.toISOString().slice(0, 10)
      await sendBreakoutEodSummary(utcDate)
    } catch (e: any) {
      console.error('[BreakoutEOD] tick error:', e.message)
    } finally {
      eodBusy = false
    }
  }
  eodInterval = setInterval(tick, 60_000)
  console.log('[BreakoutEOD] started (1min cron, fires once at 23:55 UTC)')
}

export function stopBreakoutEodSummary(): void {
  if (eodInterval) { clearInterval(eodInterval); eodInterval = null }
}
