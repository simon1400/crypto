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

const SYSTEM = `Ты профессиональный крипто-трейдер с 10-летним опытом.
Тебе дают автоматически сгенерированный торговый сигнал с техническим анализом.
Твоя задача — ПОДТВЕРДИТЬ или ОТКЛОНИТЬ сигнал.

Будь критичным. Отклоняй сигналы:
- С конфликтующими индикаторами на разных таймфреймах
- С плохим R:R (меньше 1:1.5)
- Против сильного тренда без веских причин
- С слишком близким SL (будет выбит шумом)
- С слишком далёким entry (цена может не дойти)

Отвечай СТРОГО в формате JSON (без markdown):
{
  "verdict": "CONFIRM" | "REJECT",
  "confidence": 1-10,
  "adjustedEntry": number | null,
  "adjustedSL": number | null,
  "adjustedTP1": number | null,
  "reasoning": "краткое объяснение на русском (2-3 предложения)",
  "risks": ["риск 1", "риск 2"],
  "keyLevels": ["уровень 1", "уровень 2"]
}`

export interface GPTReview {
  verdict: 'CONFIRM' | 'REJECT'
  confidence: number
  adjustedEntry: number | null
  adjustedSL: number | null
  adjustedTP1: number | null
  reasoning: string
  risks: string[]
  keyLevels: string[]
}

export async function gptFilterSignal(
  signal: SignalWithRisk,
  regime: RegimeContext,
  funding?: FundingData | null,
  news?: NewsSentiment | null,
  oi?: OIData | null,
): Promise<GPTReview> {
  const { indicators: ind } = signal as any
  const tf1h = ind?.tf1h
  const tf4h = ind?.tf4h

  const prompt = `СИГНАЛ ДЛЯ ПРОВЕРКИ:

Монета: ${signal.coin}
Направление: ${signal.type}
Стратегия: ${signal.strategy}
Score: ${signal.score}/100
Breakdown: Tech=${signal.scoreBreakdown.technical}/35 | Multi-TF=${signal.scoreBreakdown.multiTF}/20 | Vol=${signal.scoreBreakdown.volume}/15 | Market=${signal.scoreBreakdown.marketContext}/15 | Patterns=${signal.scoreBreakdown.patterns}/15

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

    // Parse JSON response
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const review = JSON.parse(cleaned) as GPTReview

    return {
      verdict: review.verdict === 'CONFIRM' ? 'CONFIRM' : 'REJECT',
      confidence: Math.max(1, Math.min(10, review.confidence || 5)),
      adjustedEntry: review.adjustedEntry ?? null,
      adjustedSL: review.adjustedSL ?? null,
      adjustedTP1: review.adjustedTP1 ?? null,
      reasoning: review.reasoning || '',
      risks: review.risks || [],
      keyLevels: review.keyLevels || [],
    }
  } catch (err) {
    console.error('[GPT Filter] Error:', err)
    // On GPT failure, pass through with neutral review
    return {
      verdict: 'CONFIRM',
      confidence: 5,
      adjustedEntry: null,
      adjustedSL: null,
      adjustedTP1: null,
      reasoning: 'GPT фильтр недоступен — сигнал пропущен без проверки',
      risks: ['AI проверка не выполнена'],
      keyLevels: [],
    }
  }
}
