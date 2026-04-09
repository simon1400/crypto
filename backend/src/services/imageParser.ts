import OpenAI from 'openai'

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

export interface ImageSignal {
  type: 'LONG' | 'SHORT'
  coin: string
  leverage: number
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: number[]
}

const SYSTEM = `Ты парсер торговых сигналов из картинок.
Извлеки данные сигнала из изображения и верни СТРОГО JSON (без markdown):

{
  "coin": "TICKER",
  "type": "LONG" | "SHORT",
  "leverage": number,
  "entryMin": number,
  "entryMax": number,
  "stopLoss": number,
  "takeProfits": [number, number, ...]
}

Правила:
- coin: тикер без $ и /USDT (например "ARB", "BTC")
- leverage: если указан диапазон вроде "2-5x", бери МИНИМАЛЬНОЕ значение
- entryMin/entryMax: если одно значение, оба одинаковые
- takeProfits: массив всех целей по порядку
- ВСЕ ЧИСЛА КОПИРУЙ ТОЧНО как на картинке, НЕ округляй! Например 1.3750 должен быть 1.3750, а не 1.38
- Если не можешь извлечь данные — верни {"error": "причина"}`

/**
 * Parse a trading signal from an image using GPT-4o vision.
 * Returns parsed signal or null if parsing fails.
 */
export async function parseSignalImage(imageBuffer: Buffer): Promise<ImageSignal | null> {
  const base64 = imageBuffer.toString('base64')
  const dataUrl = `data:image/jpeg;base64,${base64}`

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Извлеки торговый сигнал из этой картинки:' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
    })

    const text = completion.choices[0]?.message?.content?.trim()
    if (!text) {
      console.error('[ImageParser] Empty GPT response')
      return null
    }

    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const data = JSON.parse(cleaned)

    if (data.error) {
      console.warn('[ImageParser] GPT could not parse image:', data.error)
      return null
    }

    // Validate required fields
    if (!data.coin || !data.type || !data.stopLoss || !data.takeProfits?.length) {
      console.warn('[ImageParser] Missing required fields:', data)
      return null
    }

    const type = data.type.toUpperCase()
    if (type !== 'LONG' && type !== 'SHORT') {
      console.warn('[ImageParser] Invalid type:', data.type)
      return null
    }

    return {
      coin: data.coin.toUpperCase(),
      type,
      leverage: data.leverage || 1,
      entryMin: data.entryMin,
      entryMax: data.entryMax ?? data.entryMin,
      stopLoss: data.stopLoss,
      takeProfits: data.takeProfits.filter((n: any) => typeof n === 'number' && !isNaN(n)),
    }
  } catch (err: any) {
    console.error('[ImageParser] Error:', err.message)
    return null
  }
}

/**
 * Check if a message text matches BinanceKillers signal pattern.
 * Pattern: ✅✅TICKER✅✅ or ✔️✔️TICKER✔️✔️
 * Returns the ticker if matched, null otherwise.
 */
export function isBinanceKillersSignal(text: string): string | null {
  // Match various check mark emojis around a ticker
  // ✅✅ARB✅✅ or ✔️✔️ARB✔️✔️ or mixed
  const match = text.match(/[✅✔️]{2,}\s*([A-Z0-9]+)\s*[✅✔️]{2,}/i)
  return match ? match[1].toUpperCase() : null
}
