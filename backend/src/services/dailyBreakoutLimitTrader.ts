/**
 * Daily Breakout — variant C: limit-on-rangeEdge entry mechanics.
 *
 * Параллельная копия paper trader'а с ОДНИМ принципиальным отличием от A/B:
 *   - A/B: market entry (taker fee + slip) на c.close триггерной свечи когда
 *     5m свеча закрылась за rangeHigh/rangeLow.
 *   - C:   limit ордер на rangeHigh (BUY) или rangeLow (SELL) выставляется
 *     СРАЗУ как только сигнал появился, и заполняется ТОЧНО по этой цене как
 *     только цена касается уровня (maker fee, без slip).
 *
 * Backtest 2026-05-10 (runBacktest_dailybreak_binance_AB.ts) показал ×9-22
 * улучшение доходности vs market entry (A: $1142→$10221, B: $571→$12461 за
 * 365d), DD падает с 88% до 62%. См. project_breakout_limit_entry_finding_2026_05_10.md.
 *
 * Жизненный цикл сделки в C:
 *   1. Сигнал создан scanner'ом → создаём ОДНУ строку в TradeC с
 *      limitOrderState='PENDING_LIMIT', limitOrderPrice=rangeHigh (BUY) /
 *      rangeLow (SELL). Sizing НЕ делаем (deposit может измениться к моменту fill).
 *   2. Каждый tick (slow 5m + WS instant) проверяем PENDING_LIMIT для символа.
 *      Если price коснулся limitOrderPrice → fillLimit():
 *      - sizing с актуальным deposit
 *      - state=FILLED, обычный lifecycle далее
 *      - charged maker fee (НЕ taker), без slip
 *   3. EOD job в 23:55 UTC: все PENDING_LIMIT за вчерашний rangeDate → CANCELLED_EOD.
 *
 * PENDING_LIMIT занимает concurrent slot — без этого можно «разлить» лимиты на
 * все 23 монеты и потом не хватит депо при fill.
 *
 * Important: для C мы создаём только ОДИН trade-row на сигнал (не 2 как могло
 * быть). Сигнал уже знает направление (BUY или SELL) — scanner выбирает
 * направление пробоя при генерации сигнала. Мы просто меняем механику входа.
 *
 * После fill жизненный цикл идентичен A/B — используется существующий
 * trackOnePaper через runTrackForSymbol, который уже variant-aware.
 */

import { prisma } from '../db/prisma'
import { OHLCV, fetchPricesBatch } from './market'
import { computeSizing, evaluateOpenWithGuard, ExistingTrade } from './marginGuard'
import {
  configModel, tradeModel, tgPrefix, logTag, BreakoutVariant,
} from './breakoutVariant'
import {
  getRealisticRates, syncSignalStatus, isVariantBusyOnSymbol, runTrackForSymbol,
} from './dailyBreakoutPaperTrader'
import { sendNotification } from './notifier'

const VARIANT: BreakoutVariant = 'C'

interface PaperConfigC {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feesRoundTripPct: number
  feeTakerPct: number
  feeMakerPct: number
  slipTakerPct: number
  autoTrailingSL: boolean
  targetMarginPct: number
  marginGuardEnabled: boolean
  marginGuardAutoClose: boolean
  maxConcurrentPositions: number
  peakDepositUsd: number
  maxDrawdownPct: number
}

async function getOrCreateConfigC(): Promise<PaperConfigC | null> {
  try {
    const c = await (configModel(VARIANT) as any).upsert({
      where: { id: 1 }, update: {}, create: { id: 1 },
    })
    return c as PaperConfigC
  } catch (e: any) {
    if (e?.message?.includes('does not exist')) return null
    throw e
  }
}

/**
 * Для каждого нового сигнала создаём PENDING_LIMIT trade-row.
 * Limit price = rangeHigh для BUY (мы хотим купить ровно на пробое верхней
 * границы) или rangeLow для SELL.
 *
 * Не делаем sizing здесь — он отложен до fill, потому что между placement и
 * fill могут пройти часы и deposit может измениться (другая C-сделка закрылась
 * с +/-).
 */
async function placePendingLimits(cfg: PaperConfigC): Promise<{ placed: number }> {
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any

  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const signals = await prisma.breakoutSignal.findMany({
    where: {
      createdAt: { gte: since },
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (signals.length === 0) return { placed: 0 }

  const existingTrades = await tm.findMany({
    where: { signalId: { in: signals.map(s => s.id) } },
    select: { signalId: true },
  })
  const existingIds = new Set(existingTrades.map((t: any) => t.signalId))

  let placed = 0
  for (const sig of signals) {
    if (existingIds.has(sig.id)) continue

    // Same-day-per-symbol guard (как в A/B)
    if (await isVariantBusyOnSymbol(sig.symbol, sig.rangeDate, VARIANT)) {
      console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — already busy on symbol today`)
      continue
    }

    // Concurrent slot guard. PENDING_LIMIT занимает слот — иначе можно разлить
    // limit на 23 монеты разом и потом не хватит депо на fill.
    const activeOrPending = await tm.count({
      where: {
        OR: [
          { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
          { limitOrderState: 'PENDING_LIMIT' },
        ],
      },
    })
    if (activeOrPending >= cfg.maxConcurrentPositions) {
      console.log(`${tag} skip sig ${sig.id} — maxConcurrent=${cfg.maxConcurrentPositions} reached (incl. pending limits)`)
      continue
    }

    // Stale signal guard (как в A/B): >30 мин — пробой устарел, range уже не актуален.
    const STALE_MIN = 30
    const ageMs = Date.now() - new Date(sig.createdAt).getTime()
    if (ageMs > STALE_MIN * 60_000) {
      console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — stale ${Math.round(ageMs / 60_000)}min`)
      continue
    }

    // Pre-flight retrace check: limit price = rangeEdge. Если live уже сильно
    // ниже rangeHigh (для BUY) — ставить limit бессмысленно, он сразу зафиллится
    // только при возврате цены к уровню (т.е. при ОБРАТНОМ движении), а это
    // уже не пробой а просто торговля у уровня. Пропускаем такие сигналы.
    let livePrice: number | null = null
    try {
      const prices = await fetchPricesBatch([sig.symbol])
      const live = prices[sig.symbol]
      if (live && live > 0) livePrice = live
    } catch { /* keep livePrice null — без retrace check */ }

    if (livePrice != null) {
      // Limit-on-rangeEdge может стоять в стакане ТОЛЬКО если live цена не пересекла
      // уровень с другой стороны:
      //   - BUY limit @ rangeHigh: cтавим если price <= rangeHigh (limit ниже рынка
      //     для шорта пробоя — невозможен, для лонга это «купить на откате к уровню»;
      //     если price > rangeHigh уже сейчас — биржа отвергнет post-only или исполнит
      //     как market по текущей цене, не по rangeHigh — нечестно к backtest модели).
      //   - SELL limit @ rangeLow: cтавим если price >= rangeLow.
      // Если уже за уровнем — пробой произошёл без нас, пропускаем (как overshoot guard).
      const limitPrice = sig.side === 'BUY' ? sig.rangeHigh : sig.rangeLow
      const alreadyOvershot = sig.side === 'BUY'
        ? livePrice > limitPrice
        : livePrice < limitPrice
      if (alreadyOvershot) {
        console.log(`${tag} skip sig ${sig.id} ${sig.symbol} — price ${livePrice} already past limit edge ${limitPrice} (post-only would reject)`)
        continue
      }
    }

    // Создаём PENDING_LIMIT строку. Sizing-поля заполняем заглушками (0) —
    // настоящие значения попадут в fillLimit() с актуальным deposit.
    const limitPrice = sig.side === 'BUY' ? sig.rangeHigh : sig.rangeLow
    const placedAt = new Date()
    await tm.create({
      data: {
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.side,
        entryPrice: limitPrice,
        stopLoss: sig.stopLoss,
        initialStop: sig.initialStop,
        currentStop: sig.currentStop,
        tpLadder: sig.tpLadder as any,
        openedAt: placedAt,           // время выставления limit (обновится в fill)
        depositAtEntryUsd: 0,         // заполнится в fill
        riskUsd: 0,
        positionSizeUsd: 0,
        positionUnits: 0,
        leverage: null,
        marginUsd: null,
        feesRoundTripPct: cfg.feesRoundTripPct,
        feeTakerPct: cfg.feeTakerPct,
        feeMakerPct: cfg.feeMakerPct,
        slipTakerPct: cfg.slipTakerPct,
        feesPaidUsd: 0,
        slipPaidUsd: 0,
        autoTrailingSL: cfg.autoTrailingSL,
        status: 'PENDING',            // отдельный статус — НЕ участвует в trackOnePaper
        expiresAt: sig.expiresAt,
        // Limit-specific:
        limitOrderState: 'PENDING_LIMIT',
        limitOrderPrice: limitPrice,
        limitPlacedAt: placedAt,
      },
    })
    placed++
    console.log(`${tag} placed limit ${sig.side} ${sig.symbol} @ ${limitPrice} (sig #${sig.id})`)
  }

  return { placed }
}

/**
 * Fill PENDING_LIMIT по структурной цене limitOrderPrice (НЕ по live price —
 * лимит исполняется ровно на своём уровне, в этом и весь смысл варианта C).
 *
 * Maker fee, без slip. Sizing с актуальным deposit. Обновляет статус на 'OPEN'
 * чтобы trackOnePaper из A/B логики подхватил его как обычную сделку.
 */
async function fillLimit(tradeId: number, fillTime: Date): Promise<{ filled: boolean; reason?: string }> {
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any
  const cm = configModel(VARIANT) as any

  // Атомарный claim — если параллельные WS events / slow tick тригерят fillLimit
  // одновременно для одной сделки, только один из них пройдёт. Маркируем
  // 'FILLING' (промежуточное состояние) и проверяем что count=1 — иначе кто-то
  // другой уже зафиллил.
  const claim = await tm.updateMany({
    where: { id: tradeId, limitOrderState: 'PENDING_LIMIT' },
    data: { limitOrderState: 'FILLING' },
  })
  if (claim.count !== 1) {
    return { filled: false, reason: 'already claimed by other tick' }
  }

  // С момента claim — обязательно довести до конечного состояния.
  // Если throw до финального update — вернуть в PENDING_LIMIT чтобы следующий
  // tick попробовал снова (иначе сделка застрянет в FILLING навсегда).
  const releaseClaim = async () => {
    try {
      await tm.updateMany({
        where: { id: tradeId, limitOrderState: 'FILLING' },
        data: { limitOrderState: 'PENDING_LIMIT' },
      })
    } catch { /* best-effort rollback */ }
  }

  try {
    return await fillLimitInner(tradeId, fillTime, tm, cm, tag)
  } catch (e) {
    await releaseClaim()
    throw e
  }
}

async function fillLimitInner(
  tradeId: number, fillTime: Date, tm: any, cm: any, tag: string,
): Promise<{ filled: boolean; reason?: string }> {
  const trade = await tm.findUnique({ where: { id: tradeId } })
  if (!trade) return { filled: false, reason: 'trade not found' }

  const cfg = await cm.findUnique({ where: { id: 1 } })
  if (!cfg) return { filled: false, reason: 'config missing' }

  const fillPrice: number = trade.limitOrderPrice
  const isLong = trade.side === 'BUY'

  // Sizing on актуальный deposit (может отличаться от placement-time).
  const sizing = computeSizing({
    symbol: trade.symbol,
    deposit: cfg.currentDepositUsd,
    riskPct: cfg.riskPctPerTrade,
    targetMarginPct: cfg.targetMarginPct,
    entry: fillPrice,
    sl: trade.stopLoss,
  })
  if (!sizing || sizing.positionUnits <= 0) {
    // Sizing не получился — отменяем limit, освобождаем слот.
    await tm.update({
      where: { id: tradeId },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',  // переиспользуем для "не смогли"
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    console.warn(`${tag} cancelled limit #${tradeId} ${trade.symbol} — sizing failed at fill`)
    return { filled: false, reason: 'sizing failed' }
  }

  let finalMargin = sizing.marginUsd
  let finalLeverage = sizing.leverage

  if (cfg.marginGuardEnabled) {
    const openTrades = await tm.findMany({
      where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    })
    const existing: ExistingTrade[] = openTrades.map((t: any) => ({
      id: t.id, symbol: t.symbol, status: t.status,
      positionSizeUsd: t.positionSizeUsd,
      closedFrac: ((t.closes as any[]) ?? []).reduce((a, c) => a + (c.percent ?? 0), 0) / 100,
      leverage: t.leverage ?? 1,
      unrealizedR: 0,
      hasTP1: t.status === 'TP1_HIT' || t.status === 'TP2_HIT',
      hasTP2: t.status === 'TP2_HIT',
    }))
    const guard = evaluateOpenWithGuard(
      cfg.currentDepositUsd, sizing.marginUsd, existing,
      sizing.positionSizeUsd, trade.symbol,
    )
    if (!guard.canOpen) {
      await tm.update({
        where: { id: tradeId },
        data: {
          limitOrderState: 'CANCELLED_OTHER_SIDE',
          status: 'CANCELLED',
          closedAt: fillTime,
        },
      })
      console.warn(`${tag} cancelled limit #${tradeId} ${trade.symbol} — margin guard: ${guard.reason}`)
      return { filled: false, reason: guard.reason }
    }
    if (guard.downsizedMargin != null && guard.downsizedLeverage != null) {
      finalMargin = guard.downsizedMargin
      finalLeverage = guard.downsizedLeverage
    }
  }

  // Maker fee — limit стоит в стакане, не taker. Без slip.
  const entryFeeUsd = sizing.positionUnits * fillPrice * (cfg.feeMakerPct / 100)

  await tm.update({
    where: { id: tradeId },
    data: {
      status: 'OPEN',                      // стандартный lifecycle далее
      entryPrice: fillPrice,               // exact fill на rangeEdge
      depositAtEntryUsd: cfg.currentDepositUsd,
      riskUsd: sizing.riskUsd,
      positionSizeUsd: sizing.positionSizeUsd,
      positionUnits: sizing.positionUnits,
      leverage: finalLeverage,
      marginUsd: finalMargin,
      feesPaidUsd: entryFeeUsd,
      slipPaidUsd: 0,                      // limit fill — slip = 0
      openedAt: fillTime,                  // обновляем — это и есть время реального открытия
      limitOrderState: 'FILLED',
      limitFilledAt: fillTime,
    },
  })

  // Обновляем deposit (списываем maker fee).
  await cm.update({
    where: { id: 1 },
    data: { currentDepositUsd: { decrement: entryFeeUsd } },
  })

  console.log(`${tag} ✓ filled limit #${tradeId} ${trade.symbol} ${trade.side} @ ${fillPrice} (size $${sizing.positionSizeUsd.toFixed(0)}, lev ×${finalLeverage.toFixed(1)})`)

  // Telegram notification — переиспользуем BREAKOUT_OPENED шаблон. Шаблон ждёт
  // массив `variants` (VariantOpenInfo[]) со sizing-блоком на каждый вариант.
  // Без этого тело сообщения будет пустым (только заголовок + reason).
  try {
    await sendNotification('BREAKOUT_OPENED' as any, {
      symbol: trade.symbol,
      side: trade.side,
      reason: 'limit fill on rangeEdge (variant C)',
      variants: [{
        variant: 'C',
        depositUsd: cfg.currentDepositUsd,
        riskPctPerTrade: cfg.riskPctPerTrade,
        riskUsd: sizing.riskUsd,
        positionSizeUsd: sizing.positionSizeUsd,
        positionUnits: sizing.positionUnits,
        marginUsd: finalMargin,
        leverage: finalLeverage,
        cappedByMaxLeverage: !!sizing.cappedByMaxLeverage,
        targetMarginPct: cfg.targetMarginPct,
      }],
    })
  } catch { /* notification errors are non-fatal */ }

  return { filled: true }
}

/**
 * Slow tick: проверяем все PENDING_LIMIT — за прошедшие 5m свечи мог быть
 * туч цены через limit. WS instant fill уже обработал большинство, но
 * safety-net через REST candles на случай WS дисконнекта.
 */
async function checkPendingLimitsAgainstCandles(symbol: string, candles: OHLCV[]): Promise<void> {
  if (candles.length === 0) return
  const tm = tradeModel(VARIANT) as any
  const pending = await tm.findMany({
    where: { symbol, limitOrderState: 'PENDING_LIMIT' },
  })
  if (pending.length === 0) return

  for (const p of pending) {
    const limitPrice = p.limitOrderPrice as number
    const isLong = p.side === 'BUY'
    // Берём только свечи после placement
    const sinceMs = new Date(p.limitPlacedAt).getTime()
    const newCandles = candles.filter(c => c.time > sinceMs)
    let touchTime: number | null = null
    for (const c of newCandles) {
      const touched = isLong ? c.high >= limitPrice : c.low <= limitPrice
      if (touched) { touchTime = c.time; break }
    }
    if (touchTime != null) {
      await fillLimit(p.id, new Date(touchTime))
    }
  }
}

/**
 * WS instant fill — вызывается из breakoutWsTracker.ts на каждый WS trade event.
 * Намного быстрее slow tick (миллисекунды vs до 5 минут).
 */
export async function processWsTradeForLimits(symbol: string, price: number, ts: number): Promise<void> {
  const tm = tradeModel(VARIANT) as any
  const pending = await tm.findMany({
    where: { symbol, limitOrderState: 'PENDING_LIMIT' },
  })
  if (pending.length === 0) return

  for (const p of pending) {
    const limitPrice = p.limitOrderPrice as number
    const isLong = p.side === 'BUY'
    const touched = isLong ? price >= limitPrice : price <= limitPrice
    if (touched) {
      await fillLimit(p.id, new Date(ts))
    }
  }
}

/**
 * EOD job — отменяем все PENDING_LIMIT за вчерашний UTC день.
 * Не сработавший за день limit = пропущенный пробой, range уже не актуален.
 */
export async function cancelStaleLimitsEod(): Promise<{ cancelled: number }> {
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any
  // Cutoff = 24 часа назад
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000)

  const stale = await tm.findMany({
    where: {
      limitOrderState: 'PENDING_LIMIT',
      limitPlacedAt: { lt: cutoff },
    },
  })
  if (stale.length === 0) return { cancelled: 0 }

  await tm.updateMany({
    where: { id: { in: stale.map((t: any) => t.id) } },
    data: {
      limitOrderState: 'CANCELLED_EOD',
      status: 'EXPIRED',
      closedAt: new Date(),
    },
  })
  console.log(`${tag} EOD cancelled ${stale.length} stale limit orders`)
  return { cancelled: stale.length }
}

/**
 * Один цикл variant C:
 *   1. placePendingLimits — для новых сигналов выставить лимиты
 *   2. checkPendingLimitsAgainstCandles per symbol — slow tick fill safety
 *   3. runTrackForSymbol для FILLED сделок (через общий trackOnePaper) —
 *      это уже делается в paperTrader cycle через variant routing, поэтому
 *      здесь нам нужен только placement + safety-net check.
 */
export async function runBreakoutLimitCycleC(): Promise<{ placed: number }> {
  const cfg = await getOrCreateConfigC()
  if (!cfg || !cfg.enabled) return { placed: 0 }
  const r = await placePendingLimits(cfg)
  return r
}

/**
 * Slow tick safety-net для variant C — переберём все символы с PENDING_LIMIT,
 * для каждого загрузим последние 5m свечи через runTrackForSymbol-flow и
 * проверим не задели ли limit. WS instant fill всё равно первый, это backup.
 *
 * Вызывается из общего scanner cycle (или отдельным таймером).
 */
export async function safetyNetCheckLimitsC(loadCandles: (symbol: string) => Promise<OHLCV[]>): Promise<void> {
  const tm = tradeModel(VARIANT) as any
  const pendingSymbols = await tm.findMany({
    where: { limitOrderState: 'PENDING_LIMIT' },
    select: { symbol: true },
    distinct: ['symbol'],
  })
  for (const { symbol } of pendingSymbols) {
    try {
      const candles = await loadCandles(symbol)
      await checkPendingLimitsAgainstCandles(symbol, candles)
    } catch (e: any) {
      console.warn(`${logTag(VARIANT)} safety-net failed for ${symbol}: ${e.message}`)
    }
  }
}

// Suppress unused import warning — runTrackForSymbol используется через variant
// routing в основном paper trader cycle, не напрямую здесь.
void runTrackForSymbol
void getRealisticRates
void syncSignalStatus

let cycleTimer: NodeJS.Timeout | null = null

export function startBreakoutLimitTraderC(): void {
  if (cycleTimer) return
  const tag = logTag(VARIANT)
  console.log(`${tag} starting (limit-on-rangeEdge mode, ~60s cycle)`)
  // Stagger start: A на ~90s, B на ~95s, C на 100s — разносим API calls.
  setTimeout(() => {
    cycleTimer = setInterval(async () => {
      try {
        await runBreakoutLimitCycleC()
      } catch (e: any) {
        console.warn(`${tag} cycle error: ${e.message}`)
      }
    }, 60_000)
    // Запустить первый цикл сразу
    runBreakoutLimitCycleC().catch((e) => console.warn(`${tag} first cycle: ${e.message}`))
  }, 100_000)
}

export function stopBreakoutLimitTraderC(): void {
  if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null }
}
