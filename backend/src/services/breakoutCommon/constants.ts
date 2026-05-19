/**
 * Daily Breakout constants shared across all trader variants
 * (paper A/B/C and Live C).
 *
 * These reflect the strategy's invariants: same splits, same status taxonomy
 * across the variants. If a variant ever needs different values it should
 * declare its own locally — but right now they all match, so duplicating
 * them in 4 places only creates drift risk.
 */

/** Statuses where the trade is still in the market (may have partial fills). */
export const ACTIVE_STATUSES = ['OPEN', 'TP1_HIT', 'TP2_HIT'] as const

/** Terminal statuses — trade fully done, accounting closed. */
export const CLOSED_STATUSES = new Set(['CLOSED', 'SL_HIT', 'EXPIRED'])

/** TP ladder fractions: 50% on TP1, 30% on TP2, 20% on TP3. */
export const SPLITS = [0.5, 0.3, 0.2]
