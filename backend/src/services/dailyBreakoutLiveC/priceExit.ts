/**
 * Price-triggered exit confirmation (variant C — 2026-06-08).
 *
 * WHY THIS EXISTS: on the prod account (Multi-Assets / BNFCR mode) the private
 * user-data WebSocket delivers ZERO ORDER_TRADE_UPDATE events — proven 2026-06-08
 * (forced a real order, both /ws/ and /stream?streams= URL forms got 0 frames).
 * So the exchange SL/TP algo orders fire correctly, but handleSlOrderUpdate /
 * handleTpOrderUpdate never run → every exit fell through to the 60s REST
 * reconcile ("♻ Reconciled exit" on every trade) and SL trailing (→BE after TP1)
 * never happened. See [[project_live_c_userdata_ws_dead_multiassets_2026_06_08]].
 *
 * The PUBLIC market WS (@bookTicker) IS alive and pushes real-time prices. We use
 * it as a TRIGGER, not as a closer: when a live trade's price crosses its SL or
 * its next TP level, we spend ONE targeted REST `getOpenPositions` to confirm what
 * the exchange actually did, then replay the exact same DB/trailing path the dead
 * WS handlers would have run:
 *   - exchange position SHRANK to a TP boundary (still open) → applyVirtualClose
 *     for the fired rung(s) → records the close + retrails SL→BE/TP1 on the
 *     exchange (the trailing fix). notifyImmediately=true sends Telegram now.
 *   - exchange position GONE / flipped → reconcileOneClosedTrade → finalize from
 *     userTrades (authoritative P&L; the residual absorbs any TP estimate drift so
 *     the trade total stays exact).
 *
 * The exchange still does the actual closing (its mark-triggered algo orders).
 * We never send a competing MARKET here — so no double-close / flip risk (the
 * 2026-05-27 saga). This is a confirmation+bookkeeping layer, price-gated so it
 * costs a REST call only at the instant an exit is plausible.
 */

import { prisma } from '../../db/prisma'
import type { BinanceFuturesClient, PositionRisk } from '../exchanges/binanceFutures'
import { LOG, state, tradeBusy, SPLITS } from './state'
import { applyVirtualClose } from './virtualSltp'
import { reconcileOneClosedTrade } from './reconcile'

// Per-trade debounce so price hovering at a level doesn't fire a REST storm.
const lastCheckAt = new Map<number, number>()
const CHECK_DEBOUNCE_MS = 4000

// Short shared cache for getOpenPositions — a burst of crosses across several
// symbols in the same second reuses one REST read instead of N.
const posCache: { at: number; data: PositionRisk[] } = { at: 0, data: [] }
const POS_CACHE_MS = 1500

async function getPositionsCached(client: BinanceFuturesClient): Promise<PositionRisk[]> {
  if (Date.now() - posCache.at < POS_CACHE_MS) return posCache.data
  const data = await client.getOpenPositions()
  posCache.at = Date.now()
  posCache.data = data
  return data
}

// Remaining fraction of the ORIGINAL position after k TP rungs:
// SPLITS=[.5,.3,.2] → [1, .5, .2, 0]. Used to map the exchange's live size back
// to "how many TPs the exchange has executed".
const REM_AFTER = [1, 1 - SPLITS[0], 1 - SPLITS[0] - SPLITS[1], 0]
const TERMINAL_FRAC = 0.03 // exchange ≤3% of original ⇒ treat as fully closed

/**
 * Called from the aggTrade (bookTicker) handler for every live-price tick on a
 * symbol that has open LIVE C trades. Cheap when nothing crossed (no REST).
 */
export async function confirmExitsOnPrice(symbol: string, price: number): Promise<void> {
  if (!state.current) return
  const rows = await prisma.breakoutLiveTradeC.findMany({
    where: { symbol, status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  for (const t of rows) {
    try {
      await checkOneTrade(t, price)
    } catch (e: any) {
      console.warn(`${LOG} priceExit #${t.id} ${symbol}: ${e?.message ?? e}`)
    }
  }
}

async function checkOneTrade(t: any, price: number): Promise<void> {
  if (!state.current) return
  // Freshness guard: a just-filled position may briefly read as absent in
  // getOpenPositions (matching engine vs account snapshot lag). The price-gate
  // already protects (entry sits between SL and TP1, so neither crosses right
  // after a clean fill), but skip the first 15s as belt-and-braces against a
  // false "position gone → finalize". The 60s reconcile covers this window.
  if (t.openedAt && Date.now() - new Date(t.openedAt).getTime() < 15_000) return
  const isLong = t.side === 'BUY'
  const closesArr = ((t.closes as any[]) ?? []) as Array<{ percent?: number; reason?: string }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const dbRemFrac = Math.max(0, 1 - closedFrac)
  if (dbRemFrac < 1e-6) return

  const ladder = ((t.tpLadder as number[]) ?? []) as number[]
  const takenTps = closesArr.filter((c) => typeof c.reason === 'string' && c.reason.startsWith('TP')).length
  const nextTp = ladder[takenTps]
  const stop = t.currentStop

  const slCrossed = isLong ? price <= stop : price >= stop
  const tpCrossed = nextTp != null && (isLong ? price >= nextTp : price <= nextTp)
  if (!slCrossed && !tpCrossed) return

  // Debounce + per-trade lock (shared with the legacy tracker lock set).
  const now = Date.now()
  if (now - (lastCheckAt.get(t.id) ?? 0) < CHECK_DEBOUNCE_MS) return
  if (tradeBusy.has(t.id)) return
  lastCheckAt.set(t.id, now)
  tradeBusy.add(t.id)
  try {
    const positions = await getPositionsCached(state.current.client)
    const pos = positions.find((p) => p.symbol === t.symbol)
    const liveAmt = pos ? Number(pos.positionAmt) : 0
    const exFrac = t.positionUnits > 0 ? Math.abs(liveAmt) / t.positionUnits : 0
    const flipped = liveAmt !== 0 && (liveAmt > 0) !== isLong

    // Nothing actually closed yet — exchange still holds ~what DB expects.
    // (bookTicker mid crossed the level but the mark-triggered algo hasn't
    // executed, or our mid leads the mark.) Spend nothing, let the exchange fire.
    if (!flipped && exFrac >= dbRemFrac - 0.03) return

    // Fully closed (flat / dust) or flipped → finalize from userTrades (exact).
    if (flipped || exFrac <= TERMINAL_FRAC) {
      const done = await reconcileOneClosedTrade(state.current.client, t.id, positions, 'live')
      if (done) console.log(`${LOG} ⚡ price-confirmed exit #${t.id} ${t.symbol} (exFrac=${exFrac.toFixed(3)}${flipped ? ', flipped' : ''})`)
      return
    }

    // Partial: exchange shrank to a TP boundary while the position is still
    // open → a TP rung fired. Map exFrac → how many TPs the exchange executed.
    let exTps = 0
    for (let k = 1; k <= 2; k++) {
      if (exFrac <= REM_AFTER[k] + 0.07) exTps = k
    }
    if (exTps <= takenTps) return // nothing new beyond what DB already recorded

    for (let k = takenTps; k < exTps; k++) {
      const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: t.id } })
      if (!fresh || !['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) break
      const tp = ladder[k]
      if (tp == null) break
      const splitFrac = SPLITS[k] ?? 0
      const initialRisk = Math.abs(fresh.entryPrice - fresh.initialStop)
      const dir = isLong ? tp - fresh.entryPrice : fresh.entryPrice - tp
      const pnlR = initialRisk > 0 ? (dir / initialRisk) * splitFrac : 0
      const grossPnl = dir * fresh.positionUnits * splitFrac
      const estFee = fresh.positionUnits * splitFrac * tp * ((fresh.feeTakerPct ?? 0.04) / 100)
      // notifyImmediately=true: no WS refine will ever arrive (dead user-data
      // stream), so applyVirtualClose must send the Telegram itself. The exact
      // P&L is reconciled into the trade total when the terminal close runs
      // finalizeOrphanRow (residual = userTrades total − Σ these estimates).
      await applyVirtualClose(fresh, `TP${k + 1}` as 'TP1' | 'TP2' | 'TP3', tp, splitFrac, pnlR, grossPnl - estFee, now, estFee, true)
      console.log(`${LOG} 🎯 price-confirmed TP${k + 1} #${t.id} ${t.symbol} @ ~${tp} (exchange exFrac=${exFrac.toFixed(3)})`)
    }
  } finally {
    tradeBusy.delete(t.id)
  }
}
