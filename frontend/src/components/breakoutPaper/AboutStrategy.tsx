import type { BreakoutVariant } from '../../api/breakoutPaper'

interface Props {
  variant: BreakoutVariant
  isLive: boolean
  enabledCoins: number
}

/**
 * Раскрывающееся описание стратегии + результаты бэктеста (per-variant copy).
 * Variant-specific: A — legacy prod (10 conc, 10% margin, $500); B — alt (20
 * conc, 5% margin, $320); C — limit on rangeEdge; LIVE — real Binance Futures.
 * Strategy logic itself is identical — only sizing/entry path differs.
 */
export default function AboutStrategy({ variant, isLive, enabledCoins }: Props) {
  return (
    <div className="bg-card border border-input rounded-lg p-5 mb-4 text-sm text-text-secondary leading-relaxed space-y-4">
      {isLive && (
        <div className="bg-short/10 border border-short/30 rounded p-3 text-text-primary text-xs space-y-1">
          <div><span className="font-semibold text-short">LIVE — реальная торговля на Binance Futures USDT-M.</span></div>
          <div>
            Точная копия стратегии C (limit на rangeEdge, maker fee), но каждое действие исполняется реальным ордером
            через Binance API. Тот же поток сигналов, тот же universe монет, тот же 3h-диапазон. SL/TP виртуальные —
            трекаются через aggTrade WS и закрываются reduceOnly MARKET'ом при касании уровня.
          </div>
          <div className="text-text-secondary">
            Депозит и P&L берутся из реального availableBalance USDT кошелька Binance. Кнопка "Сбросить baseline"
            фиксирует текущий баланс как новую точку отсчёта для "Total P&L since baseline".
          </div>
        </div>
      )}
      {variant === 'B' && (
        <div className="bg-accent/10 border border-accent/30 rounded p-3 text-text-primary text-xs">
          <span className="font-semibold">Копия B — экспериментальный sizing.</span> Та же стратегия и тот же поток сигналов
          что у копии A, но отдельный депозит, увеличенная concurrency и уменьшенная маржа на сделку. Параллельный
          live forward-test чтобы проверить backtest-результаты на реальном рынке.
        </div>
      )}
      {variant === 'C' && (
        <div className="bg-accent/10 border border-accent/30 rounded p-3 text-text-primary text-xs space-y-1">
          <div><span className="font-semibold">Копия C — limit-on-rangeEdge experimental.</span> Тот же поток сигналов
          что у A/B, но вход через <span className="text-accent">limit-ордер</span> ровно на rangeEdge (rangeHigh для LONG,
          rangeLow для SHORT) вместо market entry на c.close триггерной свечи.</div>
          <div>
            <span className="font-semibold">Зачем:</span> backtest 365d показал ×9-22 улучшение доходности vs market entry
            (A: $1142→$10221, B: $571→$12461). Maker fee 0.02% вместо taker 0.05%, без slip, entry точно на структурном
            уровне → больше плечо при том же риске → больше R/tr (+0.16 → +0.53).
          </div>
          <div className="text-text-secondary">
            <span className="font-semibold">Риск:</span> в реальной бирже maker fill rate может быть ниже backtest-предположения
            (на быстрых пробоях limit может остаться пустым). PENDING_LIMIT занимает concurrent slot — иначе при сигналах на
            всех 23 монетах сразу не хватит депо на fill. EOD незаполненные limit отменяются.
          </div>
        </div>
      )}
      <section>
        <h3 className="text-text-primary font-semibold mb-1">Идея</h3>
        <p>
          Первые 3 часа после полуночи UTC (00:00–03:00) формируют базовый <span className="text-text-primary">диапазон дня</span>:
          high и low этого окна — границы, от которых рынок будет отталкиваться или которые пробьёт. Стратегия
          ловит <span className="text-text-primary">пробой границ</span> на повышенном объёме как сигнал смены настроения. Логика консервативная:
          один сигнал на монету в сутки, expiry в 23:55 UTC, всё лишнее отсекается.
        </p>
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">Как работает (по шагам)</h3>
        <ol className="list-decimal list-inside space-y-1 marker:text-accent">
          <li>В 03:00 UTC фиксируется диапазон: <span className="text-text-primary">range_high</span> = max и <span className="text-text-primary">range_low</span> = min из 36 первых 5-минутных свечей дня.</li>
          <li>Дальше каждые 5 минут проверяется: <span className="text-long">LONG</span> если свеча пробила и закрылась выше rangeHigh, <span className="text-short">SHORT</span> — если пробила и закрылась ниже rangeLow.</li>
          <li>Объём текущей свечи должен быть <span className="text-text-primary">≥ 2× от среднего</span> предыдущих 24 баров (volume confirmation).</li>
          <li>Дополнительный фильтр режима: если на BTC 1h <span className="text-text-primary">ADX(14) ≤ 20</span> — рынок в боковике, тик пропускается целиком.</li>
          <li>Один пробой на монету в сутки. Expiry — 23:55 UTC, потом сделка закрывается по рынку.</li>
        </ol>
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">Параметры сделки</h3>
        <ul className="list-disc list-inside space-y-1 marker:text-accent">
          <li><span className="text-text-primary">Entry:</span> на границу range (rangeHigh для LONG, rangeLow для SHORT).
            {variant === 'C' && <span className="text-accent"> Limit-ордер, maker fee 0.02%, без slip — fill точно на уровне.</span>}
            {variant !== 'C' && <span> Market при пробое (taker 0.05% + slip 0.03%).</span>}
          </li>
          <li><span className="text-text-primary">Stop Loss:</span> противоположная граница диапазона.</li>
          <li><span className="text-text-primary">Take Profits:</span> entry ± 1×rangeSize, ±2×rangeSize, ±3×rangeSize.</li>
          <li><span className="text-text-primary">Splits:</span> 50% / 30% / 20% — закрытие по TP1 / TP2 / TP3.</li>
          <li><span className="text-text-primary">Trailing SL:</span> после TP1 → BE, после TP2 → TP1, после TP3 → TP2.</li>
          <li>
            <span className="text-text-primary">Risk:</span> 2% депо на сделку,
            {variant === 'A'
              ? ' max 10 одновременных позиций (целевая маржа 10%).'
              : ' max 20 одновременных позиций (целевая маржа 5%).'}
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">Универс монет</h3>
        <p>
          {enabledCoins} монет, прошедших walk-forward отбор (TEST R/tr ≥ +0.20, TRAIN {'>'} 0,
          достаточно сделок в обоих периодах). Список обновлён 09.05.2026 после повторного прогона по 158 закешированным
          монетам Bybit — выбыли HYPE, XRP, SOL, AVAX, ARB, 1000PEPE, BLUR, SAND, ETC, IO, TSTBSC, STRK (провалили TEST на свежих данных),
          добавлены USELESS, SIREN, 1000BONK.
        </p>
        <p className="mt-1 text-xs">
          <span className="text-text-primary">BTC исключён</span> — слишком тихие диапазоны, edge -0.04 R/tr.
        </p>
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">
          Результаты бэктеста (365 дней, {enabledCoins} монет
          {variant === 'B' ? ', 20 conc, 5% margin' : ', 10 conc, 10% margin'})
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border border-input">
            <thead className="bg-input text-text-secondary">
              <tr>
                <th className="text-left px-2 py-1">Период</th>
                <th className="text-right px-2 py-1">Сделок</th>
                <th className="text-right px-2 py-1">R/tr</th>
                <th className="text-right px-2 py-1">FinalDepo ({variant === 'B' ? '$500' : '$500'})</th>
                <th className="text-right px-2 py-1">Drawdown</th>
                <th className="text-right px-2 py-1">WR</th>
              </tr>
            </thead>
            <tbody>
              {variant === 'B' ? (
                <>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">FULL (365d)</td>
                    <td className="text-right px-2 py-1">1 634</td>
                    <td className="text-right px-2 py-1 text-long">+0.39</td>
                    <td className="text-right px-2 py-1 text-long">$35 198 (+6940%)</td>
                    <td className="text-right px-2 py-1 text-short">49.9%</td>
                    <td className="text-right px-2 py-1">52%</td>
                  </tr>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">TRAIN (60%)</td>
                    <td className="text-right px-2 py-1">1 308</td>
                    <td className="text-right px-2 py-1 text-long">+0.32</td>
                    <td className="text-right px-2 py-1 text-long">$16 095</td>
                    <td className="text-right px-2 py-1 text-short">49.9%</td>
                    <td className="text-right px-2 py-1">52%</td>
                  </tr>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">TEST (40% out-of-sample)</td>
                    <td className="text-right px-2 py-1">756</td>
                    <td className="text-right px-2 py-1 text-long">+0.49</td>
                    <td className="text-right px-2 py-1 text-long">$14 278</td>
                    <td className="text-right px-2 py-1">25.5%</td>
                    <td className="text-right px-2 py-1">55%</td>
                  </tr>
                </>
              ) : (
                <>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">FULL (365d)</td>
                    <td className="text-right px-2 py-1">929</td>
                    <td className="text-right px-2 py-1 text-long">+0.30</td>
                    <td className="text-right px-2 py-1 text-long">$7,588 (+1418%)</td>
                    <td className="text-right px-2 py-1">29.9%</td>
                    <td className="text-right px-2 py-1">51%</td>
                  </tr>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">TRAIN (60%)</td>
                    <td className="text-right px-2 py-1">706</td>
                    <td className="text-right px-2 py-1 text-long">+0.23</td>
                    <td className="text-right px-2 py-1 text-long">$3,681</td>
                    <td className="text-right px-2 py-1">29.9%</td>
                    <td className="text-right px-2 py-1">51%</td>
                  </tr>
                  <tr className="border-t border-input">
                    <td className="px-2 py-1 text-text-primary">TEST (40% out-of-sample)</td>
                    <td className="text-right px-2 py-1">503</td>
                    <td className="text-right px-2 py-1 text-long">+0.32</td>
                    <td className="text-right px-2 py-1 text-long">$4,459</td>
                    <td className="text-right px-2 py-1">22.7%</td>
                    <td className="text-right px-2 py-1">55%</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs">
          Прогон 09.05.2026 на обновлённом универсе из {enabledCoins} монет
          {variant === 'B'
            ? ' (sizing: max 20 одновременных, target margin 5% депо). Числа в $500 эквиваленте — реальный B-депозит стартует с $320, абсолютные $ пропорционально меньше, R/tr и DD% не меняются.'
            : ' (sizing: max 10 одновременных, target margin 10% депо).'}
          {' '}Включён BTC ADX{'>'}20 фильтр и margin guard skip-only.
        </p>
        <p className="mt-1 text-xs">
          <span className="text-text-primary">TEST {'>'} TRAIN</span> по R/tr
          ({variant === 'B' ? '+0.49 vs +0.32' : '+0.32 vs +0.23'}) — стабильный out-of-sample edge,
          стратегия не переподогнана под историю.
        </p>
        {variant === 'B' && (
          <p className="mt-2 text-xs text-short">
            ⚠ Цена за рост upside: drawdown до 50% против 30% у A. Минимум депо в первый месяц −21% от старта
            (по бэктесту). Edge тонкий — slippage 0.15%+ убивает результат сильнее чем у A.
          </p>
        )}
      </section>

      {variant === 'A' ? (
        <section>
          <h3 className="text-text-primary font-semibold mb-1">Сравнение с другими стратегиями</h3>
          <p className="text-xs">
            На том же годе backtest (депо $500, риск 2%, max 10 concurrent) прогонялись 5 стратегий:
          </p>
          <ul className="list-disc list-inside space-y-0.5 marker:text-accent text-xs mt-1">
            <li><span className="text-long">Daily Breakout — единственная со стабильным walk-forward</span> (TRAIN +77%, TEST +57%, оба плюс).</li>
            <li>Levels v2 — TEST -63%, отвергнута.</li>
            <li>RSI 4h Mean Reversion — TEST -6%, отвергнута.</li>
            <li>EMA Pullback — TEST +50%, но TRAIN -39% (overfit).</li>
            <li>Funding Divergence — TEST -20%, отвергнута.</li>
          </ul>
        </section>
      ) : (
        <section>
          <h3 className="text-text-primary font-semibold mb-1">A vs B: что меняется</h3>
          <p className="text-xs">
            Та же стратегия, тот же поток сигналов, тот же универс монет. Разница только в sizing — это
            эксперимент: больше параллельных сделок размером поменьше.
          </p>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs font-mono border border-input">
              <thead className="bg-input text-text-secondary">
                <tr>
                  <th className="text-left px-2 py-1">Метрика (FULL 365d)</th>
                  <th className="text-right px-2 py-1">A: 10 conc, 10%</th>
                  <th className="text-right px-2 py-1">B: 20 conc, 5%</th>
                  <th className="text-right px-2 py-1">Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-input">
                  <td className="px-2 py-1 text-text-primary">Сделок</td>
                  <td className="text-right px-2 py-1">929</td>
                  <td className="text-right px-2 py-1 text-long">1 634</td>
                  <td className="text-right px-2 py-1 text-long">+76%</td>
                </tr>
                <tr className="border-t border-input">
                  <td className="px-2 py-1 text-text-primary">R/tr</td>
                  <td className="text-right px-2 py-1">+0.30</td>
                  <td className="text-right px-2 py-1 text-long">+0.39</td>
                  <td className="text-right px-2 py-1 text-long">+0.09</td>
                </tr>
                <tr className="border-t border-input">
                  <td className="px-2 py-1 text-text-primary">FinalDepo ($500)</td>
                  <td className="text-right px-2 py-1">$7 588</td>
                  <td className="text-right px-2 py-1 text-long">$35 198</td>
                  <td className="text-right px-2 py-1 text-long">×4.6</td>
                </tr>
                <tr className="border-t border-input">
                  <td className="px-2 py-1 text-text-primary">Max Drawdown</td>
                  <td className="text-right px-2 py-1">29.9%</td>
                  <td className="text-right px-2 py-1 text-short">49.9%</td>
                  <td className="text-right px-2 py-1 text-short">+20 пп</td>
                </tr>
                <tr className="border-t border-input">
                  <td className="px-2 py-1 text-text-primary">Win Rate</td>
                  <td className="text-right px-2 py-1">51%</td>
                  <td className="text-right px-2 py-1">52%</td>
                  <td className="text-right px-2 py-1">+1 пп</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs">
            B обыгрывает A в 11 из 13 месяцев по абсолютному PnL. Но цена за upside — drawdown почти
            в 2× (до 50% от пика) и минимум депо ниже стартового в первый месяц на 21% (по бэктесту).
            Реалистичность чисел зависит от slippage — при 0.10–0.15% slip B страдает сильнее A.
          </p>
        </section>
      )}

      <section>
        <h3 className="text-text-primary font-semibold mb-1">По месяцам</h3>
        {variant === 'B' ? (
          <p className="text-xs">
            11 из 13 месяцев в плюс (как у A). Лучший: сентябрь 2025 (+1.18 R/tr, +$10 953 на 199 сделках —
            один большой импульсный месяц делает огромный вклад в финальный депозит). Убыточные те же что у A:
            февраль 2026 (-0.02) и неполный май 2026.
          </p>
        ) : (
          <p className="text-xs">
            11 из 13 месяцев в плюс. Лучший: сентябрь 2025 (+0.47 R/tr, 85 трейдов). Убыточные: февраль 2026 (-0.04)
            и апрель 2026 (-0.29) — рынок без чётких сессионных пробоев.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">Известные ограничения</h3>
        <ul className="list-disc list-inside space-y-0.5 marker:text-short text-xs">
          <li><span className="text-text-primary">Edge тонкий</span> — нужен большой N сделок, чтобы compound сработал. На коротком горизонте (1–2 мес) возможна просадка.</li>
          <li>
            <span className="text-text-primary">Slippage критичен:</span>
            {variant === 'B'
              ? ' B чувствительнее A — больше сделок (1 634 vs 929) каждая платит slip. При 0.10% slip finalDepo падает до $9 676 ($26 236 при 0.05%).'
              : ' 0.15%+ за сторону убивает edge в TEST. На реале использовать LIMIT ордера (maker fee).'}
          </li>
          <li>
            <span className="text-text-primary">Drawdown</span>
            {variant === 'B'
              ? ' до 50% при cap=20 и риске 2% (до 40% депо в риске одновременно). Минимум депо в первый месяц −21% от старта.'
              : ' до 33–40% при cap=10 и риске 2% (до 20% депо в риске одновременно).'}
          </li>
          <li><span className="text-text-primary">TP3 редко достигается</span> — большинство выходов через TP1/TP2, split structure это компенсирует.</li>
          <li>
            <span className="text-text-primary">
              Concurrent cap = {variant === 'A' ? '10' : '20'}
            </span>
            {variant !== 'A'
              ? ' — экспериментальная конфигурация. Backtest показал лучший R/tr и finalDepo чем у cap=10 на обновлённом 23-символьном универсе, но за счёт удвоенного DD. Forward-test проверяет реалистичность чисел в живом рынке.'
              : ' — проверено backtest sweep [5/10/15/20/30/∞]: cap=10 даёт максимальный finalDepo на FULL/TRAIN/TEST.'}
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-text-primary font-semibold mb-1">Параметры платформы</h3>
        <ul className="list-disc list-inside space-y-0.5 text-xs marker:text-accent">
          <li>Стартовый депозит: ${variant === 'A' ? '500' : '320'}</li>
          <li>Риск на сделку: 2% от текущего депо</li>
          <li>Целевая маржа на сделку: {variant === 'A' ? '10%' : '5%'} (через margin guard skip-only)</li>
          <li>Round-trip комиссии: {variant === 'C' ? '0.04% (maker entry + maker TP fills)' : '0.08% (Bybit crypto)'}</li>
          <li>Дневной лимит убытка: 5%, недельный: 15%</li>
          <li>Max concurrent positions: {variant === 'A' ? '10' : '20'}, max per symbol: 1</li>
          {variant === 'C' && <li className="text-accent">Entry: limit-ордер на rangeEdge (PENDING_LIMIT занимает слот)</li>}
        </ul>
      </section>
    </div>
  )
}
