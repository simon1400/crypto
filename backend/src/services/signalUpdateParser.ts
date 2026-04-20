/**
 * Parser for ETG status update messages (replies to original signal).
 *
 * Examples:
 *   "#ALPINE/USDT Closed at trailing stoploss after reaching take profit
 *    Profit: 38.1168%"
 *
 *   "#KITE/USDT Stop Target Hit
 *    Loss: 40.9725%"
 *
 *   "#LISTA/USDT Manually Cancelled
 *    Profit: 0.0%
 *    Period: 1 day 3 hr"
 *
 *   "#ALPINE/USDT Take-Profit target 2 ✅
 *    Profit: 58.6412%
 *    Period: 2 days 8 hr"
 *
 *   "#H/USDT Manually Cancelled
 *    Profit: 73.9807%
 *    Period: 20 hr 38 min"
 */

export type AuthorStatus =
  | 'ACTIVE'         // limit order filled (entry target hit) — transitions ENTRY_WAIT → ACTIVE
  | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'TP4_HIT' | 'TP5_HIT'
  | 'SL_HIT'
  | 'TRAILING_WIN'   // "Closed at trailing stoploss after reaching take profit"
  | 'MANUAL_WIN'     // "Manually Cancelled" with positive profit
  | 'MANUAL_LOSS'    // "Manually Cancelled" with negative profit
  | 'CANCELLED'      // "Manually Cancelled" with 0% (no meaningful move)

export interface ParsedUpdate {
  coin: string
  status: AuthorStatus
  pnlPct: number     // signed — negative for losses; 0 for entry-fill events
  period?: string
  averageEntry?: number  // "Average Entry Price: 1.579" — set on entry-fill events
  allEntriesAchieved?: boolean  // true on "All entries achieved" (final fill of all limit legs)
}

export function parseSignalUpdate(text: string): ParsedUpdate | null {
  const clean = text.replace(/\s+/g, ' ').trim()

  // Must reference a coin with USDT pair
  const coinMatch = clean.match(/#([A-Z0-9]+)\s*\/\s*USDT/i)
  if (!coinMatch) return null
  const coin = coinMatch[1].toUpperCase()

  // Extract P&L number (signed: Profit: positive, Loss: always positive but becomes negative pnl)
  const profitMatch = clean.match(/Profit:\s*(-?[\d.]+)\s*%/i)
  const lossMatch = clean.match(/Loss:\s*(-?[\d.]+)\s*%/i)

  let pnlPct: number | null = null
  let isLoss = false
  if (profitMatch) {
    pnlPct = parseFloat(profitMatch[1])
  } else if (lossMatch) {
    pnlPct = -Math.abs(parseFloat(lossMatch[1]))
    isLoss = true
  }

  // Determine status
  let status: AuthorStatus | null = null

  // Entry fill (limit order triggered). ETG variants:
  //   "#ZRO/USDT Entry 1 ✅"                      — partial (first leg filled)
  //   "#ORDI/USDT All entries achieved"           — all legs filled (final avg entry)
  //   plus generic fallbacks from other channels
  const allEntriesAchieved = /All entries achieved/i.test(clean)
  const isEntryFill =
    allEntriesAchieved ||
    /#[A-Z0-9]+\s*\/\s*USDT\s+Entry\s*\d+\b/i.test(clean) ||
    /Entry target(?:\s*\d+)?\s*hit/i.test(clean) ||
    /Entry\s+filled/i.test(clean) ||
    /^#[A-Z0-9]+\s*\/\s*USDT\s+(Entered|Opened|Activated|Entry\s+Hit)/i.test(clean)

  if (isEntryFill && pnlPct == null) {
    status = 'ACTIVE'
  } else if (/Stop Target Hit/i.test(clean) || (isLoss && /stop/i.test(clean))) {
    status = 'SL_HIT'
  } else if (/Closed at trailing stoploss/i.test(clean)) {
    status = 'TRAILING_WIN'
  } else {
    const tpMatch = clean.match(/Take-?Profit target\s*(\d+)/i)
    if (tpMatch) {
      const n = parseInt(tpMatch[1])
      if (n >= 1 && n <= 5) status = `TP${n}_HIT` as AuthorStatus
    }
  }

  if (!status && /Manually Cancelled/i.test(clean)) {
    if (pnlPct == null || Math.abs(pnlPct) < 0.01) {
      status = 'CANCELLED'
    } else if (pnlPct > 0) {
      status = 'MANUAL_WIN'
    } else {
      status = 'MANUAL_LOSS'
    }
  }

  if (!status) return null
  // P&L optional for entry-fill / cancelled events; required for close events
  if (pnlPct == null && status !== 'CANCELLED' && status !== 'ACTIVE') return null

  const periodMatch = clean.match(/Period:\s*([\w\s]+?)(?:$|⏰|🕰)/i)
  const period = periodMatch ? periodMatch[1].trim() : undefined

  const avgEntryMatch = clean.match(/Average Entry Price:\s*([\d,.]+)/i)
  const averageEntry = avgEntryMatch ? parseFloat(avgEntryMatch[1].replace(/,/g, '')) : undefined

  return {
    coin,
    status,
    pnlPct: pnlPct ?? 0,
    period,
    averageEntry,
    allEntriesAchieved: allEntriesAchieved || undefined,
  }
}

/**
 * Is this status a "final" outcome? (hides the tracker-computed status)
 */
export function isFinalAuthorStatus(s: string | null | undefined): boolean {
  if (!s) return false
  return s !== 'CANCELLED' || true // all author statuses are final — cancelled is also final
}
