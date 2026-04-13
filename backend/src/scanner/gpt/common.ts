import OpenAI from 'openai'
import { safeParse } from '../../utils/safeParse'
import { CoinIndicators } from '../../services/indicators'
import { FundingData } from '../../services/fundingRate'
import { OIData } from '../../services/openInterest'
import { NewsSentiment } from '../../services/news'
import { LiquidationStats } from '../../services/liquidations'
import { LSRData } from '../../services/longShortRatio'

/**
 * Общий слой для всех GPT-аннотаторов в scanner/.
 * Содержит:
 * - SetupQuality type
 * - OpenAI singleton
 * - callGptJson() — универсальный вызов с парсингом JSON
 * - formatMarketContext() — единый блок funding/OI/liquidations/lsr/news для промпта
 * - formatIndicators1h / formatIndicators4h
 */

export type SetupQuality = 'A' | 'B' | 'C' | 'D' | 'F'
export const VALID_QUALITIES: SetupQuality[] = ['A', 'B', 'C', 'D', 'F']

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

/**
 * Универсальный вызов GPT с ожиданием JSON-ответа.
 * Снимает markdown code-fence если GPT завернул ответ в ```json.
 * На ошибку / пустой ответ — кидает exception (caller должен вернуть fallback).
 */
export async function callGptJson(
  system: string,
  prompt: string,
  maxTokens = 800,
  model = 'gpt-5.4',
): Promise<any> {
  const completion = await getOpenAI().chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  })

  const text = completion.choices[0]?.message?.content?.trim()
  if (!text) throw new Error('Empty GPT response')

  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = safeParse<any>(cleaned, null, 'GPT')
  if (parsed === null) throw new Error('Failed to parse GPT JSON response')
  return parsed
}

/**
 * Единый блок market context для GPT промптов (funding/OI/liquidations/LSR/news).
 * Пустые линии опускаются — возвращает только присутствующие данные.
 */
export interface MarketContextData {
  funding?: FundingData | null
  oi?: OIData | null
  liquidations?: LiquidationStats | null
  lsr?: LSRData | null
  news?: NewsSentiment | null
  includeNewsHeadlines?: boolean // true в gptFilter, false в gptEntryFilter
}

export function formatMarketContext(ctx: MarketContextData): string {
  const lines: string[] = []

  if (ctx.funding) {
    const ratePct = (ctx.funding.fundingRate * 100).toFixed(4)
    const heat =
      ctx.funding.fundingRate > 0.0005 ? ' ⚠️ перегрев лонгов' :
      ctx.funding.fundingRate < -0.0005 ? ' ⚠️ перегрев шортов' : ''
    lines.push(`Funding Rate (8h): ${ratePct}%${heat}`)
  }

  if (ctx.oi) {
    const d1h = `${ctx.oi.oiChangePct1h > 0 ? '+' : ''}${ctx.oi.oiChangePct1h}%`
    const d4h = `${ctx.oi.oiChangePct4h > 0 ? '+' : ''}${ctx.oi.oiChangePct4h}%`
    lines.push(`Open Interest: $${ctx.oi.openInterestUsd.toLocaleString()} | OI Δ1h: ${d1h} | OI Δ4h: ${d4h}`)
  }

  if (ctx.liquidations && ctx.liquidations.totalUsd > 0) {
    const l = ctx.liquidations
    const k = (n: number) => (n / 1000).toFixed(0)
    const largest = l.largestUsd > 100_000 ? ` · крупнейшая $${k(l.largestUsd)}k` : ''
    lines.push(`Ликвидации (${l.windowMinutes}m): $${k(l.totalUsd)}k всего · лонгов $${k(l.longsLiqUsd)}k · шортов $${k(l.shortsLiqUsd)}k${largest}`)
  }

  if (ctx.lsr) {
    const longPct = (ctx.lsr.buyRatio * 100).toFixed(0)
    const shortPct = (ctx.lsr.sellRatio * 100).toFixed(0)
    const crowd =
      ctx.lsr.buyRatio > 0.7 ? ' ⚠️ толпа в лонгах' :
      ctx.lsr.buyRatio < 0.3 ? ' ⚠️ толпа в шортах' : ''
    lines.push(`Long/Short ratio: ${longPct}% / ${shortPct}%${crowd}`)
  }

  if (ctx.news && ctx.news.total > 0) {
    const sign = ctx.news.score > 0 ? '+' : ''
    const base = `Новости: ${sign}${ctx.news.score} (${ctx.news.positive}⬆ ${ctx.news.negative}⬇)`
    if (ctx.includeNewsHeadlines) {
      lines.push(`${base}\nЗаголовки: ${ctx.news.headlines.slice(0, 3).join('; ')}`)
    } else {
      lines.push(base)
    }
  }

  return lines.join('\n')
}

/** Форматирует 1h индикаторы для промпта — единый формат во всех GPT. */
export function formatIndicators1h(tf1h: CoinIndicators, includeFullDetails = true): string {
  const lines = [
    `Price: $${tf1h.price} | EMA9: $${tf1h.ema9} | EMA20: $${tf1h.ema20} | EMA50: $${tf1h.ema50}`,
    `RSI: ${tf1h.rsi} | MACD: ${tf1h.macd} (hist: ${tf1h.macdHistogram})`,
    `BB: $${tf1h.bbLower} — $${tf1h.bbMiddle} — $${tf1h.bbUpper} (width: ${tf1h.bbWidth}%)`,
  ]
  if (includeFullDetails) {
    lines.push(`Stoch: %K=${tf1h.stochK} %D=${tf1h.stochD} | ADX: ${tf1h.adx}`)
  }
  lines.push(`Support: $${tf1h.support} | Resistance: $${tf1h.resistance}`)
  lines.push(`ATR: $${tf1h.atr} | VWAP: $${tf1h.vwap} | Volume: ${tf1h.volRatio}x`)
  if (includeFullDetails) {
    lines.push(`Patterns: ${tf1h.patterns?.join(', ') || 'нет'}`)
  }
  return lines.join('\n')
}

/** Форматирует 4h индикаторы для промпта — единый формат. */
export function formatIndicators4h(tf4h: CoinIndicators): string {
  return [
    `Trend: ${tf4h.trend} | RSI: ${tf4h.rsi} | ADX: ${tf4h.adx}`,
    `EMA20: $${tf4h.ema20} | EMA50: $${tf4h.ema50}`,
    `MACD: ${tf4h.macd} (hist: ${tf4h.macdHistogram})`,
    `Support: $${tf4h.support} | Resistance: $${tf4h.resistance}`,
  ].join('\n')
}
