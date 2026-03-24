import OpenAI from 'openai'
import { MultiTFIndicators } from './indicators'
import { MarketOverview } from './market'

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

const SYSTEM = `Ты профессиональный крипто-трейдер и технический аналитик.
Специализируешься на краткосрочных сделках (1-4 часа).
Анализируешь графические паттерны, индикаторы на нескольких таймфреймах, уровни Фибоначчи.
Твоя главная задача — найти ОПТИМАЛЬНУЮ точку входа, к которой цена может дойти, а не входить по текущей цене.
Ты одинаково хорошо торгуешь как LONG, так и SHORT позиции.
Давай конкретные цифры. Соблюдай риск-менеджмент строго.`

function formatIndicators(ticker: string, data: MultiTFIndicators): string {
  const { tf15m, tf1h, tf4h } = data

  const formatTF = (label: string, d: typeof tf15m) => {
    const fibStr = d.fibLevels.map(f => `${f.level}: $${f.price}`).join(' | ')
    const patternsStr = d.patterns.length > 0 ? d.patterns.join(', ') : 'нет'

    return `### ${label}
Цена: $${d.price} | EMA9: $${d.ema9} | EMA20: $${d.ema20} | EMA50: $${d.ema50}
RSI: ${d.rsi} | Тренд: ${d.trend}
MACD: ${d.macd} | Сигнал: ${d.macdSignal} | Гистограмма: ${d.macdHistogram}
Bollinger: Upper $${d.bbUpper} | Middle $${d.bbMiddle} | Lower $${d.bbLower} | Ширина: ${d.bbWidth}%
Stochastic: %K=${d.stochK} %D=${d.stochD}
ADX: ${d.adx} | +DI: ${d.plusDI} | -DI: ${d.minusDI}
ATR: $${d.atr} | VWAP: $${d.vwap}
Поддержка: $${d.support} | Сопротивление: $${d.resistance}
Pivot: $${d.pivot} | R1: $${d.pivotR1} | R2: $${d.pivotR2} | S1: $${d.pivotS1} | S2: $${d.pivotS2}
Фибоначчи: ${fibStr}
Объём: ${d.volRatio}x от среднего | Изменение: ${d.change24h > 0 ? '+' : ''}${d.change24h}%
Паттерны свечей: ${patternsStr}`
  }

  return `## ${ticker} — $${tf1h.price}

${formatTF('15 минут', tf15m)}

${formatTF('1 час', tf1h)}

${formatTF('4 часа', tf4h)}`
}

export async function analyzeWithClaude(
  coinsData: Record<string, MultiTFIndicators>,
  market: MarketOverview
): Promise<string> {
  const datetime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })

  const coinsText = Object.entries(coinsData)
    .map(([ticker, data]) => formatIndicators(ticker, data))
    .join('\n\n---\n\n')

  const userPrompt = `Время анализа: ${datetime}

СОСТОЯНИЕ РЫНКА:
- Fear & Greed: ${market.fearGreed} (${market.fearGreedLabel})
- BTC Dominance: ${market.btcDominance}%

ДАННЫЕ ПО МОНЕТАМ (3 таймфрейма: 15m, 1h, 4h):

${coinsText}

---

ЗАДАЧА: Для каждой монеты — найти ЛУЧШУЮ точку входа на ближайшие 1-4 часа.

НЕ входить по текущей цене! Проанализировать:
1. Графические паттерны (двойное дно/вершина, флаги, клинья, треугольники, голова-плечи и т.д.)
2. Уровни Фибоначчи — к какому уровню цена может откатиться/дойти
3. Уровни поддержки/сопротивления на всех таймфреймах
4. Bollinger Bands — отскок от границ, сжатие перед движением
5. MACD — дивергенции, пересечения
6. RSI + Stochastic — зоны перекупленности/перепроданности, дивергенции
7. ADX — сила тренда (ADX > 25 = сильный тренд)
8. VWAP — как ориентир справедливой цены
9. Pivot Points — ключевые уровни для входа
10. Свечные паттерны — подтверждение разворота или продолжения
11. Мультитаймфрейм анализ — совпадение сигналов на 15m/1h/4h

Для каждой монеты рассмотреть ОБА направления (LONG и SHORT) и выбрать лучшее.

Формат для КАЖДОЙ монеты:

🪙 [TICKER] — $[текущая цена]
📊 Тренд: [4h: TREND | 1h: TREND | 15m: TREND]
📐 Паттерны: [обнаруженные графические паттерны и свечные формации]

🎯 Сигнал: [LONG / SHORT / ПРОПУСТИТЬ]
💡 Обоснование направления: [почему LONG лучше SHORT или наоборот, со ссылкой на индикаторы]

📍 Оптимальная точка входа: $[цена] (лимитный ордер)
📝 Почему эта точка входа:
  • [причина 1 — уровень/паттерн/индикатор]
  • [причина 2]
  • [причина 3]
⏳ Ожидание входа: цена может дойти до этого уровня в течение [X] часов

🛑 Stop Loss: $[цена] (−[X]% от входа)
✅ Take Profit 1: $[цена] (+[X]% от входа) — [ближайший уровень/почему]
✅ Take Profit 2: $[цена] (+[X]% от входа) — [следующий уровень/почему]
⚖️ Risk/Reward: 1:[X]

📊 Подтверждающие сигналы:
  • RSI: [значение и интерпретация]
  • MACD: [состояние и дивергенции]
  • Stochastic: [зона и пересечение]
  • ADX: [сила тренда]
  • Bollinger: [позиция цены относительно полос]
  • Объём: [соотношение и интерпретация]

⚠️ Риски:
  • [риск 1]
  • [риск 2]

🔄 Альтернативный сценарий:
  • Если цена НЕ дойдёт до точки входа — [что делать]
  • Если пробьёт SL — [следующий уровень]

---

ПРАВИЛА (нарушать нельзя):
- НЕ входить по текущей цене — рассчитать оптимальный вход на основе уровней
- Рассмотреть и LONG и SHORT — выбрать лучший по R:R и вероятности
- RSI > 75 на 1h И 4h → только SHORT или ПРОПУСТИТЬ
- RSI < 25 на 1h И 4h → только LONG или ПРОПУСТИТЬ
- SL для LONG → ниже ближайшей сильной поддержки (support, Fib, Pivot S)
- SL для SHORT → выше ближайшего сильного сопротивления (resistance, Fib, Pivot R)
- TP1 = ближайший уровень (Fib/Pivot/BB), TP2 = следующий уровень
- R:R минимум 1:1.5
- ADX < 15 → пометить: ⚠️ Слабый тренд, высокий риск ложного движения
- volRatio < 0.8 → пометить: ⚠️ Слабый объём
- Нет чёткого сетапа или конфликт таймфреймов → ПРОПУСТИТЬ с объяснением
- Если MACD дивергенция расходится с трендом → упомянуть как предупреждение
- Bollinger сжатие (bbWidth < 3%) → ожидать волатильный пробой, быть осторожнее с SL

В конце:
📋 ИТОГ: [3-5 предложений: общее состояние рынка, какие монеты наиболее перспективны, куда может пойти рынок в ближайшие часы, общая рекомендация по размеру позиции]`

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-5.4',
    max_completion_tokens: 5000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  })

  const text = completion.choices[0]?.message?.content
  if (!text) throw new Error('Empty response from OpenAI')
  return text
}
