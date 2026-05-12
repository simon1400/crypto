/**
 * Daily Breakout — variant C: PRE-EMPTIVE limit-on-rangeEdge entry mechanics.
 *
 * Параллельная копия paper trader'а с принципиально другой механикой входа:
 *   - A/B: scanner ждёт пробой 5m свечи → market entry (taker + slip) на c.close.
 *           К этому моменту цена УЖЕ за rangeEdge → entry хуже на slip + range_overshoot.
 *   - C:   как только 3h-range зафиксирован (после 03:00 UTC), для каждой монеты
 *           СРАЗУ выставляются 2 limit-ордера: BUY @ rangeHigh + SELL @ rangeLow.
 *           Limits сидят в стакане (post-only/maker). При пробое какой-то стороны
 *           limit заполняется ТОЧНО по rangeEdge (maker fee, без slip). Противоположный
 *           limit отменяется.
 *
 * Backtest 2026-05-10 (runBacktest_dailybreak_binance_AB.ts) показал ×9-22
 * улучшение доходности vs market entry (A: $1142→$10221, B: $571→$12461 за
 * 365d), DD падает с 88% до 62%. Это работает ТОЛЬКО при pre-emptive placement —
 * post-emptive (после пробоя) почти всегда даёт post-only reject (см. ранние логи
 * "price already past limit edge").
 *
 * Жизненный цикл сделки в C:
 *   1. После 03:00 UTC, для каждой из 23 монет:
 *      - вычисляем rangeHigh/rangeLow из 36 первых 5m свечей дня (как scanner)
 *      - проверяем slDist >= 0.4% (фильтр узких SL, как в engine)
 *      - проверяем что price ВНУТРИ range (иначе limit уже бы reject'ился) —
 *        если price > rangeHigh, BUY-limit невозможен; если price < rangeLow,
 *        SELL-limit невозможен. Тот limit, который возможен, ставим.
 *      - создаём 2 PENDING_LIMIT строки (или 1 если другая невозможна),
 *        связаны через pairOrderId
 *   2. WS instant fill: на каждый trade event проверяем touched ли limit.
 *      При срабатывании одного → fill (sizing с актуальным deposit, maker fee,
 *      slip=0, status=OPEN), второй → CANCELLED_OTHER_SIDE через pairOrderId.
 *   3. EOD job в 23:55 UTC: все PENDING_LIMIT за вчерашний день → CANCELLED_EOD.
 *
 * Slot policy: каждая ПАРА (BUY+SELL) = 1 концурент-слот. После fill одной из
 * сторон slot всё ещё занят (теперь FILLED трейдом). После cancel второй стороны
 * slot не освобождается (FILLED занимает). Это эквивалент: «одна позиция per range».
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
import { detectRange, endOfDayUTC, BreakoutEngineConfig } from '../scalper/dailyBreakoutEngine'
import { loadHistorical } from '../scalper/historicalLoader'
import { DEFAULT_BREAKOUT_SETUPS } from './dailyBreakoutLiveScanner'
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
 * Pre-emptive placement: для каждой из 23 монет на каждом 5m цикле проверяем,
 * сформирован ли сегодняшний 3h-range, и если нет PENDING/OPEN записи — создаём
 * пару limit-ордеров (BUY @ rangeHigh, SELL @ rangeLow). Если price уже за
 * одной из сторон — ту сторону не ставим (post-only бы reject'илось).
 *
 * Не делаем sizing здесь — он отложен до fill, потому что между placement и
 * fill могут пройти часы и deposit может измениться (другая C-сделка закрылась
 * с +/-).
 */
async function placeLimitsForRanges(cfg: PaperConfigC): Promise<{ placed: number }> {
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any

  const dbCfg = await prisma.breakoutConfig.findUnique({ where: { id: 1 } })
  if (!dbCfg) return { placed: 0 }
  const enabledSymbols = (dbCfg.symbolsEnabled as string[]).length > 0
    ? dbCfg.symbolsEnabled as string[]
    : DEFAULT_BREAKOUT_SETUPS

  const engineCfg: BreakoutEngineConfig = {
    rangeBars: dbCfg.rangeBars,
    volumeMultiplier: dbCfg.volumeMultiplier,
    tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
  }

  const utcDate = new Date().toISOString().slice(0, 10)
  let placed = 0

  for (const symbol of enabledSymbols) {
    try {
      // Skip если уже есть запись на эту монету за сегодня в любом статусе.
      if (await isVariantBusyOnSymbol(symbol, utcDate, VARIANT)) continue

      // Concurrent cap: каждая «пара» = 2 строки (BUY+SELL), но логически 1 слот.
      // Эффективный cap по строкам = maxConcurrentPositions * 2.
      const activeOrPending = await tm.count({
        where: {
          OR: [
            { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
            { limitOrderState: 'PENDING_LIMIT' },
          ],
        },
      })
      if (activeOrPending >= cfg.maxConcurrentPositions * 2) continue

      const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
      const range = detectRange(candles, utcDate, engineCfg)
      if (!range) continue  // range ещё не сформирован (до 03:00 UTC)

      // SL distance guard (как в engine)
      const slDistPct = (range.rangeSize / Math.min(range.rangeHigh, range.rangeLow)) * 100
      if (slDistPct < 0.4) {
        console.log(`${tag} skip ${symbol} — slDist ${slDistPct.toFixed(2)}% < 0.4%`)
        continue
      }

      // Live price — определяем какие limit'ы возможны (post-only reject иначе)
      let livePrice: number | null = null
      try {
        const prices = await fetchPricesBatch([symbol])
        const live = prices[symbol]
        if (live && live > 0) livePrice = live
      } catch { /* без живой цены ставим обе стороны */ }

      // Геометрия (как engine.generateBreakoutSignal):
      //   BUY entry = rangeHigh, SL = rangeLow, TP = rangeHigh + N×rangeSize
      //   SELL entry = rangeLow,  SL = rangeHigh, TP = rangeLow - N×rangeSize
      const buyTpLadder = [
        range.rangeHigh + range.rangeSize * engineCfg.tp1Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp2Mult,
        range.rangeHigh + range.rangeSize * engineCfg.tp3Mult,
      ]
      const sellTpLadder = [
        range.rangeLow - range.rangeSize * engineCfg.tp1Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp2Mult,
        range.rangeLow - range.rangeSize * engineCfg.tp3Mult,
      ]

      // Каждая сторона возможна только если price не за этой стороной
      const canPlaceBuy = livePrice == null || livePrice <= range.rangeHigh
      const canPlaceSell = livePrice == null || livePrice >= range.rangeLow
      if (!canPlaceBuy && !canPlaceSell) continue

      const placedAt = new Date()
      const placedRows: any[] = []

      if (canPlaceBuy) {
        const buyRow = await tm.create({
          data: {
            signalId: 0,                          // pre-emptive — нет signalId, scanner создаст сигнал когда пробой
            symbol, side: 'BUY',
            entryPrice: range.rangeHigh,
            stopLoss: range.rangeLow, initialStop: range.rangeLow, currentStop: range.rangeLow,
            tpLadder: buyTpLadder as any,
            openedAt: placedAt,
            depositAtEntryUsd: 0, riskUsd: 0, positionSizeUsd: 0, positionUnits: 0,
            leverage: null, marginUsd: null,
            feesRoundTripPct: cfg.feesRoundTripPct,
            feeTakerPct: cfg.feeTakerPct, feeMakerPct: cfg.feeMakerPct, slipTakerPct: cfg.slipTakerPct,
            feesPaidUsd: 0, slipPaidUsd: 0,
            autoTrailingSL: cfg.autoTrailingSL,
            status: 'PENDING',
            limitOrderState: 'PENDING_LIMIT',
            limitOrderPrice: range.rangeHigh,
            limitPlacedAt: placedAt,
          },
        })
        placedRows.push(buyRow)
      }

      if (canPlaceSell) {
        const sellRow = await tm.create({
          data: {
            signalId: 0,
            symbol, side: 'SELL',
            entryPrice: range.rangeLow,
            stopLoss: range.rangeHigh, initialStop: range.rangeHigh, currentStop: range.rangeHigh,
            tpLadder: sellTpLadder as any,
            openedAt: placedAt,
            depositAtEntryUsd: 0, riskUsd: 0, positionSizeUsd: 0, positionUnits: 0,
            leverage: null, marginUsd: null,
            feesRoundTripPct: cfg.feesRoundTripPct,
            feeTakerPct: cfg.feeTakerPct, feeMakerPct: cfg.feeMakerPct, slipTakerPct: cfg.slipTakerPct,
            feesPaidUsd: 0, slipPaidUsd: 0,
            autoTrailingSL: cfg.autoTrailingSL,
            status: 'PENDING',
            limitOrderState: 'PENDING_LIMIT',
            limitOrderPrice: range.rangeLow,
            limitPlacedAt: placedAt,
          },
        })
        placedRows.push(sellRow)
      }

      // Связываем пару через pairOrderId — для cancel cascade при fill одной стороны.
      if (placedRows.length === 2) {
        await tm.update({ where: { id: placedRows[0].id }, data: { pairOrderId: placedRows[1].id } })
        await tm.update({ where: { id: placedRows[1].id }, data: { pairOrderId: placedRows[0].id } })
      }

      placed += placedRows.length
      const sides = placedRows.map(r => `${r.side}@${r.limitOrderPrice}`).join(', ')
      console.log(`${tag} ${symbol} placed ${placedRows.length} limit(s) [range ${range.rangeHigh}/${range.rangeLow}, slDist ${slDistPct.toFixed(2)}%]: ${sides}`)
    } catch (e: any) {
      console.warn(`${tag} ${symbol} placement failed: ${e.message}`)
    }
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
      expiresAt: new Date(endOfDayUTC(fillTime.toISOString().slice(0, 10))),
      limitOrderState: 'FILLED',
      limitFilledAt: fillTime,
    },
  })

  // Обновляем deposit (списываем maker fee).
  await cm.update({
    where: { id: 1 },
    data: { currentDepositUsd: { decrement: entryFeeUsd } },
  })

  // Cancel pair: один limit зафиллен → противоположный отменяем (если был).
  // Ставим updateMany с проверкой что пара ещё в PENDING_LIMIT (не успела зафиллиться сама).
  if (trade.pairOrderId) {
    const cancelled = await tm.updateMany({
      where: { id: trade.pairOrderId, limitOrderState: 'PENDING_LIMIT' },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    if (cancelled.count > 0) {
      console.log(`${tag} cancelled pair limit #${trade.pairOrderId} (${trade.symbol}) — other side filled`)
    }
  }

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
 *   1. placeLimitsForRanges — pre-emptive: для каждой монеты с готовым 3h-range
 *      и без активной сделки сегодня — создаёт пару PENDING_LIMIT
 *   2. WS instant fill отлавливает срабатывание (через processWsTradeForLimits)
 *   3. trackOnePaper для FILLED сделок — через общий paperTrader cycle (variant C)
 *   4. EOD cancel stale limits — через sendBreakoutEodSummary в 23:55 UTC
 */
export async function runBreakoutLimitCycleC(): Promise<{ placed: number }> {
  const cfg = await getOrCreateConfigC()
  if (!cfg || !cfg.enabled) return { placed: 0 }
  const r = await placeLimitsForRanges(cfg)
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
