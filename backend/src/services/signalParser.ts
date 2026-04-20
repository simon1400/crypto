export interface ParsedSignal {
  type: 'LONG' | 'SHORT'
  coin: string
  leverage: number
  entryMin: number
  entryMax: number
  stopLoss: number
  takeProfits: number[]
  category?: string
}

/**
 * Parse a trading signal message from supported channels.
 *
 * Supported formats:
 *   "Risk Scalp Long $BEAT (Max 3x)"                      (EveningTrader compact)
 *   "Scalp Short $MIRA (Leverage 10x)"                    (EveningTrader compact, shared with ETG)
 *   "Limit Scalp Long $1000PEPE - $PEPE (Leverage 7x)"    (ETG — pick last ticker)
 *   "#ETH / USDT – LONG" + "Targets: TP1: ..."            (ETG full format)
 *   "SPOT $CLANKER"                                       (EveningTrader spot)
 *
 * Reply-style status updates (Closed at, Stop Target Hit, Take-Profit target,
 * Manually Cancelled) are rejected — those are tracked by signalTracker from
 * candle data, not re-ingested as new signals.
 */
export function parseSignalMessage(text: string): ParsedSignal | null {
  const clean = text.replace(/\s+/g, ' ').trim()

  if (isStatusUpdate(clean)) return null

  const etgFull = parseETGFullFormat(clean)
  if (etgFull) return etgFull

  return parseCompactScalp(clean)
}

function isStatusUpdate(text: string): boolean {
  return /Closed at|Stop Target Hit|Take-?Profit target|Manually Cancelled|Trailing Stop|Profit:\s*-?[\d.]+%|Loss:\s*-?[\d.]+%/i.test(text)
}

/**
 * Compact one-line format shared by EveningTrader and ETG x CSF Copytrading:
 *   "Scalp Long $MMT (Leverage 7x)
 *    Entry: 0.1261 - 0.1326
 *    TP: 0.1382 - 0.1459 - 0.1546 - 0.1642
 *    SL: 0.1225"
 */
function parseCompactScalp(text: string): ParsedSignal | null {
  // Coin: pick last $TICKER (handles "$1000PEPE - $PEPE" → PEPE)
  const coinMatches = [...text.matchAll(/\$([A-Z0-9]+)/gi)]
  if (coinMatches.length === 0) return null
  const coin = coinMatches[coinMatches.length - 1][1].toUpperCase()

  // Spot signals: "SPOT $TICKER" — always LONG, leverage 1
  const isSpot = /\bSPOT\b/i.test(text)

  let type: 'LONG' | 'SHORT'
  if (isSpot) {
    type = 'LONG'
  } else {
    const typeMatch = text.match(/\b(Long|Short)\b/i)
    if (!typeMatch) return null
    type = typeMatch[1].toUpperCase() as 'LONG' | 'SHORT'
  }

  const leverageMatch = text.match(/(?:Max|Leverage)\s+(\d+)x/i)
  const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 1

  const entryMatch = text.match(/Entry:\s*([\d.]+)\s*-\s*([\d.]+)/i)
    || text.match(/Entry:\s*([\d.]+)/i)
  if (!entryMatch) return null
  const entryMin = parseFloat(entryMatch[1])
  const entryMax = entryMatch[2] ? parseFloat(entryMatch[2]) : entryMin

  const slMatch = text.match(/SL:\s*([\d.]+)/i)
  if (!slMatch) return null
  const stopLoss = parseFloat(slMatch[1])

  const tpMatch = text.match(/TP:\s*([\d.\s\-]+)/i)
  if (!tpMatch) return null
  const takeProfits = tpMatch[1]
    .split(/\s*-\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseFloat)
    .filter(n => !isNaN(n))

  if (takeProfits.length === 0) return null

  return {
    type, coin, leverage, entryMin, entryMax, stopLoss, takeProfits,
    category: extractCategory(text) ?? undefined,
  }
}

/**
 * ETG full format with numbered TPs:
 *   "#ETH / USDT – LONG
 *    20x Leverage
 *    Entry: 2,325.82 – 2,363.06
 *    Targets: TP1: 2,401.83  TP2: 2,466.56 ...
 *    Stop Loss: 2,287.30"
 *
 * Numbers may use commas as thousand separators and en/em dashes as range separators.
 */
function parseETGFullFormat(text: string): ParsedSignal | null {
  // Require explicit full-format markers so we don't steal compact-format parses
  if (!/Stop Loss:/i.test(text)) return null
  if (!/\bTP\s*1\s*:/i.test(text)) return null

  const coinMatch = text.match(/#([A-Z0-9]+)\s*\/\s*USDT/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()

  const typeMatch = text.match(/\b(LONG|SHORT)\b/i)
  if (!typeMatch) return null
  const type = typeMatch[1].toUpperCase() as 'LONG' | 'SHORT'

  const leverageMatch = text.match(/(\d+)x\s+Leverage/i)
  const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 1

  // Entry with comma-thousand separators and en/em/hyphen dash
  const entryMatch = text.match(/Entry:\s*([\d,.]+)\s*[–—-]\s*([\d,.]+)/i)
    || text.match(/Entry:\s*([\d,.]+)/i)
  if (!entryMatch) return null
  const entryMin = parseNumber(entryMatch[1])
  const entryMax = entryMatch[2] ? parseNumber(entryMatch[2]) : entryMin

  const slMatch = text.match(/Stop Loss:\s*([\d,.]+)/i)
  if (!slMatch) return null
  const stopLoss = parseNumber(slMatch[1])

  // Numbered TPs: TP1: X TP2: Y ... (whitespace-collapsed earlier)
  const tpRegex = /TP\s*\d+\s*:\s*([\d,.]+)/gi
  const takeProfits: number[] = []
  for (const m of text.matchAll(tpRegex)) {
    const n = parseNumber(m[1])
    if (!isNaN(n)) takeProfits.push(n)
  }

  if (takeProfits.length === 0) return null

  return {
    type, coin, leverage, entryMin, entryMax, stopLoss, takeProfits,
    category: extractCategory(text) ?? undefined,
  }
}

function parseNumber(s: string): number {
  return parseFloat(s.replace(/,/g, ''))
}

export function extractCategory(text: string): string | null {
  // Order matters: longer variants first
  const match = text.match(/\b(Risk\s+Limit\s+Scalp|Limit\s+Risk\s+Scalp|Limit\s+Scalp|Risk\s+Scalp|Scalp|Swing)\b/i)
  if (!match) return null
  return match[1].toLowerCase().replace(/\s+/g, '-')
}
