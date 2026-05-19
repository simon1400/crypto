/**
 * Live trade tracker — applies SL/TP detection on 5m candle replay (safety
 * net) and individual WS ticks (real-time).
 *
 * `trackOnePaper` is the core: given a trade + new candles since last check,
 * detect SL/TP hits, trail SL, record fills, send Telegram, atomic-update DB
 * (compare-and-set against WS/slow-tick race).
 *
 * `trackOpenPaperTrades` — replays current 5m candles for all OPEN trades (60s
 * safety net).
 *
 * `runTrackForSymbol` — WS entrypoint, processes a single tick per symbol
 * across all variants, fires slot-refill via openNewPaperTrades after terminal
 * closes (A/B only — C uses limit-on-rangeEdge via dailyBreakoutLimitTrader).
 */

import { OHLCV } from '../market'
import { sendNotification } from '../notifier'
import { BreakoutVariant, configModel, tradeModel, tgPrefix, logTag } from '../breakoutVariant'
import { PaperConfig, CloseRecord } from './types'
import { SPLITS, getRealisticRates, takerFillPrice, isMakerFill } from './fees'
import { getOrCreateConfig, loadRecent5m } from './config'
import { syncSignalStatus } from './signalSync'
import { applyDepositDelta } from './deposit'
import { notifySingleVariantOpens } from './notify'

export async function trackOnePaper(trade: any, candles: OHLCV[], cfg: PaperConfig, variant: BreakoutVariant, isFastTick: boolean = false): Promise<{ pnlDelta: number; statusChanged: boolean; terminalClosed: boolean }> {
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

  // EOD-FLAT policy: at 23:55 UTC close any still-open trade by market, regardless
  // of whether TP1 was hit. Reverted from EOD-NO-TP1 by user request 2026-05-15 —
  // hold-overnight behaviour caused open trades to drift across days.
  if (status !== 'CLOSED' && status !== 'SL_HIT' && trade.expiresAt && new Date(trade.expiresAt) < new Date()) {
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
  // Atomic compare-and-set guard against WS-tick vs slow-tick race:
  // both can read the same `trade` row (status=OPEN, closes=[]) and independently
  // record TP1, sending two Telegram messages for one fill. We update only if the
  // row still matches the state we read at the top of this fn (status + the
  // previously-recorded number of closes). If a concurrent tick already wrote
  // the same transition, count=0 and we skip notifications / depositDelta.
  const updated = await tm.updateMany({
    where: {
      id: trade.id,
      status: trade.status,
      // Prisma can't filter by JSON-array length directly; use realizedR which
      // strictly monotonically increases on every fill event (TP1/TP2/TP3 add
      // positive R, SL adds remaining-frac R). Matching the value we read is a
      // sufficient guard — if another tick already applied any fill, realizedR
      // moved and our update lands count=0.
      realizedR: trade.realizedR ?? 0,
    },
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
  if (updated.count === 0) {
    // Lost the race — another tick already applied this transition. Skip
    // notifications and depositDelta to avoid duplicate Telegram + double-count.
    return { pnlDelta: 0, statusChanged: false, terminalClosed: false }
  }

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

export async function trackOpenPaperTrades(cfg: PaperConfig, variant: BreakoutVariant): Promise<{ updated: number; depositDelta: number; terminalClosed: number }> {
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
  // Lazy import to break the import cycle: track → open → (depends on nothing
  // problematic, but the dynamic import shrinks the dep graph if open ever
  // grows to depend on track again).
  const { openNewPaperTrades } = await import('./open')
  for (const variant of ['A', 'B', 'C'] as BreakoutVariant[]) {
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
      // Только A/B используют market entry (openNewPaperTrades). Variant C
      // использует limit-on-rangeEdge через отдельный сервис dailyBreakoutLimitTrader,
      // поэтому здесь refill не нужен — C сам подберёт свободные слоты на следующем
      // 60s cycle limit trader'а.
      if (terminalClosed > 0 && variant !== 'C') {
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
