/**
 * Robust position-close primitive.
 *
 * Why this exists (root-cause 2026-05-27): Binance **testnet** uniformly rejects
 * MARKET reduceOnly with -2022 "ReduceOnly Order is rejected" in many states —
 * even on a genuinely open, naked position. Every close path that relied on
 * reduceOnly (closeUntrackedPositions, closeMissedSl, flatten) therefore silently
 * gave up on -2022 and the position survived. Combined with the testnet
 * reduceOnly-STOP flip bug, that let naked/flipped "zombie" positions accumulate
 * for days, running with no SL.
 *
 * Strategy:
 *   1. Try MARKET reduceOnly (safe everywhere; on prod this is all that runs).
 *   2. On -2022, RE-READ the live position. Only if it still exists on the
 *      reducing side do we retry a PLAIN (non-reduceOnly) MARKET sized to AT
 *      MOST |positionAmt|, floored to step. An exact-or-smaller qty in the
 *      reducing direction cannot flip the position — it can only shrink it.
 *      If the re-read shows the position is already flat, -2022 meant "nothing
 *      to reduce" → treat as success, send nothing.
 *
 * The plain-MARKET fallback is the documented testnet pattern; the live re-read
 * guard makes it safe on prod too (we never fire a naked order into thin air).
 */

import type { BinanceFuturesClient } from '../exchanges/binanceFutures'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG } from './state'
import { getFilters } from './filters'

export interface CloseResult {
  ok: boolean
  reason?: string
  usedPlainFallback?: boolean
}

/**
 * Close (reduce) `quantity` of `symbol` in `closeSide` direction via MARKET.
 * `quantity` should already be step-rounded and ≤ the live position. The helper
 * re-floors against the live position on the fallback path regardless.
 */
export async function closeReduceOnlyOrPlain(
  client: BinanceFuturesClient,
  args: {
    symbol: string
    closeSide: 'BUY' | 'SELL'
    quantity: number
    clientOrderId?: string
  },
): Promise<CloseResult> {
  const { symbol, closeSide, quantity, clientOrderId } = args
  if (!(quantity > 0)) return { ok: true, reason: 'zero qty' }

  // Attempt 1 — reduceOnly (the only path that runs on prod in the common case).
  try {
    await client.placeOrder({
      symbol,
      side: closeSide,
      type: 'MARKET',
      quantity,
      reduceOnly: true,
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
    })
    return { ok: true }
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -2022) {
      // fall through to the verify-then-plain path
    } else {
      return { ok: false, reason: e?.message ?? String(e) }
    }
  }

  // -2022 path: confirm the position is real and on the reducing side before we
  // ever send a non-reduceOnly order (which COULD open a fresh position).
  let positions: Awaited<ReturnType<typeof client.getOpenPositions>>
  try {
    positions = await client.getOpenPositions()
  } catch (e: any) {
    return { ok: false, reason: `getOpenPositions after -2022 failed: ${e.message}` }
  }
  const p = positions.find((x) => x.symbol === symbol)
  const amt = p ? Number(p.positionAmt) : 0
  if (amt === 0) {
    // -2022 genuinely meant "nothing to reduce" — position already flat.
    return { ok: true, reason: 'already flat (-2022 = no position)' }
  }
  const reduces = (closeSide === 'SELL' && amt > 0) || (closeSide === 'BUY' && amt < 0)
  if (!reduces) {
    return { ok: false, reason: `closeSide ${closeSide} would not reduce amt ${amt} — refusing plain MARKET (flip guard)` }
  }

  // Plain MARKET sized to AT MOST the live position, floored to step → can't flip.
  const filters = await getFilters(client).catch(() => null)
  const f = filters?.get(symbol)
  const step = f?.stepSize ?? 0
  let q = Math.min(quantity, Math.abs(amt))
  if (step > 0) {
    q = Number((Math.floor(q / step) * step).toFixed(f!.quantityPrecision))
  }
  if (!(q > 0)) return { ok: true, reason: 'sub-step dust after floor' }

  try {
    await client.placeOrder({
      symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: q,
      // NOTE: no reduceOnly — testnet rejects it here. Safe because q ≤ |amt|
      // in the reducing direction, confirmed against the live re-read above.
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
    })
    console.log(`${LOG} closeReduceOnlyOrPlain: ${symbol} ${closeSide} ${q} via plain MARKET (reduceOnly was -2022; live amt=${amt})`)
    return { ok: true, usedPlainFallback: true }
  } catch (e: any) {
    if (e instanceof BinanceApiError && e.code === -4164) {
      // notional < min and reduceOnly not allowed → true sub-min dust, harmless.
      return { ok: true, reason: 'sub-min dust (-4164)' }
    }
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

interface SymbolFilter {
  stepSize: number
  minQty: number
  marketMaxQty?: number | null
  quantityPrecision: number
}

/**
 * Close an entire signed position (`amt`) at MARKET, chunked by MARKET_LOT_SIZE,
 * using closeReduceOnlyOrPlain per leg. `amt` > 0 closes a long (SELL), < 0 a
 * short (BUY). Floors each leg to step; legs below minQty are dropped (dust).
 */
export async function closeFullPositionMarket(
  client: BinanceFuturesClient,
  symbol: string,
  amt: number,
  f: SymbolFilter,
  clientOrderIdBase?: string,
): Promise<CloseResult & { closedQty: number }> {
  const closeSide: 'BUY' | 'SELL' = amt > 0 ? 'SELL' : 'BUY'
  const step = f.stepSize
  let qty = Number((Math.floor(Math.abs(amt) / step) * step).toFixed(f.quantityPrecision))
  if (qty < f.minQty) return { ok: true, reason: 'sub-min dust', closedQty: 0 }

  const cap = Math.max(f.minQty, f.marketMaxQty || qty)
  const chunks: number[] = []
  if (qty <= cap) {
    chunks.push(qty)
  } else {
    let rem = qty
    while (rem > 1e-9) {
      let qc = Number((Math.floor(Math.min(rem, cap) / step) * step).toFixed(f.quantityPrecision))
      if (qc < f.minQty) break
      chunks.push(qc)
      rem -= qc
    }
  }

  let anyFail = false
  let plain = false
  let closedQty = 0
  for (let i = 0; i < chunks.length; i++) {
    const cid = clientOrderIdBase
      ? (chunks.length === 1 ? clientOrderIdBase : `${clientOrderIdBase}_${i + 1}`)
      : undefined
    const r = await closeReduceOnlyOrPlain(client, { symbol, closeSide, quantity: chunks[i], clientOrderId: cid })
    if (!r.ok) anyFail = true
    else closedQty += chunks[i]
    if (r.usedPlainFallback) plain = true
  }
  return { ok: !anyFail, usedPlainFallback: plain, closedQty }
}
