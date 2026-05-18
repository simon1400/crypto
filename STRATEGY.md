# Daily Breakout — стратегия и варианты A / B / C

Документ описывает, как работают три параллельные копии торговой стратегии Daily Breakout в проекте Crypto Dashboard. Источник истины:

- [backend/src/scalper/dailyBreakoutEngine.ts](backend/src/scalper/dailyBreakoutEngine.ts) — pure-logic движок
- [backend/src/services/dailyBreakoutLiveScanner.ts](backend/src/services/dailyBreakoutLiveScanner.ts) — сканер сигналов (общий для A/B)
- [backend/src/services/dailyBreakoutPaperTrader.ts](backend/src/services/dailyBreakoutPaperTrader.ts) — paper-trader для A/B/C (single source, variant-aware)
- [backend/src/services/dailyBreakoutLimitTrader.ts](backend/src/services/dailyBreakoutLimitTrader.ts) — pre-emptive limit placement для C
- [backend/src/services/breakoutVariant.ts](backend/src/services/breakoutVariant.ts) — variant routing
- [backend/src/services/breakoutWsTracker.ts](backend/src/services/breakoutWsTracker.ts) — WebSocket SL/TP tracker

---

## Общая основа (одна для всех трёх вариантов)

**Гипотеза:** пробой границ 3-часового UTC-диапазона начала суток с подтверждением объёмом.

### Range и сигнал

1. **Range:** первые 36 5m-свечей UTC-дня (00:00–03:00 UTC) → `rangeHigh = max(highs)`, `rangeLow = min(lows)`, `rangeSize = high − low`.
2. **Breakout (детектится сканером для A/B):** на каждой 5m-свече после 03:00 UTC:
   - **LONG:** `candle.high > rangeHigh AND candle.close > rangeHigh`
   - **SHORT:** `candle.low < rangeLow AND candle.close < rangeLow`
3. **Volume confirmation:** `c.volume >= avg(prev 24 5m bars) × 2.0`.
4. **SL distance guard:** `slDistPct = |entry − sl| / entry × 100 >= 0.4%`. Узкие SL отбрасываются — иначе liquidation при ×100 leverage срабатывает раньше SL, и fees съедают депо.
5. **Overshoot guard:** если на момент детекта `entry` уже >= TP1 — сигнал не создаётся (нет реалистичного edge).
6. **Один сигнал на монету на UTC-день** (`alreadySignaledToday` — поиск в `BreakoutSignal` по `symbol + rangeDate`).
7. **Expiry:** 23:55 UTC текущего дня.

### Геометрия trade

- **Entry:** rangeEdge (для C) или close триггерной свечи (для A/B).
- **SL:** противоположный край range (rangeLow для BUY, rangeHigh для SELL).
- **TP ladder (anchor = rangeEdge):** TP1/TP2/TP3 = `rangeEdge ± 1× / 2× / 3× rangeSize`. Якорь на rangeEdge (а не на entry) — чтобы геометрия совпадала с backtest, где entry = rangeEdge.
- **Splits:** 50% / 30% / 20% на TP1/TP2/TP3.
- **Full trailing:** после TP1 → SL = BE, после TP2 → SL = TP1, после TP3 → SL = TP2.

### EOD policy (EOD-FLAT)

В 23:55 UTC любая ещё открытая позиция закрывается по рынку (`status='EXPIRED'`, taker fee + slip). Откат экспериментальной EOD-NO-TP1 политики (2026-05-15).

### Universe (23 монеты)

Refresh 2026-05-09 после walk-forward backtest (TEST R/tr >= +0.20 на свежих данных):

```
ETH, AAVE, ENA, SEI, M, LDO, DYDX, ZEC, STX, IP, ORDI, AR, DOGE,
TRUMP, KAS, SHIB1000, FARTCOIN, AERO, POL, VVV, USELESS, SIREN, 1000BONK
```

См. [dailyBreakoutLiveScanner.ts:41-67](backend/src/services/dailyBreakoutLiveScanner.ts#L41-L67).

### Fee model (Binance realistic)

- **TP fills — maker:** `feeMakerPct = 0.02%` per side, slip = 0 (limit стоит в стакане).
- **SL / EXPIRED / MANUAL / MARGIN — taker:** `feeTakerPct = 0.05%` per side + `slipTakerPct = 0.03%`.

### Tick architecture

- **WebSocket tracker** (Bybit `publicTrade`) — мгновенный SL/TP detection, 200ms per-symbol throttle.
- **60s slow tick** — safety-net (загружает 5m klines и реплеит).
- **Race-защита (2026-05-13):** `tm.updateMany({ where: { id, status, realizedR } })` с проверкой count=1 — второй tick видит сдвинутый realizedR и skip-ает.
- **Депо производное:** `currentDepositUsd = startingDepositUsd + totalPnLUsd` (пересчёт из таблицы, не инкремент). Защищает от drift при race.

---

## Variant A — «10 conc · 10% margin» (legacy prod)

**Таблицы:** `BreakoutPaperConfig` / `BreakoutPaperTrade`
**API:** `/api/breakout-paper/*`
**Telegram-префикс:** (нет)

### Конфиг (defaults)

| Параметр | Значение |
|---|---|
| `startingDepositUsd` | 500 |
| `riskPctPerTrade` | 2.0 |
| `targetMarginPct` | 10 |
| `maxConcurrentPositions` | 10 |
| `feeTakerPct` / `feeMakerPct` / `slipTakerPct` | 0.05 / 0.02 / 0.03 |
| `autoTrailingSL` | false |
| `marginGuardEnabled` / `marginGuardAutoClose` | true / false (skip-only) |

### Логика входа

1. Сканер пробил range на 5m-свече → создал запись в `BreakoutSignal` → синхронно вызвал `runBreakoutPaperCycle('A')`.
2. **Entry = market по `c.close` триггерной свечи** (taker fee + slip пушит цену в худшую сторону).
3. **Sizing:**
   - `positionUnits = riskUsd / |entry − sl|`, где `riskUsd = deposit × 2%`
   - `leverage` подгоняется так, чтобы `marginUsd ≈ deposit × 10%`, но не выше `getMaxLeverage(symbol)` (Bybit cap).
   - Если упёрлось в потолок плеча — fallback на downsize маржи.
4. **Margin guard:** если суммарная свободная маржа недостаточна — `SKIPPED` с причиной (auto-close выключен, чужие сделки не трогаем).

### Особенности A

- **Только A пишет обратно в `BreakoutSignal`** (`status`, `closes`, `realizedR`, `paperStatus`, `paperReason`) — это legacy mirror для UI таба «Сигналы» и Telegram tracker.
- B и C только читают `BreakoutSignal`, никогда не пишут.
- При delete trade у A удаляется и связанный `BreakoutSignal` (чтобы сканер не переоткрыл).

### Backtest (TEST 40%, 146d, fees+slip realistic, 23 монеты)

| Метрика | A |
|---|---|
| Trades | 929 |
| R/tr | +0.32 |
| WR | 51% |
| finalDepo ($500) | $4 459 |
| maxDD | ~30% |

---

## Variant B — «20 conc · 5% margin» (агрессивная копия A)

**Таблицы:** `BreakoutPaperConfigB` / `BreakoutPaperTradeB`
**API:** `/api/breakout-paper-b/*`
**Telegram-префикс:** `[B] `
**Live с:** 2026-05-09

### Конфиг (defaults)

| Параметр | Значение | Δ от A |
|---|---|---|
| `startingDepositUsd` | 320 | (меньше — отдельный депо) |
| `riskPctPerTrade` | 2.0 | = |
| `targetMarginPct` | 5 | **/2** |
| `maxConcurrentPositions` | 20 | **×2** |
| `feeTakerPct` / `feeMakerPct` / `slipTakerPct` | 0.05 / 0.02 / 0.03 | = |
| `autoTrailingSL` | false | = |

**Главная идея B:** тот же 2% risk на сделку, но в 2× больше одновременных позиций при 2× меньше маржи на каждую (плечо повышается). Notional growth ×2.

### Архитектура — изоляция

- **Variant routing:** [breakoutVariant.ts](backend/src/services/breakoutVariant.ts) → `configModel('B')`, `tradeModel('B')`, `tgPrefix('B') = '[B] '`, `logTag('B') = '[BreakoutPaperB]'`.
- **Один сканер — два cycle:** scanner после save вызывает `runBreakoutPaperCycle('A')` И `runBreakoutPaperCycle('B')` синхронно, каждый в своём try/catch.
- **Routes factory:** [breakoutPaperRouterFactory.ts](backend/src/routes/breakoutPaperRouterFactory.ts) — один код, мount разные variant-ы.
- **Boot stagger:** A=60s, B=65s, C=70s (чтобы не дёргать Bybit одновременно).
- **paperStatusB / paperReasonB / paperUpdatedAtB** в `BreakoutSignal` (фикс 2026-05-13) — причины SKIP для B видны в UI отдельно от A.

### Backtest (TEST 40%, 146d, 23 монеты)

| Метрика | A | B |
|---|---|---|
| Trades | 929 | 1 634 |
| R/tr | +0.32 | **+0.49** |
| WR | 51% | 52% |
| finalDepo ($500) | $4 459 | **$14 278** (×3.2) |
| maxDD | ~30% | **~50%** |

### Slippage stress-test

| Slippage | A finalDepo | B finalDepo | B/A |
|---|---|---|---|
| 0.05% | $7 350 | $26 236 | 3.6× |
| 0.10% | $4 030 | $9 676 | 2.4× |
| 0.15% | $2 289 | $4 710 | 2.1× |
| 0.20% | $1 542 | $2 598 | 1.7× |

B чувствительнее к slippage — больше сделок, каждая платит slip. Edge выживает на всех уровнях, но превосходство сжимается.

### Live forward-test

- Старт 2026-05-09 на $320.
- Минимум депо в первый месяц $394 (= −21% от старта на каком-то локальном дне).
- Решение о переходе с A на B принимается после 1-2 месяцев live с подтверждённым edge.

---

## Variant C — «limit on edge» (pre-emptive limit fills)

**Таблицы:** `BreakoutPaperConfigC` / `BreakoutPaperTradeC`
**API:** `/api/breakout-paper-c/*`
**Telegram-префикс:** `[C] `
**Файл логики:** [dailyBreakoutLimitTrader.ts](backend/src/services/dailyBreakoutLimitTrader.ts)
**Live с:** 2026-05-10

### Конфиг (defaults)

| Параметр | Значение |
|---|---|
| `startingDepositUsd` | 320 |
| `riskPctPerTrade` | 2.0 |
| `targetMarginPct` | 5 |
| `maxConcurrentPositions` | 20 |
| `feesRoundTripPct` | 0.07 |
| `autoTrailingSL` | true |
| `enabled` (default) | false (включается отдельно) |

### Принципиальное отличие от A/B

**A/B:** scanner ждёт пробой → market entry на `c.close`. К моменту fill цена УЖЕ за rangeEdge → slip + range_overshoot.

**C:** как только 3h-range зафиксирован (после 03:00 UTC) — сразу выставляются 2 limit-ордера: BUY @ `rangeHigh` + SELL @ `rangeLow`. Limits сидят в стакане (post-only/maker). При пробое нужной стороны limit заполняется ТОЧНО по rangeEdge (maker fee, slip=0). Противоположный limit отменяется через `pairOrderId`.

### Жизненный цикл сделки в C

**1. Placement (`placeLimitsForRanges`)** — каждые 60s по 23 монетам:

- Грузит 5m-свечи и вычисляет today's range через `detectRange`.
- Проверки:
  - Range уже сформирован (т.е. сейчас после 03:00 UTC).
  - `slDist >= 0.4%`.
  - На эту монету сегодня нет записи в C-таблице (`isVariantBusyOnSymbol`).
  - Live-цена не зашла ни за одну из границ (иначе post-only reject).
- **Orphan cleanup (2026-05-13):** перед placement отменяет любые `PENDING_LIMIT` за прошлые дни для этого символа (защита от пропуска EOD-cleanup при restart).
- Создаёт пару `PENDING_LIMIT` строк:
  - BUY @ `rangeHigh`, SL=rangeLow, TP=`rangeHigh + N×rangeSize`
  - SELL @ `rangeLow`, SL=rangeHigh, TP=`rangeLow − N×rangeSize`
  - Связаны через `pairOrderId`. Если live-цена за одной из сторон — ставится только одна (без `pairOrderId`).
- **Sizing откладывается до fill** — между placement и fill могут пройти часы, депо может измениться.

**2. Fill (`fillLimit` через WS instant)** — на каждый WS trade event:

- В [breakoutWsTracker.ts](backend/src/services/breakoutWsTracker.ts) после `runTrackForSymbol` идёт `processWsTradeForLimits` — проверяет touched ли limit price.
- **Атомарный claim:** `tm.updateMany({ id, limitOrderState: PENDING_LIMIT } → FILLING)` с проверкой count=1 (защита от race WS + slow tick).
- Sizing на актуальный `currentDepositUsd`, maker fee, slip=0.
- **Cap-check на fill:** если уже 20 активных позиций — этот fill отменяется (`CANCELLED_OTHER_SIDE`, reason=`concurrent cap reached`). Placement сам по себе слот не занимает — только fill.
- **Margin guard:** если не хватает маржи — отмена либо downsize.
- Противоположная сторона пары → `CANCELLED_OTHER_SIDE` через cascade (`updateMany` с проверкой что ещё PENDING_LIMIT).
- `status='OPEN'` → далее идентичен A/B (тот же `runTrackForSymbol`, тот же EOD-FLAT).

**3. EOD cleanup (`cancelStaleLimitsEod`)** — в 23:55 UTC все ещё `PENDING_LIMIT` старше 24h → `CANCELLED_EOD` / `EXPIRED`.

### Изоляция от A/B

- Своя таблица `BreakoutPaperTradeC`, свой config, свой router `/api/breakout-paper-c`.
- Свой timer (60s + boot stagger 100s).
- `signalId=0` на C-сделках — C не привязан к `BreakoutSignal` (использует свою pre-emptive placement из universe).
- Не пишет в `BreakoutSignal`.
- WS tracker итерирует `['A','B','C']`; для C `slot refill` пропускается (только market entry рефиллится).
- Если упадёт C-обработчик в WS — A/B продолжат работать (try/catch wrap).

### Реальный edge — backtest vs live (2026-05-13 аудит)

**Backtest idealized ×9-22 НЕ воспроизводится live:**

- Старт 2026-05-10 на $320.
- На 2026-05-13: $340.95 (+$21, +6.5%) за 3 дня. 77 trades, WR 59%, R/tr ~+0.07.
- Лучший observed R/tr (out-of-sample) = +0.07.

**8 гипотез протестированы — все провалились:**

1. Volume filter на момент fill (3 варианта, no-lookahead) — все отрицательные.
2. Quick scalp exits (8 sweep: 2 modes × 4 tpR) — все теряют 90-100% за 365d.
3. Geometry + universe sweep (16 scenarios) — лучший не robust.
4. FADE direction (mean reversion, 24 scenarios) — robust=0.

**Корневая причина:** math. `2% risk × leverage ×20 → notional 200% deposit`. `fees+slip roundtrip ≈ 2% deposit/trade`. Чтобы быть в плюсе нужен avg R/tr > **+0.4R**. Best out-of-sample = **+0.07R** (в 6 раз меньше).

**Это не lekka стратегия — это фундаментальная проблема** для любых rangeEdge-based limit fills на популярных активах: rangeEdges на 5m часто шумные (новости, манипуляции, low-cap altcoin тонкая ликвидность).

**План:** разработать Variant D (trend-following), потом отключить C. До тех пор C тикает на виртуальных деньгах.

---

## Сводная таблица вариантов

| | **A** | **B** | **C** |
|---|---|---|---|
| Депо стартовый $ | 500 | 320 | 320 |
| Risk/trade | 2% | 2% | 2% |
| Target margin | 10% | 5% | 5% |
| Max concurrent | 10 | 20 | 20 |
| Entry | Market на c.close | Market на c.close | **Limit @ rangeEdge** |
| Entry fee + slip | Taker + slip | Taker + slip | **Maker, slip=0** |
| Когда ставит | После пробоя | После пробоя | **После 03:00 UTC, до пробоя** |
| Слушает `BreakoutSignal` | Да | Да | Нет (свой universe) |
| Пишет в `BreakoutSignal` | Да (legacy mirror) | Нет | Нет |
| TG-префикс | — | `[B] ` | `[C] ` |
| Live с | (legacy) | 2026-05-09 | 2026-05-10 |
| Backtest TEST R/tr | +0.32 | +0.49 | (idealized — не воспроизводится) |
| Live R/tr | (в проде) | (forward-test) | +0.07 (без edge) |
| Статус | prod | parallel forward-test | под отключение после Variant D |

---

## Что общего у всех трёх

- 23-монетный universe.
- WS-tracker через Bybit `publicTrade` (мгновенный SL/TP), 60s slow tick как safety-net.
- Splits 50/30/20 + full trailing TP1→BE / TP2→TP1 / TP3→TP2.
- TP fills — maker, SL/EXPIRED/MANUAL/MARGIN — taker + slip.
- EOD-FLAT в 23:55 UTC.
- Margin guard с downsize / skip.
- Race-защита `updateMany(status + realizedR)`.
- Депо производное от `totalPnLUsd`.
- Telegram: единый шаблон `BREAKOUT_OPENED` с массивом `variants`, EOD сводки вместо per-trade EXPIRED.

---

## Известные ограничения

1. **Edge thin для A/B** — ~0.32-0.49 R/tr на TEST. Нужен большой N для compound.
2. **Slippage критичен** — 0.15%+ убивает edge у обоих market-вариантов.
3. **C — без подтверждённого edge** на live, ×9-22 backtest был idealized.
4. **maxConcurrent=10 (A) при risk 2%** = до 20% депо в risk одновременно. DD до 33-40% в backtest. У B — до 50%.
5. **TP3 редко достигается** — большинство exits через TP1/TP2 (split structure это компенсирует).
6. **Daily/weekly loss limits не реализованы** — только поля в БД, ничего не блокирует. Пользователь принял риск без circuit breakers.
