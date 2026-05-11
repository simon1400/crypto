/**
 * Daily Breakout — Variant B scale-in UP (pyramiding).
 *
 * Логика:
 *   1. Primary B-сделка открывается обычным market entry (taker) через
 *      openNewPaperTrades в dailyBreakoutPaperTrader.ts.
 *   2. Сразу после создания primary row вызывается placeScaleInLimitForPrimary()
 *      из этого файла: считает triggerPrice = entry + scaleInTriggerPct% * (TP1 - entry)
 *      и создаёт ВТОРУЮ row в BreakoutPaperTradeB с tradeType='SCALE_IN',
 *      parentTradeId=primary.id, status='PENDING', limitOrderState='PENDING_LIMIT'.
 *      Sizing-поля = 0 (заполнятся при fill).
 *   3. WS instant fill (breakoutWsTracker → processWsTradeForBScaleIn) проверяет
 *      на каждый WS trade event: если цена коснулась limitOrderPrice → fillScaleInLimit
 *      с atomic claim (защита от race condition между WS и slow tick).
 *   4. После fill: SCALE_IN row имеет свой sizing (от primary.positionUnits * scaleInSizePct%),
 *      свой maker fee, status='OPEN'. trackOnePaper подхватывает её как обычную позицию
 *      (тот же SL/TP/trailing что у primary).
 *   5. Cancel cascade:
 *      - Primary закрылась (SL/TP3/EXPIRED) ДО fill scale-in → cancel scale-in
 *        (limitOrderState='CANCELLED_PRIMARY_DONE', status='CANCELLED')
 *      - EOD 23:55 UTC: все PENDING_LIMIT > 24h → cancel
 *
 * Slot policy: SCALE_IN row ЗАНИМАЕТ concurrent slot — иначе при 20 primary
 * сразу 20 scale-in limit'ов забьют буфер. Это эквивалентно "одна позиция на
 * сетап вмещает primary + scale-in".
 *
 * Backtest 33%/75% на 365d показал улучшение B FULL с +6% до +108% годовых.
 * Backtest 33%/100% дал +136%, но DD на TEST +9pp выше — выбран 75% для баланса.
 *
 * См. memory: project_breakout_scalein_session_2026_05_11.md (если создан).
 */

import { prisma } from '../db/prisma'
import { OHLCV } from './market'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from './marginGuard'

const VARIANT_TAG = '[BreakoutPaperB:scaleIn]'

interface PaperConfigB {
  id: number
  enabled: boolean
  scaleInEnabled: boolean
  scaleInTriggerPct: number
  scaleInSizePct: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feeMakerPct: number
  targetMarginPct: number
  marginGuardEnabled: boolean
}

/**
 * Вычисляет цену срабатывания scale-in лимита.
 * Для LONG (BUY): triggerPrice = entry + (triggerPct/100) * (TP1 - entry)
 * Для SHORT (SELL): triggerPrice = entry - (triggerPct/100) * (entry - TP1)  (зеркально)
 */
function computeScaleInTriggerPrice(
  side: 'BUY' | 'SELL',
  entry: number,
  tp1: number,
  triggerPct: number,
): number {
  // (tp1 - entry) для BUY положительный (TP1 выше entry), для SELL отрицательный.
  // Формула одна и та же — works for both sides.
  return entry + (triggerPct / 100) * (tp1 - entry)
}

/**
 * Создаёт scale-in PENDING_LIMIT row сразу после открытия primary B-сделки.
 * Вызывается из openNewPaperTrades в dailyBreakoutPaperTrader.ts (B path).
 *
 * Не делает sizing — отложен до fill потому что:
 *  - депозит может измениться между placement и fill (другие закрытия)
 *  - margin guard нужно перепроверить с актуальным состоянием
 *
 * Возвращает id созданной scale-in row или null если scale-in отключён/невозможен.
 */
export async function placeScaleInLimitForPrimaryB(
  primaryTrade: {
    id: number
    signalId: number
    symbol: string
    side: string
    entryPrice: number
    stopLoss: number
    initialStop: number
    currentStop: number
    tpLadder: any
    expiresAt?: Date | null
  },
  cfg: PaperConfigB,
): Promise<number | null> {
  if (!cfg.scaleInEnabled) return null

  const tpLadder = primaryTrade.tpLadder as number[]
  if (!Array.isArray(tpLadder) || tpLadder.length === 0) {
    console.warn(`${VARIANT_TAG} primary #${primaryTrade.id} has no TP ladder — scale-in skipped`)
    return null
  }
  const tp1 = tpLadder[0]
  const side = primaryTrade.side as 'BUY' | 'SELL'
  const triggerPrice = computeScaleInTriggerPrice(side, primaryTrade.entryPrice, tp1, cfg.scaleInTriggerPct)

  // Sanity: триггер должен быть строго между entry и TP1 в направлении сделки.
  const isLong = side === 'BUY'
  const triggerValid = isLong
    ? triggerPrice > primaryTrade.entryPrice && triggerPrice < tp1
    : triggerPrice < primaryTrade.entryPrice && triggerPrice > tp1
  if (!triggerValid) {
    console.warn(`${VARIANT_TAG} invalid scale-in trigger ${triggerPrice} for primary #${primaryTrade.id} (entry=${primaryTrade.entryPrice}, tp1=${tp1}) — skipped`)
    return null
  }

  // Подозрительный edge case: цена УЖЕ за triggerPrice к моменту placement
  // (например primary открылась на сильном движении). В таком случае на бирже
  // post-only limit отвергнется. В бектесте такого не случается т.к. trigger
  // проверяется по close >= triggerPrice ПОСЛЕ открытия primary. Для реалистичности
  // оставляем PENDING_LIMIT — WS tracker через несколько ms сразу его зафиллит
  // на следующем trade event. Это эквивалент market fill на triggerPrice.
  // Альтернатива — отбрасывать такие и не делать scale-in. Пока разрешаем fill.

  const placedAt = new Date()
  const created = await prisma.breakoutPaperTradeB.create({
    data: {
      signalId: primaryTrade.signalId,
      symbol: primaryTrade.symbol,
      side: primaryTrade.side,
      entryPrice: triggerPrice,                       // тентативная цена; перезапишется на fill
      stopLoss: primaryTrade.stopLoss,
      initialStop: primaryTrade.initialStop,
      currentStop: primaryTrade.currentStop,
      tpLadder: primaryTrade.tpLadder,
      // Sizing — null/0 до fill (заполнится в fillScaleInLimitB)
      depositAtEntryUsd: 0,
      riskUsd: 0,
      positionSizeUsd: 0,
      positionUnits: 0,
      leverage: 0,
      marginUsd: 0,
      status: 'PENDING',                              // не учитывается в OPEN-стате
      openedAt: placedAt,                              // placeholder; на fill заменится
      expiresAt: primaryTrade.expiresAt,
      tradeType: 'SCALE_IN',
      parentTradeId: primaryTrade.id,
      limitOrderState: 'PENDING_LIMIT',
      limitOrderPrice: triggerPrice,
      limitPlacedAt: placedAt,
    },
  })
  console.log(`${VARIANT_TAG} placed scale-in limit #${created.id} for primary #${primaryTrade.id} ${primaryTrade.symbol} ${primaryTrade.side} @ ${triggerPrice.toFixed(6)} (${cfg.scaleInTriggerPct}% to TP1)`)
  return created.id
}

/**
 * WS instant fill — вызывается из breakoutWsTracker.ts на каждый WS trade event.
 * Проверяет PENDING_LIMIT scale-in row'ы для symbol, и если цена коснулась
 * limitOrderPrice → атомарно claim'им и заполняем.
 */
export async function processWsTradeForBScaleIn(symbol: string, price: number, ts: number): Promise<void> {
  const pending = await prisma.breakoutPaperTradeB.findMany({
    where: {
      symbol,
      tradeType: 'SCALE_IN',
      limitOrderState: 'PENDING_LIMIT',
    },
  })
  if (pending.length === 0) return

  for (const p of pending) {
    const limitPrice = p.limitOrderPrice as number
    const isLong = p.side === 'BUY'
    // Для LONG: limit срабатывает когда цена выросла и коснулась/превысила triggerPrice.
    // Для SHORT: limit срабатывает когда цена упала и коснулась/опустилась ниже triggerPrice.
    const touched = isLong ? price >= limitPrice : price <= limitPrice
    if (touched) {
      await fillScaleInLimitB(p.id, new Date(ts))
    }
  }
}

/**
 * Atomic fill scale-in limit.
 *
 * Защита от race condition: updateMany с условием PENDING_LIMIT → FILLING.
 * Если count != 1 — другой тик уже зафиллил.
 *
 * При успехе:
 *  - sizing вычисляется как primary.positionUnits * scaleInSizePct%
 *  - НЕ через computeSizing (он использовал бы risk% от depot — а для scale-in
 *    мы хотим именно фиксированную долю primary, как в бектесте)
 *  - margin guard всё равно проверяется (нельзя превысить depot)
 *  - maker fee, без slip
 *  - status='OPEN', limitOrderState='FILLED'
 */
export async function fillScaleInLimitB(scaleInTradeId: number, fillTime: Date): Promise<{ filled: boolean; reason?: string }> {
  // Atomic claim
  const claim = await prisma.breakoutPaperTradeB.updateMany({
    where: { id: scaleInTradeId, limitOrderState: 'PENDING_LIMIT' },
    data: { limitOrderState: 'FILLING' },
  })
  if (claim.count !== 1) {
    return { filled: false, reason: 'already claimed by other tick' }
  }

  const releaseClaim = async () => {
    try {
      await prisma.breakoutPaperTradeB.updateMany({
        where: { id: scaleInTradeId, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
    } catch { /* best-effort */ }
  }

  try {
    return await fillScaleInLimitInnerB(scaleInTradeId, fillTime)
  } catch (e) {
    await releaseClaim()
    throw e
  }
}

async function fillScaleInLimitInnerB(
  scaleInTradeId: number, fillTime: Date,
): Promise<{ filled: boolean; reason?: string }> {
  const scaleIn = await prisma.breakoutPaperTradeB.findUnique({ where: { id: scaleInTradeId } })
  if (!scaleIn) return { filled: false, reason: 'trade not found' }
  if (!scaleIn.parentTradeId) {
    // SCALE_IN без parent — баг. Отменяем чтобы не зависло.
    await prisma.breakoutPaperTradeB.update({
      where: { id: scaleInTradeId },
      data: {
        limitOrderState: 'CANCELLED_PRIMARY_DONE',
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    return { filled: false, reason: 'orphaned scale-in (no parent)' }
  }

  const primary = await prisma.breakoutPaperTradeB.findUnique({ where: { id: scaleIn.parentTradeId } })
  if (!primary) {
    await prisma.breakoutPaperTradeB.update({
      where: { id: scaleInTradeId },
      data: {
        limitOrderState: 'CANCELLED_PRIMARY_DONE',
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    return { filled: false, reason: 'parent trade missing' }
  }

  // Если primary уже закрылась — не открываем scale-in (опоздали).
  if (primary.status !== 'OPEN' && primary.status !== 'TP1_HIT' && primary.status !== 'TP2_HIT') {
    await prisma.breakoutPaperTradeB.update({
      where: { id: scaleInTradeId },
      data: {
        limitOrderState: 'CANCELLED_PRIMARY_DONE',
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    console.log(`${VARIANT_TAG} cancelled scale-in #${scaleInTradeId} — primary #${primary.id} already ${primary.status}`)
    return { filled: false, reason: `primary already ${primary.status}` }
  }

  const cfg = await prisma.breakoutPaperConfigB.findUnique({ where: { id: 1 } })
  if (!cfg) return { filled: false, reason: 'config missing' }

  const fillPrice = scaleIn.limitOrderPrice as number
  const isLong = scaleIn.side === 'BUY'

  // Sizing: фиксированная доля primary.positionUnits.
  // Не через computeSizing — нам нужно exactly sizePct% от primary, не пересчёт по risk.
  const scaleInUnits = primary.positionUnits * (cfg.scaleInSizePct / 100)
  const positionSizeUsd = scaleInUnits * fillPrice
  // Margin: тот же leverage что у primary (или recompute через target margin)
  // Используем тот же leverage чтобы не плодить параметров.
  const leverage = primary.leverage ?? 1
  const marginUsd = positionSizeUsd / leverage
  const slDist = Math.abs(fillPrice - scaleIn.stopLoss)
  const riskUsd = scaleInUnits * slDist

  // Margin guard: проверяем что хватит свободного депо на эту дополнительную margin
  if (cfg.marginGuardEnabled) {
    const openTrades = await prisma.breakoutPaperTradeB.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    const existing: ExistingTrade[] = openTrades.map(t => ({
      id: t.id, symbol: t.symbol, status: t.status as any,
      positionSizeUsd: t.positionSizeUsd,
      closedFrac: ((t.closes as any[]) ?? []).reduce((a, c: any) => a + (c.percent ?? 0), 0) / 100,
      leverage: t.leverage ?? 1,
      unrealizedR: 0,
      hasTP1: t.status === 'TP1_HIT' || t.status === 'TP2_HIT',
      hasTP2: t.status === 'TP2_HIT',
    }))
    const guard = evaluateOpenWithGuard(
      cfg.currentDepositUsd, marginUsd, existing,
      positionSizeUsd, scaleIn.symbol,
    )
    if (!guard.canOpen) {
      await prisma.breakoutPaperTradeB.update({
        where: { id: scaleInTradeId },
        data: {
          limitOrderState: 'CANCELLED_PRIMARY_DONE',
          status: 'CANCELLED',
          closedAt: fillTime,
        },
      })
      console.warn(`${VARIANT_TAG} cancelled scale-in #${scaleInTradeId} — margin guard: ${guard.reason}`)
      return { filled: false, reason: guard.reason }
    }
  }

  const entryFeeUsd = scaleInUnits * fillPrice * (cfg.feeMakerPct / 100)

  await prisma.breakoutPaperTradeB.update({
    where: { id: scaleInTradeId },
    data: {
      status: 'OPEN',
      entryPrice: fillPrice,
      depositAtEntryUsd: cfg.currentDepositUsd,
      riskUsd,
      positionSizeUsd,
      positionUnits: scaleInUnits,
      leverage,
      marginUsd,
      feesPaidUsd: entryFeeUsd,
      slipPaidUsd: 0,
      openedAt: fillTime,
      limitOrderState: 'FILLED',
      limitFilledAt: fillTime,
    },
  })

  await prisma.breakoutPaperConfigB.update({
    where: { id: 1 },
    data: { currentDepositUsd: { decrement: entryFeeUsd } },
  })

  console.log(`${VARIANT_TAG} ✓ filled scale-in #${scaleInTradeId} (parent #${primary.id}) ${scaleIn.symbol} ${scaleIn.side} @ ${fillPrice.toFixed(6)} units=${scaleInUnits.toFixed(4)} (${cfg.scaleInSizePct}% of primary)`)

  return { filled: true }
}

/**
 * Cancel scale-in PENDING_LIMIT для конкретного primary (вызывается из trackOnePaper
 * когда primary терминально закрылся).
 *
 * Idempotent: если scale-in уже FILLED или CANCELLED — не трогаем.
 */
export async function cancelScaleInForPrimaryB(
  primaryTradeId: number,
  reason: 'primary_closed' | 'eod' = 'primary_closed',
): Promise<{ cancelled: number }> {
  const state = reason === 'eod' ? 'CANCELLED_EOD' : 'CANCELLED_PRIMARY_DONE'
  const r = await prisma.breakoutPaperTradeB.updateMany({
    where: {
      parentTradeId: primaryTradeId,
      tradeType: 'SCALE_IN',
      limitOrderState: 'PENDING_LIMIT',
    },
    data: {
      limitOrderState: state,
      status: 'CANCELLED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${VARIANT_TAG} cancelled ${r.count} scale-in PENDING_LIMIT for primary #${primaryTradeId} (reason=${reason})`)
  }
  return { cancelled: r.count }
}

/**
 * EOD job: отменить все PENDING_LIMIT scale-in старше 24h.
 * Вызывается из dailyBreakoutPaperTrader.sendBreakoutEodSummary().
 */
export async function cancelStaleScaleInLimitsBEod(): Promise<{ cancelled: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000)
  const r = await prisma.breakoutPaperTradeB.updateMany({
    where: {
      tradeType: 'SCALE_IN',
      limitOrderState: 'PENDING_LIMIT',
      limitPlacedAt: { lt: cutoff },
    },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'CANCELLED',
      closedAt: new Date(),
    },
  })
  if (r.count > 0) {
    console.log(`${VARIANT_TAG} EOD cancelled ${r.count} stale scale-in PENDING_LIMIT (>24h)`)
  }
  return { cancelled: r.count }
}

/**
 * Slow tick safety net: на случай WS disconnect — проверяем PENDING_LIMIT scale-in
 * против последних свечей. Если цена коснулась limitPrice → fill.
 *
 * Вызывается из dailyBreakoutPaperTrader.runBreakoutPaperCycle('B') после
 * trackOpenPaperTrades в каждом цикле.
 */
export async function checkScaleInLimitsAgainstCandlesB(symbol: string, candles: OHLCV[]): Promise<void> {
  if (candles.length === 0) return
  const pending = await prisma.breakoutPaperTradeB.findMany({
    where: {
      symbol,
      tradeType: 'SCALE_IN',
      limitOrderState: 'PENDING_LIMIT',
    },
  })
  if (pending.length === 0) return

  for (const p of pending) {
    const limitPrice = p.limitOrderPrice as number
    const isLong = p.side === 'BUY'
    const sinceMs = p.limitPlacedAt ? new Date(p.limitPlacedAt).getTime() : new Date(p.openedAt).getTime()
    const newCandles = candles.filter(c => c.time > sinceMs)
    let touchTime: number | null = null
    for (const c of newCandles) {
      const touched = isLong ? c.high >= limitPrice : c.low <= limitPrice
      if (touched) { touchTime = c.time; break }
    }
    if (touchTime != null) {
      await fillScaleInLimitB(p.id, new Date(touchTime))
    }
  }
}
