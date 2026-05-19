/**
 * Daily Breakout — Variant C LIVE trader (Binance Futures USDT-M, real money).
 *
 * Mirrors the paper C trader's mechanics 1:1 (pre-emptive limit on rangeEdge,
 * pair cancel on fill, real TP/SL ladders, full trailing, EOD-FLAT 23:55 UTC),
 * but every action that paper simulates this service executes on Binance.
 *
 * This file is the public-API barrel. Implementation is split across this
 * folder by responsibility — see the module headers in each file.
 */

export { startBreakoutLiveTraderC, stopBreakoutLiveTraderC, restartBreakoutLiveTraderC, isRunning, currentNet } from './lifecycle'
export { getLiveSnapshot, type LiveSnapshot } from './snapshot'
export { flattenAllOpenC as flattenAllOpenLiveC, flattenOneOpenLiveC } from './flatten'
export { getLastAggTradeAt } from './aggTrade'
