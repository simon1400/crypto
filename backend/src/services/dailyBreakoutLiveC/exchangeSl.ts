/**
 * Exchange-side SL (hybrid model)
 *
 * The virtual tracker (trackLiveTrade) is the primary exit path: it watches
 * aggTrade ticks and sends MARKET reduceOnly when price crosses a level. It's
 * robust and identical to paper C.
 *
 * On top of that we *also* place a STOP_MARKET reduceOnly on Binance as a
 * safety net for the SL specifically:
 *   - If the bot dies (PM2 restart, VPS reboot, WS disconnect storm) the
 *     exchange-side SL still triggers — no naked position.
 *   - SL closes via STOP_MARKET cost taker fee anyway (the exit IS a market
 *     order once it triggers), so we don't lose on commissions vs the virtual
 *     path. Avg slippage is comparable.
 *   - TPs stay virtual — trailing requires "cancel old SL + place new SL"
 *     after each TP, which is simpler than juggling 3 child orders that all
 *     need recalibration.
 *
 * When the exchange SL fires:
 *   - ORDER_TRADE_UPDATE arrives with clientOrderId='slL{tradeId}', X=FILLED
 *   - handleSlOrderUpdate() invokes applyVirtualClose(reason='SL') so the DB
 *     and Telegram path is exactly the same as a virtual SL hit.
 *
 * When the bot's virtual SL fires first:
 *   - exitLiveTradeSlice cancels the exchange SL before sending MARKET,
 *     avoiding -2022 ReduceOnly rejected.
 *
 * Binance migrated STOP_MARKET to the Algo Order API in 2025-12 — the regular
 * /fapi/v1/order endpoint returns -4120. So we use placeAlgoOrder. The trigger
 * uses MARK_PRICE (not last trade) to avoid wick-out flashes.
 */

import { prisma } from '../../db/prisma'
import { BinanceApiError } from '../exchanges/binanceFutures'
import { LOG, state } from './state'
import { getFilters } from './filters'
import { sendLiveTelegram } from './telegram'

type PlaceSlResult = { ok: true; algoId: bigint } | { ok: false; error: string }

export async function placeSlOnExchange(trade: any): Promise<PlaceSlResult> {
  if (!state.current) return { ok: false, error: 'live trader not running' }
  const filters = await getFilters(state.current.client)
  const f = filters.get(trade.symbol)
  if (!f) return { ok: false, error: `no filter for ${trade.symbol}` }

  const closeSide: 'BUY' | 'SELL' = trade.side === 'BUY' ? 'SELL' : 'BUY'
  const tick = f.tickSize
  const triggerPrice = Number((Math.round(trade.currentStop / tick) * tick).toFixed(f.pricePrecision))
  // Round quantity DOWN to stepSize — retrailSlOnExchange passes the remaining
  // position fraction (e.g. 8375 × 0.5 = 4187.5 after TP1), which Binance rejects
  // with -1111 Precision when stepSize=1 (UBUSDT bug 2026-05-19 #4898). Apply
  // the same floor-to-step that placeOrder uses for entries / exit slices.
  const step = f.stepSize
  let qty = Math.floor(trade.positionUnits / step) * step
  qty = Number(qty.toFixed(f.quantityPrecision))
  if (qty < f.minQty) {
    return { ok: false, error: `qty ${qty} below minQty ${f.minQty} after step rounding` }
  }
  const slClientId = `slL${trade.id}`

  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await state.current.client.placeAlgoOrder({
        symbol: trade.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        triggerPrice,
        quantity: qty,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
        clientAlgoId: slClientId,
      })
      return { ok: true, algoId: BigInt(r.algoId) }
    } catch (e: any) {
      lastErr = e?.message ?? String(e)
      // -2021 'Order would immediately trigger' — markPrice already past stop.
      // No point retrying; let the virtual tracker handle this on the next tick.
      if (e instanceof BinanceApiError && e.code === -2021) break
      // Backoff before next attempt: 500ms, 1500ms.
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, attempt === 1 ? 500 : 1500))
      }
    }
  }
  return { ok: false, error: lastErr }
}

export async function cancelSlOnExchange(trade: any): Promise<void> {
  if (!state.current) return
  if (!trade.binanceSlOrderId) return
  try {
    await state.current.client.cancelAlgoOrder(trade.symbol, {
      algoId: Number(trade.binanceSlOrderId),
    })
  } catch (e: any) {
    // -2011 unknown order, -2013 doesn't exist — already gone, fine.
    if (e instanceof BinanceApiError && (e.code === -2011 || e.code === -2013)) return
    console.warn(`${LOG} cancel SL #${trade.id} ${trade.symbol} failed: ${e.message}`)
  }
}

/**
 * Place SL after entry fill. Best-effort: on failure we keep the position
 * open with a virtual-only SL (trackLiveTrade still owns the exit) and warn
 * via Telegram so the operator can intervene.
 */
export async function attachSlAfterEntry(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh || fresh.status !== 'OPEN') return
  if (fresh.binanceSlOrderId) return  // already placed (idempotent on reconcile/retry)

  const r = await placeSlOnExchange(fresh)
  if (r.ok) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: tradeId },
      data: { binanceSlOrderId: r.algoId },
    })
    console.log(`${LOG} 🛡 SL placed on exchange #${tradeId} ${fresh.symbol} @ ${fresh.currentStop} (algoId=${r.algoId})`)
  } else {
    console.warn(`${LOG} ⚠ SL placement failed for #${tradeId} ${fresh.symbol}: ${r.error} — virtual SL still active`)
    sendLiveTelegram([
      `⚠️ <b>${fresh.symbol}</b> · SL не выставлен на бирже`,
      `━━━━━━━━━━━━━━━━━━`,
      `Причина: <code>${r.error}</code>`,
      `Виртуальный SL продолжает работать (бот закроет MARKET при касании).`,
    ].join('\n'))
  }
}

/**
 * Retrail SL on Binance after TP1/TP2 hit. Cancels the old algo order and
 * places a fresh STOP_MARKET at the new currentStop level. If anything fails,
 * we just clear binanceSlOrderId — virtual tracker owns the exit.
 */
export async function retrailSlOnExchange(tradeId: number): Promise<void> {
  const fresh = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!fresh) return
  // Only retrail while position is still open.
  if (!['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(fresh.status)) return

  await cancelSlOnExchange(fresh)
  // Reset stored algoId so attachSlAfterEntry can re-place idempotently.
  await prisma.breakoutLiveTradeC.update({
    where: { id: tradeId },
    data: { binanceSlOrderId: null },
  })
  // The remaining position size is smaller after a partial TP — re-fetch and
  // pass it to placeSlOnExchange via positionUnits. We adjust by closed fraction.
  const refreshed = await prisma.breakoutLiveTradeC.findUnique({ where: { id: tradeId } })
  if (!refreshed) return
  const closesArr = ((refreshed.closes as any[]) ?? []) as Array<{ percent?: number }>
  const closedFrac = closesArr.reduce((a, c) => a + (c.percent ?? 0), 0) / 100
  const remainingUnits = refreshed.positionUnits * Math.max(0, 1 - closedFrac)
  const tradeForSl = { ...refreshed, positionUnits: remainingUnits }
  const r = await placeSlOnExchange(tradeForSl)
  if (r.ok) {
    await prisma.breakoutLiveTradeC.update({
      where: { id: tradeId },
      data: { binanceSlOrderId: r.algoId },
    })
    console.log(`${LOG} 🛡 SL retrailed #${tradeId} ${refreshed.symbol} → ${refreshed.currentStop}`)
  } else {
    console.warn(`${LOG} ⚠ SL retrail failed #${tradeId}: ${r.error} — virtual SL still active`)
  }
}
