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
 * Parse a trading signal message. Supports multiple formats:
 *
 * Evening Trader / Near512:
 *   "Risk Scalp Long $BEAT (Max 3x)"
 *   "Scalp Short $MIRA (Leverage 10x)"
 *
 * Bitcoin Bullets:
 *   "COIN: #ADA/USDT (3-5x)"
 *   "Direction: SHORT | Type: Swing"
 *   "ENTRY: 0.2433 - 0.2439"
 *   "TARGETS: 0.2409 - 0.2389 - 0.2359"
 *   "STOP LOSS: 0.2476"
 */
export function parseSignalMessage(text: string): ParsedSignal | null {
  // Normalize whitespace
  const clean = text.replace(/\s+/g, ' ').trim()

  // Try Bitcoin Bullets format first (more structured)
  const bbResult = parseBitcoinBullets(clean)
  if (bbResult) return bbResult

  // Try Evening Trader format
  return parseEveningTrader(clean)
}

function parseBitcoinBullets(text: string): ParsedSignal | null {
  // Must have "SIGNAL ID" or "Direction:" to identify as BB format
  if (!/SIGNAL ID|Direction:/i.test(text)) return null

  // Extract coin: "COIN: #ADA/USDT (3-5x)" or "COIN: #INJ/USDT (3-5x)"
  const coinMatch = text.match(/COIN:\s*#?([A-Z0-9]+)\/USDT\s*\((\d+)-?(\d+)?x\)/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()
  // Take max leverage from range (e.g. "3-5x" → 5)
  const leverage = coinMatch[3] ? parseInt(coinMatch[3]) : parseInt(coinMatch[2])

  // Extract direction
  const dirMatch = text.match(/Direction:\s*(LONG|SHORT)/i)
  if (!dirMatch) return null
  const type = dirMatch[1].toUpperCase() as 'LONG' | 'SHORT'

  // Extract entry
  const entryMatch = text.match(/ENTRY:\s*([\d.]+)\s*-\s*([\d.]+)/i)
    || text.match(/ENTRY:\s*([\d.]+)/i)
  if (!entryMatch) return null
  const entryMin = parseFloat(entryMatch[1])
  const entryMax = entryMatch[2] ? parseFloat(entryMatch[2]) : entryMin

  // Extract targets
  const tpMatch = text.match(/TARGETS?:\s*([\d.\s\-]+)/i)
  if (!tpMatch) return null
  const takeProfits = tpMatch[1]
    .split(/\s*-\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseFloat)
    .filter(n => !isNaN(n))

  if (takeProfits.length === 0) return null

  // Extract stop loss
  const slMatch = text.match(/STOP\s*LOSS:\s*([\d.]+)/i)
  if (!slMatch) return null
  const stopLoss = parseFloat(slMatch[1])

  return { type, coin, leverage, entryMin, entryMax, stopLoss, takeProfits }
}

function parseEveningTrader(text: string): ParsedSignal | null {
  // Extract type (Long/Short)
  const typeMatch = text.match(/\b(Long|Short)\b/i)
  if (!typeMatch) return null
  const type = typeMatch[1].toUpperCase() as 'LONG' | 'SHORT'

  // Extract coin ticker: $TICKER
  const coinMatch = text.match(/\$([A-Z0-9]+)/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()

  // Extract leverage: (Max 3x) or (Leverage 10x)
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
