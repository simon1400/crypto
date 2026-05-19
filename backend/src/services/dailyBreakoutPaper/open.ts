/**
 * Open new paper trades from the BreakoutSignal stream + force-open API.
 *
 * Each cycle:
 *   1. Check daily circuit breaker — block all entries if today's UTC closed
 *      losses exceed dailyLossLimitR or dailyLossLimitPct.
 *   2. For each NEW/ACTIVE/TP1_HIT/TP2_HIT signal that this variant hasn't
 *      traded yet:
 *      - per-symbol-day gate
 *      - concurrent-positions cap
 *      - staleness (> 30 min since signal created)
 *      - live-price retrace / overshoot / min-entry-TP1-distance gates
 *      - margin guard
 *   3. Compute sizing with realistic slip applied to entry, charge entry
 *      taker fee, create the trade row.
 */

import { prisma } from '../../db/prisma'
import { fetchPricesBatch } from '../market'
import {
  computeSizing, evaluateOpenWithGuard, ExistingTrade, getMaxLeverage,
} from '../marginGuard'
import { sendNotification } from '../notifier'
import { BreakoutVariant, configModel, tradeModel, tgPrefix, logTag } from '../breakoutVariant'
import { PaperConfig, OpenedTradeInfo } from './types'
import { takerFillPrice } from './fees'
import { isVariantBusyOnSymbol, isCircuitBreakerTripped, cbTelegramSent } from './gating'
import { buildExistingTrade, marketCloseForMargin } from './marginClose'
import { syncSignalStatus } from './signalSync'
import { getOrCreateConfig } from './config'
import { applyDepositDelta } from './deposit'

export async function openNewPaperTrades(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ opened: number; depositDelta: number; openedTrades: OpenedTradeInfo[] }> {
  const tag = logTag(variant)
  const tm = tradeModel(variant) as any
  const cm = configModel(variant) as any

  // Daily circuit breaker — block new entries if today's UTC closed trades
  // breached either the R or the % threshold. Open positions still trail.
  const cb = await isCircuitBreakerTripped(cfg, variant)
  if (cb.tripped) {
    console.warn(`${tag} ${cb.reason} — блокирую новые входы до следующего UTC дня`)
    // Telegram alert once per UTC day per variant. In-memory dedup is enough —
    // a process restart that re-fires the alert is acceptable behaviour.
    const utcDate = new Date().toISOString().slice(0, 10)
    const cbKey = `${variant}-${utcDate}`
    if (!cbTelegramSent.has(cbKey)) {
      cbTelegramSent.add(cbKey)
      try {
        await sendNotification('BREAKOUT_OPENED' as any, {
          symbol: `${tgPrefix(variant)}CIRCUIT BREAKER`,
          side: 'INFO' as any,
          reason: `${cb.reason}. Новые входы блокированы до 00:00 UTC.`,
          variants: [],
        })
      } catch { /* notification errors are non-fatal */ }
    }
    return { opened: 0, depositDelta: 0, openedTrades: [] }
  }

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

  // Each variant has its own paperStatus/paperReason fields on the shared
  // BreakoutSignal row (no suffix = A, B = paperStatusB, C = paperStatusC) so
  // skip reasons are visible per-variant in the Signals tab.
  async function markPaperStatus(signalId: number, status: 'OPENED' | 'SKIPPED', reason: string | null) {
    const data = variant === 'A'
      ? { paperStatus: status, paperReason: reason, paperUpdatedAt: new Date() }
      : variant === 'B'
      ? { paperStatusB: status, paperReasonB: reason, paperUpdatedAtB: new Date() }
      : { paperStatusC: status, paperReasonC: reason, paperUpdatedAtC: new Date() }
    try {
      await prisma.breakoutSignal.update({ where: { id: signalId }, data })
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
      const r = `уже взят сегодня (или активный carry-over с прошлого дня)`
      console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — ${r}`)
      await markPaperStatus(sig.id, 'SKIPPED', r)
      continue
    }

    const openTrades = await tm.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    if (openTrades.length >= cfg.maxConcurrentPositions) {
      const r = `лимит одновременных позиций (${cfg.maxConcurrentPositions}) достигнут`
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
      const ageMin = Math.round(ageMs / 60_000)
      const r = `просрочен (${ageMin} мин в ожидании слота)`
      // markPaperStatus first — for A the row will be gone after delete; for B the
      // delete is a no-op so the mark sticks.
      await markPaperStatus(sig.id, 'SKIPPED', r)
      await deleteSharedSignal(sig.id, r, sig.symbol)
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
        const r = `цена вернулась в диапазон (live ${livePrice.toFixed(4)} vs край ${edge.toFixed(4)})`
        await markPaperStatus(sig.id, 'SKIPPED', r)
        await deleteSharedSignal(sig.id, r, sig.symbol)
        continue
      }

      const tp1 = (sig.tpLadder as number[])[0]
      const overshot = sig.side === 'BUY' ? livePrice >= tp1 : livePrice <= tp1
      if (overshot) {
        const r = `цена ушла за TP1 (live ${livePrice.toFixed(6)} vs TP1 ${tp1.toFixed(6)})`
        await markPaperStatus(sig.id, 'SKIPPED', r)
        await deleteSharedSignal(sig.id, r, sig.symbol)
        continue
      }

      // Min entry→TP1 distance guard: fast-mover breakout где live entry уже подошла
      // близко к TP1. Даже при TP1-hit fees+slip+BE-out сценарий = гарантированный
      // микроминус (как AERO #111: entry 0.5196, TP1 0.5205, dist 0.17%, итог -$0.02).
      // Backtest 365d (runBacktest_dailybreak_entry_tp1.ts, live formula): bucket
      // 0.3-0.5% → R/tr -0.11, bucket 0.2-0.3% → -0.26. Фильтр ≥0.5% отбрасывает
      // 3% сделок (52 из 1928), edge не падает на FULL/TRAIN/TEST, TEST даже растёт
      // +0.20 → +0.21 R/tr. Фильтр >=1.0% уже режет полезные (TEST падает до +0.11).
      const MIN_ENTRY_TP1_PCT = 0.5
      const entryTp1Pct = (Math.abs(tp1 - livePrice) / livePrice) * 100
      if (entryTp1Pct < MIN_ENTRY_TP1_PCT) {
        await deleteSharedSignal(sig.id, `entry too close to TP1 (${entryTp1Pct.toFixed(2)}% < ${MIN_ENTRY_TP1_PCT}%, live ${livePrice.toFixed(6)} vs TP1 ${tp1.toFixed(6)})`, sig.symbol)
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
      await markPaperStatus(sig.id, 'SKIPPED', 'не удалось рассчитать размер позиции (0 units)')
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
        const r = `${guard.reason} (нужно $${guard.marginRequired.toFixed(2)}, свободно $${guard.marginAvailableBefore.toFixed(2)})`
        console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — ${r}`)
        await markPaperStatus(sig.id, 'SKIPPED', r)
        continue
      }

      if (guard.toClose.length > 0) {
        if (!cfg.marginGuardAutoClose) {
          const r = `требуется закрыть ${guard.toClose.length} прибыльных позиций, но авто-закрытие выключено`
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
    return { ok: false, reason: 'не удалось рассчитать размер позиции (0 units)' }
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

  // Now that the trade row carries feesPaidUsd=entryFeeUsd, applyDepositDelta
  // will decrement currentDeposit and recompute totalPnLUsd from the table in
  // a single consistent step.
  await applyDepositDelta(cfg, -entryFeeUsd, variant)

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
