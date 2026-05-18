# Daily Breakout — результаты live forward-test (snapshot 2026-05-16)

Снимок состояния paper-trading на VPS prod БД. Все три варианта работают параллельно на одном потоке сигналов (C — на pre-emptive limits своим universe-обходом).

Сырые данные: [trades_A.csv](trades_A.csv), [trades_B.csv](trades_B.csv), [trades_C.csv](trades_C.csv).

---

## Сводка по вариантам

| Метрика | A (10·10%) | B (20·5%) | C (limit edge) |
|---|---:|---:|---:|
| **Депо стартовый** | $500.00 | $320.00 | $320.00 |
| **Депо текущий** | **$681.87** | **$369.41** | **$592.72** |
| **Δ от старта** | **+$181.87** | **+$49.41** | **+$272.72** |
| **Доходность** | **+36.4%** | **+15.4%** | **+85.2%** |
| **Пик депо** | $682.08 | $369.41 | $592.72 |
| **Max DD** | 24.9% | 37.4% | 25.4% |
| **Закрытых сделок** | 185 | 158 | 149 |
| ├ TP3 (full close) | 90 | 83 | 71 |
| ├ SL hit | 49 | 45 | 51 |
| └ EOD-FLAT (EXPIRED) | 46 | 30 | 27 |
| **Открытых сейчас** | 6 | 9 | 10 |
| **Win Rate (по netPnL)** | 61.6% | 61.4% | 60.0% |
| **R/tr (avg realizedR)** | +0.129 | +0.090 | **+0.257** |
| **Net P&L $** | +$181.52 | +$49.22 | +$272.60 |
| **Fees заплачено $** | $76.93 | $35.06 | $29.19 |
| **Slip заплачено $** | $26.49 | $17.40 | $8.14 |
| **PENDING (только C)** | — | — | 0 |
| **CANCELLED limits (C)** | — | — | 130 |
| **Включён** | ✓ | ✓ | ✓ |

### Что бросается в глаза

- **C впереди по доходности** (+85% vs +36% A vs +15% B) за ~6 дней forward-test — но это малая выборка, и предыдущий бэктест-аудит (2026-05-13) показал, что у C нет robust edge. См. [STRATEGY.md](../STRATEGY.md#variant-c--limit-on-edge-pre-emptive-limit-fills).
- **C платит в 2.6× меньше fees и в 3.3× меньше slip** при сопоставимом N трейдов — это и есть весь профит от maker-fills.
- **B хуже A** — несмотря на ×2 позиций и теоретически больший N, R/tr ниже (+0.09 vs +0.13), а max DD ×1.5 (37% vs 25%). Slippage реально съедает edge как и предсказывал backtest.
- **WR у всех трёх ~61%** — структурно стратегия одна и та же.
- **R/tr A (+0.13) ниже backtest-ожиданий (+0.32)** — за 6 дней выборка слишком мала, в один день можно потерять/добавить 0.1-0.2 R/tr.

---

## Equity curve (daily)

### A (10 conc · 10% margin)

| Дата | P&L дня | Депо |
|---|---:|---:|
| 2026-05-07 | +$9.73 | $509.73 |
| 2026-05-08 | +$104.91 | $614.64 |
| 2026-05-09 | -$35.68 | $578.96 |
| 2026-05-10 | -$22.32 | $556.64 |
| 2026-05-11 | +$2.45 | $559.09 |
| 2026-05-12 | +$77.33 | $636.42 |
| 2026-05-13 | -$118.31 | $518.11 |
| 2026-05-14 | -$39.05 | $479.06 |
| 2026-05-15 | +$113.95 | $593.01 |
| 2026-05-16 | +$58.15 | **$651.16** |

> Расхождение между $651.16 (по сумме закрытых) и $681.87 (текущий депо) = +$30.71 unrealized по 6 открытым сделкам.

### B (20 conc · 5% margin)

| Дата | P&L дня | Депо |
|---|---:|---:|
| 2026-05-09 | +$3.53 | $323.53 |
| 2026-05-10 | +$25.12 | $348.65 |
| 2026-05-11 | -$45.41 | $303.24 |
| 2026-05-12 | +$54.51 | $357.75 |
| 2026-05-13 | -$82.51 | $275.24 |
| 2026-05-14 | -$48.54 | $226.70 |
| 2026-05-15 | +$74.03 | $300.73 |
| 2026-05-16 | +$40.63 | **$341.36** |

### C (limit on edge)

| Дата | P&L дня | Депо |
|---|---:|---:|
| 2026-05-10 | -$17.40 | $302.60 |
| 2026-05-11 | -$25.91 | $276.69 |
| 2026-05-12 | +$105.06 | $381.75 |
| 2026-05-13 | -$84.61 | $297.14 |
| 2026-05-14 | -$3.94 | $293.20 |
| 2026-05-15 | +$124.75 | $417.95 |
| 2026-05-16 | +$116.71 | **$534.66** |

---

## Per-symbol breakdown

### A — top winners / losers

| Монета | N | W | L | Net $ | R/tr |
|---|---:|---:|---:|---:|---:|
| POLUSDT | 8 | 6 | 2 | +$39.51 | +0.508 |
| USELESSUSDT | 4 | 3 | 1 | +$32.17 | +0.734 |
| STXUSDT | 7 | 6 | 1 | +$31.55 | +0.450 |
| VVVUSDT | 8 | 6 | 2 | +$30.70 | +0.357 |
| ORDIUSDT | 9 | 6 | 3 | +$27.13 | +0.291 |
| AAVEUSDT | 6 | 4 | 2 | +$19.70 | +0.363 |
| SEIUSDT | 6 | 5 | 1 | +$18.77 | +0.303 |
| STRKUSDT | 2 | 2 | 0 | +$18.72 | +0.918 |
| AVAXUSDT | 1 | 1 | 0 | +$17.87 | +1.804 |
| 1000PEPEUSDT | 3 | 2 | 1 | +$17.27 | +0.575 |
| ... | | | | | |
| ENAUSDT | 7 | 4 | 3 | -$8.11 | +0.006 |
| SHIB1000USDT | 6 | 3 | 3 | -$8.20 | -0.047 |
| IOUSDT | 1 | 0 | 1 | -$10.10 | -1.000 |
| KASUSDT | 10 | 6 | 4 | -$11.11 | -0.007 |
| BLURUSDT | 1 | 0 | 1 | -$12.65 | -1.000 |
| IPUSDT | 6 | 3 | 3 | -$14.39 | -0.177 |
| HYPEUSDT | 3 | 1 | 2 | -$18.71 | -0.500 |
| **MUSDT** | **7** | **1** | **6** | **-$50.46** | **-0.629** |

Заметные: AVAX/STRK/PEPE/HYPE/BLUR/IO/TSTBSC/SOL/ETC — это сигналы из старого universe (до refresh 2026-05-09), которые уже не генерируются сканером, но открытые сделки трекаются до закрытия.

### B — top winners / losers

| Монета | N | W | L | Net $ | R/tr |
|---|---:|---:|---:|---:|---:|
| USELESSUSDT | 8 | 5 | 3 | +$24.16 | +0.505 |
| AEROUSDT | 8 | 6 | 2 | +$14.79 | +0.344 |
| DOGEUSDT | 9 | 8 | 1 | +$13.57 | +0.295 |
| LDOUSDT | 8 | 7 | 1 | +$13.56 | +0.328 |
| DYDXUSDT | 7 | 6 | 1 | +$12.68 | +0.370 |
| TRUMPUSDT | 7 | 6 | 1 | +$10.86 | +0.280 |
| VVVUSDT | 6 | 5 | 1 | +$10.05 | +0.254 |
| ORDIUSDT | 5 | 3 | 2 | +$6.34 | +0.289 |
| ... | | | | | |
| AAVEUSDT | 8 | 4 | 4 | -$5.85 | -0.027 |
| ARUSDT | 5 | 2 | 3 | -$7.15 | -0.144 |
| SHIB1000USDT | 6 | 2 | 4 | -$15.68 | -0.282 |
| IPUSDT | 6 | 2 | 4 | -$16.33 | -0.337 |
| **MUSDT** | **8** | **2** | **6** | **-$32.60** | **-0.605** |

### C — top winners / losers

| Монета | N | W | L | Net $ | R/tr |
|---|---:|---:|---:|---:|---:|
| DYDXUSDT | 7 | 6 | 1 | +$48.33 | +1.042 |
| ZECUSDT | 6 | 5 | 1 | +$35.48 | +0.910 |
| AEROUSDT | 7 | 5 | 1 | +$33.11 | +0.748 |
| VVVUSDT | 6 | 6 | 0 | +$27.39 | +0.771 |
| USELESSUSDT | 6 | 3 | 2 | +$23.88 | +0.599 |
| TRUMPUSDT | 7 | 5 | 2 | +$23.59 | +0.512 |
| LDOUSDT | 7 | 5 | 2 | +$19.91 | +0.396 |
| ORDIUSDT | 6 | 3 | 1 | +$13.91 | +0.410 |
| FARTCOINUSDT | 7 | 4 | 2 | +$12.27 | +0.242 |
| KASUSDT | 7 | 3 | 3 | +$10.29 | +0.248 |
| ... | | | | | |
| STXUSDT | 6 | 2 | 4 | -$8.99 | -0.208 |
| ETHUSDT | 6 | 3 | 3 | -$14.17 | -0.247 |
| IPUSDT | 7 | 2 | 4 | -$15.52 | -0.199 |
| **MUSDT** | **6** | **2** | **4** | **-$18.23** | **-0.447** |

> **MUSDT — главный loser у всех трёх вариантов.** Структурно эта монета даёт plохой Daily Breakout edge на текущем рынке. Кандидат на исключение из universe после следующего walk-forward backtest.

---

## CSV экспорт (полная история)

Все 3 файла лежат рядом с этим RESULTS.md.

| Файл | Строк (без header) | Включает |
|---|---:|---|
| [trades_A.csv](trades_A.csv) | 191 | Все сделки A: CLOSED / SL_HIT / EXPIRED / OPEN / TP1_HIT / TP2_HIT |
| [trades_B.csv](trades_B.csv) | 167 | Все сделки B (та же логика статусов) |
| [trades_C.csv](trades_C.csv) | 289 | + PENDING / CANCELLED limit pairs + limit-поля (`limitOrderState`, `limitOrderPrice`, `limitPlacedAt`, `limitFilledAt`, `pairOrderId`) |

### Колонки CSV

- **id, signalId, symbol, side, status** — идентификация и lifecycle
- **entryPrice, stopLoss, initialStop, currentStop, tpLadder** — геометрия trade. `currentStop` обновляется после TP1/TP2/TP3 (trailing), `initialStop` остаётся неизменным.
- **depositAtEntryUsd, riskUsd, positionSizeUsd, positionUnits, leverage, marginUsd** — sizing на момент входа
- **closes** — JSONB-массив частичных закрытий (TP1/TP2/TP3/SL/EXPIRED) с `{ price, percent, pnlR, pnlUsd, reason, closedAt }`
- **realizedR** — сумма pnlR из closes (R-units)
- **realizedPnlUsd** — gross P&L до fees
- **feesPaidUsd, slipPaidUsd** — суммарные комиссии и проскальзывание (Binance realistic model: maker 0.02% / taker 0.05% / slip 0.03%)
- **netPnlUsd** = realizedPnlUsd − feesPaidUsd − slipPaidUsd
- **feesRoundTripPct, feeTakerPct, feeMakerPct, slipTakerPct, autoTrailingSL** — fee/slip overrides per trade (если null — используется config default)
- **lastPriceCheck, lastPriceCheckAt** — состояние трекера (для отладки)
- **openedAt, closedAt, expiresAt** — UTC timestamps
- **(C only)** `limitOrderState`: `PENDING_LIMIT` → `FILLING` → `FILLED` / `CANCELLED_OTHER_SIDE` / `CANCELLED_EOD`. `limitOrderPrice` = rangeEdge. `pairOrderId` — id противоположной стороны пары.

---

## Известные нюансы данных

1. **Расхождения «депо текущий vs Σ netPnL по закрытым»** — это unrealized P&L по открытым сделкам (закладывается в Δ депо когда они закроются). У A на 16.05: $681.87 = $651.16 (сумма закрытых) + $30.71 unrealized.
2. **B (167 строк CSV) > B (158 закрытых + 9 открытых = 167)** — сходится.
3. **C (289 строк CSV) = 149 закрытых + 10 открытых + 130 cancelled limits** — `CANCELLED_OTHER_SIDE` это не «потерянная сделка», это нормальная вторая сторона пары, отменённая после fill первой. Также включает `CANCELLED_EOD` (PENDING > 24h, EOD cleanup).
4. **Сигналы для A пишутся в `BreakoutSignal`** (legacy mirror). B/C только читают. У C `signalId=0` потому что C ставит лимиты pre-emptive, без привязки к scanner-сигналу.
5. **В CSV для A есть монеты, которых нет в текущем universe** (AVAX, STRK, PEPE, HYPE, BLUR, IO, TSTBSC, SOL, ETC, ARB, ETH-XRP-SAND-FARTCOIN — точнее, не все, но ряд таких). Это легаси-сделки до refresh universe 2026-05-09 — они уже отторгованы и не будут пересоздаваться.
