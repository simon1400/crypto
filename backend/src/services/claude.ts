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

ЗАДАЧА: Для каждой монеты — найти ЛУЧШУЮ точку входа по ЛИМИТНОМУ ОРДЕРУ на ближайшие 1-4 часа.

ВАЖНО:
- НИКОГДА не используй слово "ПРОПУСТИТЬ". Всегда давай конкретный торговый план.
- Точка входа ОБЯЗАТЕЛЬНО должна отличаться от текущей цены. Это лимитный ордер — цена, к которой график может прийти.
- Для LONG — точка входа НИЖЕ текущей цены (откат к поддержке/Fib/VWAP/Pivot)
- Для SHORT — точка входа ВЫШЕ текущей цены (отскок к сопротивлению/Fib/Pivot)
- Всегда выбирай лучшее направление (LONG или SHORT) на основе анализа

Проанализировать для выбора направления и точки входа:
1. Графические паттерны (двойное дно/вершина, флаги, клинья, треугольники, голова-плечи)
2. Уровни Фибоначчи — к какому уровню цена может откатиться
3. Поддержка/сопротивление на всех таймфреймах
4. Bollinger Bands — отскок от границ, сжатие
5. MACD — дивергенции, пересечения
6. RSI + Stochastic — зоны перекупленности/перепроданности
7. ADX — сила тренда
8. VWAP — ориентир справедливой цены
9. Pivot Points
10. Свечные паттерны
11. Мультитаймфрейм анализ — совпадение сигналов на 15m/1h/4h

Формат для КАЖДОЙ монеты:

🪙 [TICKER] — $[текущая цена]
📊 Тренд: [4h: TREND | 1h: TREND | 15m: TREND]
📐 Паттерны: [обнаруженные графические паттерны и свечные формации]

🎯 Сигнал: [LONG / SHORT]
💡 Почему это направление: [краткое обоснование со ссылкой на индикаторы]

📍 Лимитный вход: $[цена — ОТЛИЧАЕТСЯ от текущей]
📝 Почему эта цена входа:
  • [причина 1 — уровень/паттерн/индикатор]
  • [причина 2]
  • [причина 3]
⏳ Ожидание: цена дойдёт до входа за ~[X] часов

🛑 Stop Loss: $[цена] (−[X]% от входа)
✅ Take Profit 1: $[цена] (+[X]% от входа)
✅ Take Profit 2: $[цена] (+[X]% от входа)
⚖️ Risk/Reward: 1:[X]

⚠️ Риски:
  • [риск 1]
  • [риск 2]

---

ПРАВИЛА (нарушать нельзя):
- ВСЕГДА давай торговый план. Никаких "ПРОПУСТИТЬ" или "SKIP"
- Точка входа ВСЕГДА отличается от текущей цены — это лимитный ордер
- Для LONG вход ниже текущей цены, для SHORT — выше текущей
- Выбирай лучшее направление (LONG или SHORT) по R:R и вероятности
- RSI > 75 на 1h И 4h → давай SHORT с входом выше текущей цены
- RSI < 25 на 1h И 4h → давай LONG с входом ниже текущей цены
- SL для LONG → ниже ближайшей сильной поддержки
- SL для SHORT → выше ближайшего сильного сопротивления
- TP1 = ближайший уровень, TP2 = следующий
- R:R минимум 1:1.5
- ADX < 15 → пометить: ⚠️ Слабый тренд
- volRatio < 0.8 → пометить: ⚠️ Слабый объём

В конце:
📋 ИТОГ: [2-3 предложения: общее состояние рынка, какие монеты самые перспективные прямо сейчас]`

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
