// Minimal instrument catalog for backend P&L calculations.
// Frontend has a full 40+ list in Mt5PositionCalc.tsx — this covers only the 10
// instruments the scanner tracks, plus a couple of common extras in case the user
// records manual trades on other pairs.
//
// pipSize = price increment that equals "1 pip" (for display)
// contractSize = units per 1 standard lot
// quoteKind = USD relation, determines how USD P&L is computed from price move

export type QuoteKind = 'usd_quote' | 'usd_base' | 'jpy_quote' | 'other'

export interface InstrumentSpec {
  symbol: string
  pipSize: number
  contractSize: number
  quoteKind: QuoteKind
  decimals: number
}

export const INSTRUMENTS: Record<string, InstrumentSpec> = {
  // Majors (USD quoted)
  EURUSD: { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_quote', decimals: 5 },
  GBPUSD: { symbol: 'GBPUSD', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_quote', decimals: 5 },
  AUDUSD: { symbol: 'AUDUSD', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_quote', decimals: 5 },
  NZDUSD: { symbol: 'NZDUSD', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_quote', decimals: 5 },

  // USD base
  USDJPY: { symbol: 'USDJPY', pipSize: 0.01, contractSize: 100000, quoteKind: 'usd_base', decimals: 3 },
  USDCHF: { symbol: 'USDCHF', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_base', decimals: 5 },
  USDCAD: { symbol: 'USDCAD', pipSize: 0.0001, contractSize: 100000, quoteKind: 'usd_base', decimals: 5 },

  // JPY crosses
  GBPJPY: { symbol: 'GBPJPY', pipSize: 0.01, contractSize: 100000, quoteKind: 'jpy_quote', decimals: 3 },
  EURJPY: { symbol: 'EURJPY', pipSize: 0.01, contractSize: 100000, quoteKind: 'jpy_quote', decimals: 3 },

  // Metals
  XAUUSD: { symbol: 'XAUUSD', pipSize: 0.01, contractSize: 100, quoteKind: 'usd_quote', decimals: 2 },
  XAGUSD: { symbol: 'XAGUSD', pipSize: 0.001, contractSize: 5000, quoteKind: 'usd_quote', decimals: 3 },

  // Indices (1 contract = 1 index point)
  US30: { symbol: 'US30', pipSize: 1, contractSize: 1, quoteKind: 'usd_quote', decimals: 2 },
  NAS100: { symbol: 'NAS100', pipSize: 1, contractSize: 1, quoteKind: 'usd_quote', decimals: 2 },
  SPX500: { symbol: 'SPX500', pipSize: 0.1, contractSize: 1, quoteKind: 'usd_quote', decimals: 2 },
  GER40: { symbol: 'GER40', pipSize: 0.1, contractSize: 1, quoteKind: 'usd_quote', decimals: 2 },
}

export function getInstrument(symbol: string): InstrumentSpec | null {
  return INSTRUMENTS[symbol] || null
}

// USD P&L for a given price move on a given lot size.
// For usd_quote pairs (EURUSD, XAUUSD, indices): pnl = priceMove × contractSize × lots
// For usd_base pairs (USDJPY, USDCHF): pnl = (priceMove × contractSize × lots) / exitPrice
// For jpy_quote (EURJPY, GBPJPY): approximated via exit price (USD/JPY proxy)
// For crosses ('other'): approximated
export function computeUsdPnl(
  instr: InstrumentSpec,
  type: 'LONG' | 'SHORT',
  entry: number,
  exit: number,
  lots: number,
): { pipsPnl: number; usdPnl: number } {
  const direction = type === 'LONG' ? 1 : -1
  const priceMove = (exit - entry) * direction
  const pipsPnl = priceMove / instr.pipSize
  const raw = priceMove * instr.contractSize * lots

  let usdPnl: number
  switch (instr.quoteKind) {
    case 'usd_quote':
      usdPnl = raw
      break
    case 'usd_base':
      // USD/JPY: moving JPY quote; need to divide by exit price to express in USD
      usdPnl = raw / exit
      break
    case 'jpy_quote':
      // cross like EURJPY — approximation via exit price
      usdPnl = raw / exit
      break
    case 'other':
    default:
      usdPnl = raw / exit
      break
  }

  return {
    pipsPnl: Math.round(pipsPnl * 10) / 10,
    usdPnl: Math.round(usdPnl * 100) / 100,
  }
}
