import { EntryAnalysisResult } from './entryAnalyzer'
import { RegimeContext } from './marketRegime'
import {
  SetupQuality,
  VALID_QUALITIES,
  callGptJson,
  formatMarketContext,
  formatIndicators1h,
  formatIndicators4h,
} from './gpt/common'

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

export type { SetupQuality }

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

const NEUTRAL_ANNOTATION: EntryGPTAnnotation = {
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

export async function gptAnnotateEntrySignal(
  result: EntryAnalysisResult,
  regime: RegimeContext,
): Promise<EntryGPTAnnotation> {
  const { tf1h, tf4h } = result.indicators

  const marketCtx = formatMarketContext({
    funding: result.funding,
    oi: result.oi,
    liquidations: result.liquidations,
    lsr: result.lsr,
    news: result.news,
    includeNewsHeadlines: false,
  })

  const fillPct1 = Math.round(result.entry1.cluster.fillProbability * 100)
  const fillPct2 = Math.round(result.entry2.cluster.fillProbability * 100)

  const prompt = `АНАЛИЗ ЛИМИТНЫХ ВХОДОВ:

Монета: ${result.coin}
Направление: ${result.type}
Текущая цена: $${result.currentPrice}
Стратегия: ${result.strategy}
Score: ${result.score}/100

ENTRY 1 (Основной, ${result.entry1.positionPercent}%): $${result.entry1.price}
  Расстояние от цены: ${result.entry1.cluster.distancePercent}%
  Вероятность заполнения: ${fillPct1}%
  Уровни в кластере: ${result.entry1.cluster.sources.join(', ')}
  Суммарный вес: ${result.entry1.cluster.totalWeight}

ENTRY 2 (Усреднение, ${result.entry2.positionPercent}%): $${result.entry2.price}
  Расстояние от цены: ${result.entry2.cluster.distancePercent}%
  Вероятность заполнения: ${fillPct2}%
  Уровни в кластере: ${result.entry2.cluster.sources.join(', ')}
  Суммарный вес: ${result.entry2.cluster.totalWeight}

Средний вход: $${result.avgEntry}
Stop Loss: $${result.stopLoss} (${result.slPercent}%)
TP1: $${result.takeProfits[0]?.price} (R:R ${result.takeProfits[0]?.rr})
TP2: $${result.takeProfits[1]?.price} (R:R ${result.takeProfits[1]?.rr})
TP3: $${result.takeProfits[2]?.price} (R:R ${result.takeProfits[2]?.rr})
Leverage: ${result.leverage}x

ИНДИКАТОРЫ 1h:
${formatIndicators1h(tf1h, false)}

ИНДИКАТОРЫ 4h:
${formatIndicators4h(tf4h)}

КОНТЕКСТ РЫНКА:
Режим: ${regime.regime} (confidence: ${regime.confidence}%)
BTC тренд: ${regime.btcTrend}
Fear & Greed: ${regime.fearGreedZone}
${marketCtx}`

  try {
    const review = await callGptJson(SYSTEM, prompt)
    return {
      setupQuality: VALID_QUALITIES.includes(review.setupQuality) ? review.setupQuality : 'C',
      commentary: review.commentary || '',
      entry1Quality: VALID_QUALITIES.includes(review.entry1Quality) ? review.entry1Quality : 'C',
      entry1Comment: review.entry1Comment || '',
      entry2Quality: VALID_QUALITIES.includes(review.entry2Quality) ? review.entry2Quality : 'C',
      entry2Comment: review.entry2Comment || '',
      risks: review.risks || [],
      suggestedEntry1: review.suggestedEntry1 ?? null,
      suggestedEntry2: review.suggestedEntry2 ?? null,
      suggestedSL: review.suggestedSL ?? null,
      keyLevels: review.keyLevels || [],
    }
  } catch (err) {
    console.error('[GPT Entry Annotator] Error:', err)
    return NEUTRAL_ANNOTATION
  }
}
