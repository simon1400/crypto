import OpenAI from 'openai'
import { SignalWithRisk } from './riskCalc'
import { RegimeContext } from './marketRegime'
import { FundingData } from '../services/fundingRate'
import { NewsSentiment } from '../services/news'
import { OIData } from '../services/openInterest'

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

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

export type SetupQuality = 'A' | 'B' | 'C' | 'D' | 'F'
export type EntryType = 'aggressive' | 'confirmation' | 'pullback'

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

export async function gptAnnotateSignal(
  signal: SignalWithRisk,
  regime: RegimeContext,
  funding?: FundingData | null,
  news?: NewsSentiment | null,
  oi?: OIData | null,
): Promise<GPTAnnotation> {
  const tf1h = signal.indicators.tf1h
  const tf4h = signal.indicators.tf4h

  const prompt = `СИГНАЛ ДЛЯ АННОТАЦИИ:

Монета: ${signal.coin}
Направление: ${signal.type}
Стратегия: ${signal.strategy}
Score: ${signal.score}/100
Breakdown: Trend=${signal.scoreBreakdown.trend}/15 (MTF×${signal.scoreBreakdown.mtfMultiplier}) | Momentum=${signal.scoreBreakdown.momentum}/15 | Volatility=${signal.scoreBreakdown.volatility}/10 | MeanRev=${signal.scoreBreakdown.meanRevStretch}/10 | Levels=${signal.scoreBreakdown.levelInteraction}/15 | Vol=${signal.scoreBreakdown.volume}/15 | Market=${signal.scoreBreakdown.marketContext}/15

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
Price: $${tf1h?.price} | EMA9: $${tf1h?.ema9} | EMA20: $${tf1h?.ema20} | EMA50: $${tf1h?.ema50}
RSI: ${tf1h?.rsi} | MACD: ${tf1h?.macd} (hist: ${tf1h?.macdHistogram})
BB: $${tf1h?.bbLower} — $${tf1h?.bbMiddle} — $${tf1h?.bbUpper} (width: ${tf1h?.bbWidth}%)
Stoch: %K=${tf1h?.stochK} %D=${tf1h?.stochD} | ADX: ${tf1h?.adx}
Support: $${tf1h?.support} | Resistance: $${tf1h?.resistance}
ATR: $${tf1h?.atr} | VWAP: $${tf1h?.vwap} | Volume: ${tf1h?.volRatio}x
Patterns: ${tf1h?.patterns?.join(', ') || 'нет'}

ИНДИКАТОРЫ 4h:
Trend: ${tf4h?.trend} | RSI: ${tf4h?.rsi} | ADX: ${tf4h?.adx}
EMA20: $${tf4h?.ema20} | EMA50: $${tf4h?.ema50}
MACD: ${tf4h?.macd} (hist: ${tf4h?.macdHistogram})
Support: $${tf4h?.support} | Resistance: $${tf4h?.resistance}

КОНТЕКСТ РЫНКА:
Режим: ${regime.regime} (confidence: ${regime.confidence}%)
BTC тренд: ${regime.btcTrend}
Fear & Greed: ${regime.fearGreedZone}
Volatility: ${regime.volatility}
${funding ? `Funding Rate: ${(funding.fundingRate * 100).toFixed(4)}%` : ''}
${oi ? `Open Interest: $${oi.openInterest.toLocaleString()}` : ''}
${news && news.total > 0 ? `Новости: ${news.score > 0 ? '+' : ''}${news.score} (${news.positive}⬆ ${news.negative}⬇)\nЗаголовки: ${news.headlines.slice(0, 3).join('; ')}` : ''}`

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
    const validEntryTypes: EntryType[] = ['aggressive', 'confirmation', 'pullback']

    return {
      setupQuality: validQualities.includes(review.setupQuality) ? review.setupQuality : 'C',
      commentary: review.commentary || '',
      risks: review.risks || [],
      conflicts: review.conflicts || [],
      suggestedEntry: review.suggestedEntry ?? null,
      suggestedSL: review.suggestedSL ?? null,
      suggestedTP1: review.suggestedTP1 ?? null,
      recommendedEntryType: validEntryTypes.includes(review.recommendedEntryType) ? review.recommendedEntryType : 'confirmation',
      keyLevels: review.keyLevels || [],
      waitForConfirmation: review.waitForConfirmation ?? null,
    }
  } catch (err) {
    console.error('[GPT Annotator] Error:', err)
    // On GPT failure, return neutral annotation — signal still passes through
    return {
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
  }
}