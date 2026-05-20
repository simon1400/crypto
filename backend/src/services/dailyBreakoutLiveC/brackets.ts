/**
 * Leverage-bracket cache + helper.
 *
 * Binance Futures applies per-symbol notional-tiered leverage limits. Example
 * for AVAXUSDT (testnet 2026-05-20):
 *   notional ≤ $5k     → max 50x   (bracket 1)
 *   $5k < notional ≤ $25k  → max 20x   (bracket 2)
 *   $25k < notional ≤ $100k → max 10x   (bracket 3)
 *   ...
 *
 * Sizing computeSizing() picks an "ideal" leverage from targetMarginPct. If
 * that exceeds the bracket cap for the trade's notional, Binance rejects the
 * MARKET with -2027 "Exceeded the maximum allowable position at current
 * leverage". Each rejection costs a signed POST; on a hot symbol the bot used
 * to retry every aggTrade tick (50-500/sec), saturating the rate limit and
 * triggering 418 IP bans (root cause for AVAX 2115 attempts in one day).
 *
 * Helper: getBracketMaxLeverage(symbol, notional) → max leverage Binance will
 * accept for this trade. Called by computeSizing in placement so we never
 * place an order Binance will refuse.
 */

import type { BinanceFuturesClient } from '../exchanges/binanceFutures'
import { bracketsCache, BRACKETS_TTL_MS, LeverageBracket, LOG } from './state'

export async function getLeverageBrackets(client: BinanceFuturesClient): Promise<Map<string, LeverageBracket[]>> {
  const cached = bracketsCache.current
  if (cached && Date.now() - cached.at < BRACKETS_TTL_MS) return cached.map
  const raw = await client.getLeverageBrackets()
  const map = new Map<string, LeverageBracket[]>()
  for (const row of raw) {
    map.set(row.symbol, row.brackets.map(b => ({
      bracket: Number(b.bracket),
      initialLeverage: Number(b.initialLeverage),
      notionalCap: Number(b.notionalCap),
      notionalFloor: Number(b.notionalFloor),
      maintMarginRatio: Number(b.maintMarginRatio),
      cum: Number(b.cum),
    })))
  }
  bracketsCache.current = { at: Date.now(), map }
  console.log(`${LOG} leverage brackets cached for ${map.size} symbols`)
  return map
}

/**
 * Given a symbol and a planned notional ($), return the max leverage Binance
 * will accept. Returns Infinity if the symbol isn't in the cache (caller falls
 * back to the configured symbol cap).
 */
export function bracketMaxLeverageFor(
  brackets: LeverageBracket[] | undefined,
  notional: number,
): number {
  if (!brackets || brackets.length === 0) return Infinity
  // Brackets are sorted by notionalFloor ascending. Pick the one whose range
  // contains our notional.
  for (const b of brackets) {
    if (notional > b.notionalFloor && notional <= b.notionalCap) {
      return b.initialLeverage
    }
  }
  // Notional below floor of first bracket — bracket[0] applies (notionalFloor=0).
  if (notional <= brackets[0].notionalCap) return brackets[0].initialLeverage
  // Above the highest cap — return the last bracket's leverage (likely 1).
  return brackets[brackets.length - 1].initialLeverage
}
