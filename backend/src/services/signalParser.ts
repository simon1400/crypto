export interface ParsedSignal {
  type: 'LONG' | 'SHORT'
  coin: string
  leverage: number
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: number[]
}

/**
 * Parse a trading signal message.
 *
 * Evening Trader / Near512 Futures:
 *   "Risk Scalp Long $BEAT (Max 3x)"
 *   "Scalp Short $MIRA (Leverage 10x)"
 *
 * Near512 Spot:
 *   "SPOT $CLANKER"
 */
export function parseSignalMessage(text: string): ParsedSignal | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  return parseEveningTrader(clean)
}

function parseEveningTrader(text: string): ParsedSignal | null {
  // Extract coin ticker: $TICKER
  const coinMatch = text.match(/\$([A-Z0-9]+)/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()

  // Spot signals: "SPOT $TICKER" — always LONG, leverage 1
  const isSpot = /\bSPOT\b/i.test(text)

  // Extract type (Long/Short) or default to LONG for spot
  let type: 'LONG' | 'SHORT'
  if (isSpot) {
    type = 'LONG'
  } else {
    const typeMatch = text.match(/\b(Long|Short)\b/i)
    if (!typeMatch) return null
    type = typeMatch[1].toUpperCase() as 'LONG' | 'SHORT'
  }

  // Extract leverage: (Max 3x) or (Leverage 10x), default 1 for spot
  const leverageMatch = text.match(/(?:Max|Leverage)\s+(\d+)x/i)
  const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 1

  // Extract Entry: single value or range
  const entryMatch = text.match(/Entry:\s*([\d.]+)\s*-\s*([\d.]+)/i)
    || text.match(/Entry:\s*([\d.]+)/i)
  if (!entryMatch) return null
  const entryMin = parseFloat(entryMatch[1])
  const entryMax = entryMatch[2] ? parseFloat(entryMatch[2]) : entryMin

  // Extract Stop Loss
  const slMatch = text.match(/SL:\s*([\d.]+)/i)
  if (!slMatch) return null
  const stopLoss = parseFloat(slMatch[1])

  // Extract Take Profits — dash-separated list
  const tpMatch = text.match(/TP:\s*([\d.\s\-]+)/i)
  if (!tpMatch) return null
  const takeProfits = tpMatch[1]
    .split(/\s*-\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseFloat)
    .filter(n => !isNaN(n))

  if (takeProfits.length === 0) return null

  return { type, coin, leverage, entryMin, entryMax, stopLoss, takeProfits }
}
