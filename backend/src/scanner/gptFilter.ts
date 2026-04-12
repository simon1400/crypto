import { SignalWithRisk } from './scoring/types'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { NewsSentiment } from '../services/news'
import { OIData } from '../services/openInterest'
import { LiquidationStats } from '../services/liquidations'
import { LSRData } from '../services/longShortRatio'
import {
  SetupQuality,
  VALID_QUALITIES,
  callGptJson,
  formatMarketContext,
  formatIndicators1h,
  formatIndicators4h,
} from './gpt/common'

// GPT is an ANNOTATOR, not a gatekeeper.
// It does NOT confirm/reject signals.
// It provides: commentary, risks, setup quality grade, suggested adjustments.
// The user decides whether to act on the signal.

const SYSTEM = `Ты профессиональный крипто-трейдер с 10-летним опытом.
Тебе дают автоматически сгенерированный торговый сигнал с техническим анализом.

Твоя задача — АННОТИРОВАТЬ сигнал, а НЕ принимать решение за трейдера.

Ты должен:
1. Оценить качество сетапа (A/B/C/D/F)
2. Описать комментарий к сетапу (2-3 предложения)
3. Перечислить риски
4. Перечислить конфликты между индикаторами/таймфреймами
5. Предложить корректировки entry/SL/TP если текущие неоптимальны
6. Рекомендовать тип входа: aggressive / confirmation / pullback

Отвечай СТРОГО в формате JSON (без markdown):
{
  "setupQuality": "A" | "B" | "C" | "D" | "F",
  "commentary": "краткий комментарий на русском (2-3 предложения)",
  "risks": ["риск 1", "риск 2"],
  "conflicts": ["конфликт 1", "конфликт 2"],
  "suggestedEntry": number | null,
  "suggestedSL": number | null,
  "suggestedTP1": number | null,
  "recommendedEntryType": "aggressive" | "confirmation" | "pullback",
  "keyLevels": ["уровень 1", "уровень 2"],
  "waitForConfirmation": "описание что ждать, если нужно" | null
}

Критерии качества:
- A: Идеальный сетап, все индикаторы согласованы, отличный R:R
- B: Хороший сетап, мелкие конфликты, но сигнал рабочий
- C: Средний, есть заметные конфликты, нужна осторожность
- D: Слабый, много конфликтов, лучше ждать подтверждение
- F: Очень слабый, противоречия критичные`

export type { SetupQuality }
export type EntryType = 'aggressive' | 'confirmation' | 'pullback'
const VALID_ENTRY_TYPES: EntryType[] = ['aggressive', 'confirmation', 'pullback']

export interface GPTAnnotation {
  setupQuality: SetupQuality
  commentary: string
  risks: string[]
  conflicts: string[]
  suggestedEntry: number | null
  suggestedSL: number | null
  suggestedTP1: number | null
  recommendedEntryType: EntryType
  keyLevels: string[]
  waitForConfirmation: string | null
}

const NEUTRAL_ANNOTATION: GPTAnnotation = {
  setupQuality: 'C',
  commentary: 'AI аннотация недоступна — оценка не выполнена',
  risks: ['AI проверка не выполнена'],
  conflicts: [],
  suggestedEntry: null,
  suggestedSL: null,
  suggestedTP1: null,
  recommendedEntryType: 'confirmation',
  keyLevels: [],
  waitForConfirmation: null,
}

export async function gptAnnotateSignal(
  signal: SignalWithRisk,
  regime: RegimeContext,
  funding?: FundingData | null,
  news?: NewsSentiment | null,
  oi?: OIData | null,
  liquidations?: LiquidationStats | null,
  lsr?: LSRData | null,
): Promise<GPTAnnotation> {
  const tf1h = signal.indicators.tf1h
  const tf4h = signal.indicators.tf4h
  const sb = signal.scoreBreakdown

  const marketCtx = formatMarketContext({ funding, oi, liquidations, lsr, news, includeNewsHeadlines: true })

  const prompt = `СИГНАЛ ДЛЯ АННОТАЦИИ:

Монета: ${signal.coin}
Направление: ${signal.type}
Стратегия: ${signal.strategy}
Score: ${signal.score}/100
Breakdown: Trend=${sb.trend}/15 (MTF×${sb.mtfMultiplier}) | Momentum=${sb.momentum}/15 | Volatility=${sb.volatility}/10 | MeanRev=${sb.meanRevStretch}/10 | Levels=${sb.levelInteraction}/15 | Vol=${sb.volume}/15 | Market=${sb.marketContext}/15

Entry: $${signal.entry}
Stop Loss: $${signal.stopLoss} (${signal.slPercent}%)
TP1: $${signal.takeProfits[0]?.price} (R:R ${signal.takeProfits[0]?.rr})
TP2: $${signal.takeProfits[1]?.price} (R:R ${signal.takeProfits[1]?.rr})
TP3: $${signal.takeProfits[2]?.price} (R:R ${signal.takeProfits[2]?.rr})
Leverage: ${signal.leverage}x
Position: ${signal.positionPct}%

Причины стратегии:
${signal.reasons.map(r => `• ${r}`).join('\n')}

ИНДИКАТОРЫ 1h:
${formatIndicators1h(tf1h)}

ИНДИКАТОРЫ 4h:
${formatIndicators4h(tf4h)}

КОНТЕКСТ РЫНКА:
Режим: ${regime.regime} (confidence: ${regime.confidence}%)
BTC тренд: ${regime.btcTrend}
Fear & Greed: ${regime.fearGreedZone}
Volatility: ${regime.volatility}
${marketCtx}`

  try {
    const review = await callGptJson(SYSTEM, prompt)
    return {
      setupQuality: VALID_QUALITIES.includes(review.setupQuality) ? review.setupQuality : 'C',
      commentary: review.commentary || '',
      risks: review.risks || [],
      conflicts: review.conflicts || [],
      suggestedEntry: review.suggestedEntry ?? null,
      suggestedSL: review.suggestedSL ?? null,
      suggestedTP1: review.suggestedTP1 ?? null,
      recommendedEntryType: VALID_ENTRY_TYPES.includes(review.recommendedEntryType) ? review.recommendedEntryType : 'confirmation',
      keyLevels: review.keyLevels || [],
      waitForConfirmation: review.waitForConfirmation ?? null,
    }
  } catch (err) {
    console.error('[GPT Annotator] Error:', err)
    return NEUTRAL_ANNOTATION
  }
}
