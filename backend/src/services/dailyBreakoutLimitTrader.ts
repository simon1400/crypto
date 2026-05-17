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
  applyDepositDelta, isCircuitBreakerTripped,
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
  // Daily circuit breaker — block new placements when today's UTC closed trades
  // breach either threshold. Open positions still trail. See dailyBreakoutPaperTrader.
  dailyLossLimitPct: number
  dailyLossLimitR: number
  weeklyLossLimitPct: number
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

  // Daily circuit breaker — block new C placements (limit pairs) when today's UTC
  // closed trades breach either threshold. Existing PENDING limits still get filled
  // by WS tracker if price reaches them; we only stop creating NEW pairs.
  const cb = await isCircuitBreakerTripped(cfg as any, VARIANT)
  if (cb.tripped) {
    console.warn(`${tag} ${cb.reason} — блокирую новые лимиты до следующего UTC дня`)
    return { placed: 0 }
  }

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

  const todayStartUtc = new Date(`${utcDate}T00:00:00.000Z`)

  for (const symbol of enabledSymbols) {
    try {
      // Skip если уже есть запись на эту монету за сегодня в любом статусе.
      if (await isVariantBusyOnSymbol(symbol, utcDate, VARIANT)) continue

      // Защита от orphan PENDING_LIMIT с прошлых дней: если EOD-cleanup не
      // отработал (process restart в окне 23:55-00:00 UTC, или одиночная
      // limit-сторона с pairOrderId=null, которая никогда не попадает в cascade),
      // отменяем такие лимитки перед размещением новой пары. Без этого в Pending
      // могла висеть вчерашняя лимитка одновременно с сегодняшней открытой сделкой.
      const orphanCancelled = await tm.updateMany({
        where: {
          symbol,
          limitOrderState: 'PENDING_LIMIT',
          limitPlacedAt: { lt: todayStartUtc },
        },
        data: {
          limitOrderState: 'CANCELLED_EOD',
          status: 'EXPIRED',
          closedAt: new Date(),
        },
      })
      if (orphanCancelled.count > 0) {
        console.log(`${tag} ${symbol} cancelled ${orphanCancelled.count} orphan PENDING_LIMIT from prior days`)
      }

      // Placement без cap-проверки — лимиток можно ставить сколько угодно
      // (каждая монета даёт пару BUY+SELL). Cap контролируется при fill в
      // fillLimitInner: первые N filled занимают слоты, остальные при попытке
      // fill будут отменены как 'concurrent cap reached'.

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

  // Concurrent cap check at fill time. Placement-time cap (placeLimitsForRanges)
  // counts PENDING_LIMIT + active as 2x slots, but each PENDING fills indepen-
  // dently — without this guard several near-simultaneous fills can push past
  // maxConcurrentPositions. Hard-cancel any limit that would exceed the cap.
  const activeCount = await tm.count({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (activeCount >= cfg.maxConcurrentPositions) {
    await tm.update({
      where: { id: tradeId },
      data: {
        limitOrderState: 'CANCELLED_OTHER_SIDE',
        status: 'CANCELLED',
        closedAt: fillTime,
      },
    })
    console.warn(`${tag} cancelled limit #${tradeId} ${trade.symbol} — concurrent cap reached (${activeCount}/${cfg.maxConcurrentPositions})`)
    return { filled: false, reason: 'concurrent cap reached' }
  }

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

  // Списываем maker entry fee через applyDepositDelta — он одновременно
  // декрементит currentDepositUsd и пересчитывает totalPnLUsd по таблице
  // (где feesPaidUsd уже включает наш entry fee). Прямой decrement без этого
  // вызова рассинхронизирует две метрики на сумму entry fees ещё-открытых сделок.
  const cfgForDelta = await cm.findUnique({ where: { id: 1 } })
  if (cfgForDelta) await applyDepositDelta(cfgForDelta as any, -entryFeeUsd, VARIANT)

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
 * REALISTIC FILL MODEL для variant C (внедрено 2026-05-17, заменяет touch-fill).
 *
 * Старая модель (touch fill) была optimistic: fill регистрировался как только
 * trade-price касался limitPrice. На реальной бирже:
 *   - в queue могут стоять чужие limits (HFT, market-makers) на том же уровне;
 *   - "wick-and-back" движения (тень свечи коснулась уровня и тут же откатилась)
 *     не дают fill — в orderbook просто нет ликвидности встретить наш limit;
 *   - "post-only reject" — если цена прошла уровень до публикации лимита.
 *
 * Realistic-модель требует обоих условий для fill:
 *
 *   1. CROSS + MIN PENETRATION: цена должна пройти СКВОЗЬ limitPrice минимум на
 *      MIN_PENETRATION_PCT% (default 0.05% = 5 bps). Для BUY @ rangeHigh это
 *      означает candle.low <= limitPrice * (1 - 0.0005). Чисто проход через
 *      уровень = реальный пробой с моментум, а не тень против тренда.
 *
 *   2. VOLUME GATE: объём свечи, на которой произошло пересечение, должен быть
 *      >= avg(prev 24 candles) * MIN_VOL_MULT (default 1.5×). Низкообъёмные
 *      проколы обычно не дают fill в реальном orderbook (тонкая ликвидность,
 *      partial fills, реджекты).
 *
 * Если ОБА условия пройдены на закрытой 5m-свече — limit филлится по limitPrice
 * (это и есть rangeEdge, как в backtest). Maker fee, slip = 0 (так как мы
 * стояли в стакане до пробоя — это правда для cross-fill сценария).
 *
 * Если хотя бы одно условие не выполнено — limit ОСТАЁТСЯ PENDING, продолжает
 * ждать. Если за день условия так и не выполнятся — EOD cancel в 23:55 UTC.
 */
const MIN_PENETRATION_PCT = 0.05    // 5 bps = 0.05%
const MIN_VOL_MULT = 1.5              // current candle vol >= 1.5× avg

/**
 * Проверяем закрытую свечу: даёт ли она realistic fill для данного limit?
 *
 * Возвращает true если ОБА условия выполнены:
 *   - CROSS: для BUY low <= limit * (1 - MIN_PENETRATION); для SELL high >= limit * (1 + MIN_PENETRATION)
 *   - VOLUME: candle.volume >= avgVolume * MIN_VOL_MULT
 */
function checkRealisticFill(
  side: 'BUY' | 'SELL',
  limitPrice: number,
  candle: OHLCV,
  avgVolume: number,
): { fillable: boolean; reason?: string } {
  const penFrac = MIN_PENETRATION_PCT / 100
  const crossThreshold = side === 'BUY'
    ? limitPrice * (1 - penFrac)
    : limitPrice * (1 + penFrac)
  const crossed = side === 'BUY'
    ? candle.low <= crossThreshold
    : candle.high >= crossThreshold
  if (!crossed) {
    return { fillable: false, reason: 'no min penetration (wick-only or no cross)' }
  }
  if (avgVolume > 0 && candle.volume < avgVolume * MIN_VOL_MULT) {
    return { fillable: false, reason: `volume ${candle.volume.toFixed(0)} < ${MIN_VOL_MULT}× avg ${avgVolume.toFixed(0)}` }
  }
  return { fillable: true }
}

/**
 * Closed-candle replay: для каждого PENDING_LIMIT проверяем все закрытые свечи
 * с момента placement до сейчас на realistic fill conditions. Первая прошедшая
 * cross+volume свеча → fill.
 *
 * Это единственная точка fill для variant C (заменяет старую touch-fill в WS).
 * Закрытая свеча — потому что нужны volume и close price, оба известны только
 * после close (no-lookahead).
 */
async function checkPendingLimitsAgainstCandles(symbol: string, candles: OHLCV[]): Promise<void> {
  if (candles.length === 0) return
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any
  const pending = await tm.findMany({
    where: { symbol, limitOrderState: 'PENDING_LIMIT' },
  })
  if (pending.length === 0) return

  for (const p of pending) {
    const limitPrice = p.limitOrderPrice as number
    const side = p.side as 'BUY' | 'SELL'
    const sinceMs = new Date(p.limitPlacedAt).getTime()
    // Свечи после placement, отсортированы по времени (loader даёт по возрастанию).
    const afterPlacement = candles.filter(c => c.time > sinceMs).sort((a, b) => a.time - b.time)
    if (afterPlacement.length === 0) continue

    let filledAt: number | null = null
    let lastFailReason = ''
    // Идём в хронологическом порядке — первая cross+volume свеча даёт fill.
    for (let i = 0; i < afterPlacement.length; i++) {
      const c = afterPlacement[i]
      // avg volume по 24 предыдущим свечам в общем массиве (включая до placement).
      const cIdxInAll = candles.findIndex(x => x.time === c.time)
      const avgStart = Math.max(0, cIdxInAll - 24)
      const avgWindow = candles.slice(avgStart, cIdxInAll)
      const avgVolume = avgWindow.length > 0
        ? avgWindow.reduce((s, x) => s + x.volume, 0) / avgWindow.length
        : 0
      const check = checkRealisticFill(side, limitPrice, c, avgVolume)
      if (check.fillable) {
        filledAt = c.time
        break
      }
      lastFailReason = check.reason ?? ''
    }

    if (filledAt != null) {
      await fillLimit(p.id, new Date(filledAt))
    } else if (lastFailReason) {
      // Лог только при первом достаточно частом cross-touch (чтобы не спамить).
      // Самый частый сценарий: цена коснулась но wick-and-back → no fill.
      const someTouched = afterPlacement.some(c =>
        side === 'BUY' ? c.low <= limitPrice : c.high >= limitPrice,
      )
      if (someTouched) {
        console.log(`${tag} ${symbol} limit #${p.id} ${side} @ ${limitPrice} — touched but no realistic fill (${lastFailReason})`)
      }
    }
  }
}

/**
 * WS trade event: больше не филлим мгновенно (это была optimistic touch-fill).
 * Realistic fill требует закрытой свечи с cross+volume gate, что недоступно
 * в момент trade event. Поэтому WS callback теперь NO-OP для C —
 * fill происходит на slow tick через checkPendingLimitsAgainstCandles на
 * закрытых 5m свечах.
 *
 * Функция оставлена как hook (вызывается из breakoutWsTracker) и просто
 * возвращает управление — это сохраняет совместимость без удаления вызова.
 */
export async function processWsTradeForLimits(_symbol: string, _price: number, _ts: number): Promise<void> {
  // Intentionally empty: realistic fill model has moved to closed-candle replay.
  // See checkPendingLimitsAgainstCandles + safetyNetCheckLimitsC.
}

/**
 * EOD job — отменяем все PENDING_LIMIT, размещённые не сегодня UTC.
 * Не сработавший за день limit = пропущенный пробой, range уже не актуален.
 *
 * Cutoff = начало текущего UTC-дня. Был "now − 24h" — это пропускало одиночные
 * лимиты возраста 12-24 часа (например размещённые в 03:37 UTC, EOD в 23:55
 * того же дня = возраст 20ч), и они доживали до пробоя на следующий день уже
 * против устаревшего range.
 */
export async function cancelStaleLimitsEod(): Promise<{ cancelled: number }> {
  const tag = logTag(VARIANT)
  const tm = tradeModel(VARIANT) as any
  const todayUtc = new Date().toISOString().slice(0, 10)
  const cutoff = new Date(`${todayUtc}T00:00:00.000Z`)

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
 *   2. checkPendingLimits — реплей закрытых 5m-свечей с момента placement,
 *      fill ТОЛЬКО если cross+min-penetration+volume gate (realistic model).
 *      Заменяет старую WS touch-fill (она была optimistic).
 *   3. trackOnePaper для FILLED сделок — через общий paperTrader cycle (variant C)
 *   4. EOD cancel stale limits — через sendBreakoutEodSummary в 23:55 UTC
 */
export async function runBreakoutLimitCycleC(): Promise<{ placed: number }> {
  const cfg = await getOrCreateConfigC()
  if (!cfg || !cfg.enabled) return { placed: 0 }
  const r = await placeLimitsForRanges(cfg)
  // Realistic fill check на каждом тике — реплеим закрытые 5m свечи через
  // loadHistorical для всех символов с активными PENDING_LIMIT.
  await safetyNetCheckLimitsC(async (symbol) => loadHistorical(symbol, '5m', 1, 'bybit', 'linear'))
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
