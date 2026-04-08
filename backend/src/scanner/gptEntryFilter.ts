import OpenAI from 'openai'
import { EntryAnalysisResult } from './entryAnalyzer'
import { RegimeContext } from './marketRegime'

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

const SYSTEM = `Ты профессиональный крипто-трейдер с 10-летним опытом.
Тебе дают анализ лимитных точек входа для монеты — два уровня для лимитных ордеров.

Твоя задача:
1. Оценить качество каждого уровня входа (A/B/C/D/F)
2. Оценить общий сетап
3. Описать риски
4. Если уровни неоптимальны — предложить корректировки
5. Оценить вероятность заполнения каждого лимитного ордера

Отвечай СТРОГО в формате JSON (без markdown):
{
  "setupQuality": "A" | "B" | "C" | "D" | "F",
  "commentary": "краткий комментарий на русском (2-3 предложения)",
  "entry1Quality": "A" | "B" | "C" | "D" | "F",
  "entry1Comment": "комментарий к Entry 1",
  "entry2Quality": "A" | "B" | "C" | "D" | "F",
  "entry2Comment": "комментарий к Entry 2",
  "risks": ["риск 1", "риск 2"],
  "suggestedEntry1": number | null,
  "suggestedEntry2": number | null,
  "suggestedSL": number | null,
  "keyLevels": ["уровень 1", "уровень 2"]
}

Критерии качества уровня:
- A: Сильный кластер уровней, высокая вероятность реакции цены
- B: Хороший уровень, есть подтверждение
- C: Средний, может сработать
- D: Слабый уровень, мало подтверждений
- F: Плохой уровень, лучше не использовать`

export type SetupQuality = 'A' | 'B' | 'C' | 'D' | 'F'

export interface EntryGPTAnnotation {
  setupQuality: SetupQuality
  commentary: string
  entry1Quality: SetupQuality
  entry1Comment: string
  entry2Quality: SetupQuality
  entry2Comment: string
  risks: string[]
  suggestedEntry1: number | null
  suggestedEntry2: number | null
  suggestedSL: number | null
  keyLevels: string[]
}

export async function gptAnnotateEntrySignal(
  result: EntryAnalysisResult,
  regime: RegimeContext,
): Promise<EntryGPTAnnotation> {
  const { tf1h, tf4h } = result.indicators

  const prompt = `АНАЛИЗ ЛИМИТНЫХ ВХОДОВ:

Монета: ${result.coin}
Направление: ${result.type}
Текущая цена: $${result.currentPrice}
Стратегия: ${result.strategy}
Score: ${result.score}/100

ENTRY 1 (Основной, ${result.entry1.positionPercent}%): $${result.entry1.price}
  Расстояние от цены: ${result.entry1.cluster.distancePercent}%
  Вероятность заполнения: ${Math.round(result.entry1.cluster.fillProbability * 100)}%
  Уровни в кластере: ${result.entry1.cluster.sources.join(', ')}
  Суммарный вес: ${result.entry1.cluster.totalWeight}

ENTRY 2 (Усреднение, ${result.entry2.positionPercent}%): $${result.entry2.price}
  Расстояние от цены: ${result.entry2.cluster.distancePercent}%
  Вероятность заполнения: ${Math.round(result.entry2.cluster.fillProbability * 100)}%
  Уровни в кластере: ${result.entry2.cluster.sources.join(', ')}
  Суммарный вес: ${result.entry2.cluster.totalWeight}

Средний вход: $${result.avgEntry}
Stop Loss: $${result.stopLoss} (${result.slPercent}%)
TP1: $${result.takeProfits[0]?.price} (R:R ${result.takeProfits[0]?.rr})
TP2: $${result.takeProfits[1]?.price} (R:R ${result.takeProfits[1]?.rr})
TP3: $${result.takeProfits[2]?.price} (R:R ${result.takeProfits[2]?.rr})
Leverage: ${result.leverage}x

ИНДИКАТОРЫ 1h:
Price: $${tf1h.price} | EMA9: $${tf1h.ema9} | EMA20: $${tf1h.ema20} | EMA50: $${tf1h.ema50}
RSI: ${tf1h.rsi} | MACD: ${tf1h.macd} (hist: ${tf1h.macdHistogram})
BB: $${tf1h.bbLower} — $${tf1h.bbMiddle} — $${tf1h.bbUpper} (width: ${tf1h.bbWidth}%)
Support: $${tf1h.support} | Resistance: $${tf1h.resistance}
ATR: $${tf1h.atr} | VWAP: $${tf1h.vwap} | Volume: ${tf1h.volRatio}x

ИНДИКАТОРЫ 4h:
Trend: ${tf4h.trend} | RSI: ${tf4h.rsi} | ADX: ${tf4h.adx}
EMA20: $${tf4h.ema20} | EMA50: $${tf4h.ema50}
Support: $${tf4h.support} | Resistance: $${tf4h.resistance}

КОНТЕКСТ РЫНКА:
Режим: ${regime.regime} (confidence: ${regime.confidence}%)
BTC тренд: ${regime.btcTrend}
Fear & Greed: ${regime.fearGreedZone}
${result.funding ? `Funding Rate: ${(result.funding.fundingRate * 100).toFixed(4)}%` : ''}
${result.oi ? `Open Interest: $${result.oi.openInterest.toLocaleString()}` : ''}
${result.news && result.news.total > 0 ? `Новости: ${result.news.score > 0 ? '+' : ''}${result.news.score} (${result.news.positive}⬆ ${result.news.negative}⬇)` : ''}`

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5.4',
      max_completion_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    })

    const text = completion.choices[0]?.message?.content?.trim()
    if (!text) throw new Error('Empty GPT response')

    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const review = JSON.parse(cleaned)

    const validQualities: SetupQuality[] = ['A', 'B', 'C', 'D', 'F']

    return {
      setupQuality: validQualities.includes(review.setupQuality) ? review.setupQuality : 'C',
      commentary: review.commentary || '',
      entry1Quality: validQualities.includes(review.entry1Quality) ? review.entry1Quality : 'C',
      entry1Comment: review.entry1Comment || '',
      entry2Quality: validQualities.includes(review.entry2Quality) ? review.entry2Quality : 'C',
      entry2Comment: review.entry2Comment || '',
      risks: review.risks || [],
      suggestedEntry1: review.suggestedEntry1 ?? null,
      suggestedEntry2: review.suggestedEntry2 ?? null,
      suggestedSL: review.suggestedSL ?? null,
      keyLevels: review.keyLevels || [],
    }
  } catch (err) {
    console.error('[GPT Entry Annotator] Error:', err)
    return {
      setupQuality: 'C',
      commentary: 'AI аннотация недоступна',
      entry1Quality: 'C',
      entry1Comment: '',
      entry2Quality: 'C',
      entry2Comment: '',
      risks: ['AI проверка не выполнена'],
      suggestedEntry1: null,
      suggestedEntry2: null,
      suggestedSL: null,
      keyLevels: [],
    }
  }
}
