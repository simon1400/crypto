/**
 * Realistic fee/slip model:
 *   - TP fills are maker (limit at TP price, no slip)
 *   - Everything else (entry market, SL stop-market, EXPIRED manual close,
 *     MARGIN close, manual market close) is taker (paid taker fee + slip
 *     applied to fill price).
 */

import { PaperConfig } from './types'

export { SPLITS } from '../breakoutCommon/constants'

export function isMakerFill(reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'MARGIN' | 'MANUAL'): boolean {
  return reason === 'TP1' || reason === 'TP2' || reason === 'TP3'
}

/**
 * Slip-adjusted price for a TAKER fill at structural price `p`.
 * Long entry (taker buy) — slip pushes price UP.
 * Long exit (taker sell) — slip pushes price DOWN.
 * Short entry (taker sell) — DOWN. Short exit (taker buy) — UP.
 */
export function takerFillPrice(structPrice: number, side: 'BUY' | 'SELL', kind: 'entry' | 'exit', slipFrac: number): number {
  if (slipFrac <= 0) return structPrice
  if (kind === 'entry') {
    return side === 'BUY' ? structPrice * (1 + slipFrac) : structPrice * (1 - slipFrac)
  } else {
    return side === 'BUY' ? structPrice * (1 - slipFrac) : structPrice * (1 + slipFrac)
  }
}

/**
 * Picks effective rates for a trade. Per-trade override takes priority, otherwise
 * config defaults are used. Returns null if no realistic-model rates set
 * (caller should fall back to legacy flat fee model).
 */
export function getRealisticRates(trade: any, cfg: PaperConfig): { takerPct: number; makerPct: number; slipPct: number } | null {
  const takerPct = trade.feeTakerPct ?? cfg.feeTakerPct
  const makerPct = trade.feeMakerPct ?? cfg.feeMakerPct
  const slipPct = trade.slipTakerPct ?? cfg.slipTakerPct
  if (takerPct == null || makerPct == null || slipPct == null) return null
  return { takerPct, makerPct, slipPct }
}
