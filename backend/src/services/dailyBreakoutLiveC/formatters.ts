export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

export function fmtPnl(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

/**
 * Build deterministic clientOrderId for an entry limit. Same range edge → same
 * cID, so retrying the cycle within the same day won't double-place. Binance
 * caps cID at 36 chars — we keep our scheme short.
 *   cL{net[0]}_{YYYYMMDD}_{SYMBOL_no_USDT}_{B|S}
 * Examples: cLt_20260518_BTC_B, cLp_20260518_DOGE_S
 */
export function buildEntryCid(net: 'testnet' | 'prod', rangeDate: string, symbol: string, side: 'BUY' | 'SELL'): string {
  const compactDate = rangeDate.replace(/-/g, '')
  const ticker = symbol.replace(/USDT$/, '')
  return `cL${net[0]}_${compactDate}_${ticker}_${side[0]}`
}
