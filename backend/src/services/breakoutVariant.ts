/**
 * Breakout variant routing.
 *
 * The Daily Breakout strategy runs three parallel paper-trader copies against
 * the same BreakoutSignal stream + a real-money live twin of C, all driven
 * from one parameterised codebase via the variant tag.
 *
 *  A    → BreakoutPaperConfig  + BreakoutPaperTrade   (paper, 10 conc, 10% margin, taker market entry)
 *  B    → BreakoutPaperConfigB + BreakoutPaperTradeB  (paper, 20 conc, 5% margin,  taker market entry)
 *  C    → BreakoutPaperConfigC + BreakoutPaperTradeC  (paper, 20 conc, 5% margin,  LIMIT on rangeEdge)
 *  LIVE → BreakoutLiveConfigC  + BreakoutLiveTradeC   (REAL Binance Futures, same mechanics as C)
 *
 * Tables for LIVE have extra exchange fields (binance{Client,}OrderId,
 * killSwitch*, useTestnet) that paper doesn't — but the core columns the
 * shared router uses (status/closes/realizedR/etc.) match.
 */

import { prisma } from '../db/prisma'

export type BreakoutVariant = 'A' | 'B' | 'C' | 'LIVE'

/** Returns the Prisma model (delegate) for the variant's config table. */
export function configModel(variant: BreakoutVariant) {
  if (variant === 'LIVE') return prisma.breakoutLiveConfigC
  if (variant === 'C') return prisma.breakoutPaperConfigC
  if (variant === 'B') return prisma.breakoutPaperConfigB
  return prisma.breakoutPaperConfig
}

/** Returns the Prisma model (delegate) for the variant's trade table. */
export function tradeModel(variant: BreakoutVariant) {
  if (variant === 'LIVE') return prisma.breakoutLiveTradeC
  if (variant === 'C') return prisma.breakoutPaperTradeC
  if (variant === 'B') return prisma.breakoutPaperTradeB
  return prisma.breakoutPaperTrade
}

/** Telegram message prefix. A is silent (legacy); B/C/LIVE prefixed. */
export function tgPrefix(variant: BreakoutVariant): string {
  if (variant === 'LIVE') return '[LIVE C] '
  if (variant === 'C') return '[C] '
  if (variant === 'B') return '[B] '
  return ''
}

/** Log tag used in console output for the variant. */
export function logTag(variant: BreakoutVariant): string {
  if (variant === 'LIVE') return '[BreakoutLiveC]'
  if (variant === 'C') return '[BreakoutPaperC]'
  if (variant === 'B') return '[BreakoutPaperB]'
  return '[BreakoutPaper]'
}

/**
 * True if the variant uses limit-on-rangeEdge entry mechanics. C and LIVE
 * both use limits; A/B use taker market entry on c.close.
 */
export function isLimitVariant(variant: BreakoutVariant): boolean {
  return variant === 'C' || variant === 'LIVE'
}

/** True for the real-money variant — UI / logging should mark warnings. */
export function isLiveVariant(variant: BreakoutVariant): boolean {
  return variant === 'LIVE'
}
