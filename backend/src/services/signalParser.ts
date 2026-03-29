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
 * Parse a trading signal message from Evening Trader / Near512 format.
 *
 * Examples:
 *   "Risk Scalp Long $BEAT (Max 3x)"
 *   "Scalp Short $MIRA (Leverage 10x)"
 *   "Scalp Long $ALGO (Leverage 12x)"
 *   "Risk Scalp Short $APR (Max 5x)"
 */
export function parseSignalMessage(text: string): ParsedSignal | null {
  // Normalize whitespace
  const clean = text.replace(/\s+/g, ' ').trim()

  // Extract type (Long/Short)
  const typeMatch = clean.match(/\b(Long|Short)\b/i)
  if (!typeMatch) return null
  const type = typeMatch[1].toUpperCase() as 'LONG' | 'SHORT'

  // Extract coin ticker: $TICKER
  const coinMatch = clean.match(/\$([A-Z0-9]+)/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()

  // Extract leverage: (Max 3x) or (Leverage 10x)
  const leverageMatch = clean.match(/(?:Max|Leverage)\s+(\d+)x/i)
  const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 1

  // Extract Entry: single value or range
  const entryMatch = clean.match(/Entry:\s*([\d.]+)\s*-\s*([\d.]+)/i)
    || clean.match(/Entry:\s*([\d.]+)/i)
  if (!entryMatch) return null
  const entryMin = parseFloat(entryMatch[1])
  const entryMax = entryMatch[2] ? parseFloat(entryMatch[2]) : entryMin

  // Extract Stop Loss
  const slMatch = clean.match(/SL:\s*([\d.]+)/i)
  if (!slMatch) return null
  const stopLoss = parseFloat(slMatch[1])

  // Extract Take Profits — dash-separated list
  const tpMatch = clean.match(/TP:\s*([\d.\s\-]+)/i)
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
