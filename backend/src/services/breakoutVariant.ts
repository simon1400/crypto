/**
 * Breakout paper-trader variant routing.
 *
 * The Daily Breakout strategy runs three parallel paper-trader copies against the
 * same BreakoutSignal stream but with independent deposits, sizing, trade tables,
 * and entry mechanics. This module provides a thin routing layer so the paper-trader
 * code stays single-source and parameterised by `variant`.
 *
 *  A → BreakoutPaperConfig  + BreakoutPaperTrade   (legacy prod, 10 conc, 10% margin, taker market entry)
 *  B → BreakoutPaperConfigB + BreakoutPaperTradeB  (alt config,  20 conc, 5% margin,  taker market entry)
 *  C → BreakoutPaperConfigC + BreakoutPaperTradeC  (experimental, 20 conc, 5% margin, LIMIT on rangeEdge)
 */

import { prisma } from '../db/prisma'

export type BreakoutVariant = 'A' | 'B' | 'C'

/** Returns the Prisma model (delegate) for the variant's PaperConfig table. */
export function configModel(variant: BreakoutVariant) {
  if (variant === 'C') return prisma.breakoutPaperConfigC
  if (variant === 'B') return prisma.breakoutPaperConfigB
  return prisma.breakoutPaperConfig
}

/** Returns the Prisma model (delegate) for the variant's PaperTrade table. */
export function tradeModel(variant: BreakoutVariant) {
  if (variant === 'C') return prisma.breakoutPaperTradeC
  if (variant === 'B') return prisma.breakoutPaperTradeB
  return prisma.breakoutPaperTrade
}

/** Telegram message prefix for the variant. A is silent (legacy behavior); B/C prefixed. */
export function tgPrefix(variant: BreakoutVariant): string {
  if (variant === 'C') return '[C] '
  if (variant === 'B') return '[B] '
  return ''
}

/** Log tag used in console output for the variant. */
export function logTag(variant: BreakoutVariant): string {
  if (variant === 'C') return '[BreakoutPaperC]'
  if (variant === 'B') return '[BreakoutPaperB]'
  return '[BreakoutPaper]'
}

/**
 * True if the variant uses limit-on-rangeEdge entry mechanics. C is the only one;
 * A/B use taker market entry on c.close of triggering candle.
 */
export function isLimitVariant(variant: BreakoutVariant): boolean {
  return variant === 'C'
}
