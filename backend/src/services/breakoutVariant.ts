/**
 * Breakout paper-trader variant routing.
 *
 * The Daily Breakout strategy runs two parallel paper-trader copies (A and B)
 * against the same BreakoutSignal stream but with independent deposits, sizing,
 * and trade tables. This module provides a thin routing layer so the paper-trader
 * code stays single-source and parameterised by `variant`.
 *
 *  A → BreakoutPaperConfig + BreakoutPaperTrade   (legacy prod, 10 conc, 10% margin)
 *  B → BreakoutPaperConfigB + BreakoutPaperTradeB (alt config, 20 conc, 5% margin)
 */

import { prisma } from '../db/prisma'

export type BreakoutVariant = 'A' | 'B'

/** Returns the Prisma model (delegate) for the variant's PaperConfig table. */
export function configModel(variant: BreakoutVariant) {
  return variant === 'B' ? prisma.breakoutPaperConfigB : prisma.breakoutPaperConfig
}

/** Returns the Prisma model (delegate) for the variant's PaperTrade table. */
export function tradeModel(variant: BreakoutVariant) {
  return variant === 'B' ? prisma.breakoutPaperTradeB : prisma.breakoutPaperTrade
}

/** Telegram message prefix for the variant. A is silent (legacy behavior); B prefixes [B]. */
export function tgPrefix(variant: BreakoutVariant): string {
  return variant === 'B' ? '[B] ' : ''
}

/** Log tag used in console output for the variant. */
export function logTag(variant: BreakoutVariant): string {
  return variant === 'B' ? '[BreakoutPaperB]' : '[BreakoutPaper]'
}
