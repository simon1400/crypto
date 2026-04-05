import { useState, useRef, useCallback } from 'react'
import { createTrade, closeTrade, Trade, TradeTP } from '../api/client'

// KlineData shape matching what Backtester uses
interface KlineData {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ActiveOrder {
  type: 'LONG' | 'SHORT'
  entry: number
  sl: number
  tps: { price: number; percent: number }[]
  leverage: number
  amount: number
}

interface PriceLines {
  entry: any | null
  sl: any | null
  tps: any[]
}

interface UseBacktestTradingParams {
  candleSeriesRef: React.MutableRefObject<any>
  symbol: string
  replayMode: boolean
}

export function useBacktestTrading({ candleSeriesRef, symbol, replayMode }: UseBacktestTradingParams) {
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null)
  const [priceLines, setPriceLines] = useState<PriceLines>({ entry: null, sl: null, tps: [] })
  const [closedTrades, setClosedTrades] = useState<Trade[]>([])
  const [currentPnl, setCurrentPnl] = useState(0)

  // RE-ENTRY GUARD: prevents duplicate DB writes when checkCandle() fires
  // faster than async save completes (critical at high replay speeds)
  const isSavingRef = useRef(false)
  const priceLinesRef = useRef<PriceLines>({ entry: null, sl: null, tps: [] })
  const activeOrderRef = useRef<ActiveOrder | null>(null)

  // Keep refs in sync with state
  const updatePriceLines = (lines: PriceLines) => {
    priceLinesRef.current = lines
    setPriceLines(lines)
  }

  const updateActiveOrder = (order: ActiveOrder | null) => {
    activeOrderRef.current = order
    setActiveOrder(order)
  }

  const placeOrder = useCallback((
    type: 'LONG' | 'SHORT',
    entry: number,
    sl: number,
    tps: { price: number; percent: number }[],
    leverage: number,
    amount: number
  ) => {
    // GUARD: chart not mounted yet
    if (!candleSeriesRef.current) return

    const series = candleSeriesRef.current

    // Remove existing price lines if any
    const existing = priceLinesRef.current
    if (existing.entry) {
      try { series.removePriceLine(existing.entry) } catch {}
    }
    if (existing.sl) {
      try { series.removePriceLine(existing.sl) } catch {}
    }
    for (const tp of existing.tps) {
      try { series.removePriceLine(tp) } catch {}
    }

    // Entry price line (accent yellow)
    const entryLine = series.createPriceLine({
      price: entry,
      color: '#f0b90b',
      lineWidth: 2,
      lineStyle: 0,
      axisLabelVisible: true,
      title: type,
      draggable: true,
    })

    // Stop Loss price line (red)
    const slLine = series.createPriceLine({
      price: sl,
      color: '#f6465d',
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'SL',
      draggable: true,
    })

    // Take Profit price lines (green)
    const tpLines = tps.map((tp, i) =>
      series.createPriceLine({
        price: tp.price,
        color: '#0ecb81',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `TP${i + 1}`,
        draggable: true,
      })
    )

    const newLines: PriceLines = { entry: entryLine, sl: slLine, tps: tpLines }
    updatePriceLines(newLines)
    updateActiveOrder({ type, entry, sl, tps, leverage, amount })
  }, [candleSeriesRef])

  const cancelOrder = useCallback(() => {
    if (!candleSeriesRef.current) return
    const series = candleSeriesRef.current
    const lines = priceLinesRef.current

    if (lines.entry) {
      try { series.removePriceLine(lines.entry) } catch {}
    }
    if (lines.sl) {
      try { series.removePriceLine(lines.sl) } catch {}
    }
    for (const tp of lines.tps) {
      try { series.removePriceLine(tp) } catch {}
    }

    updatePriceLines({ entry: null, sl: null, tps: [] })
    updateActiveOrder(null)
    isSavingRef.current = false
    setCurrentPnl(0)
  }, [candleSeriesRef])

  const checkCandle = useCallback(async (candle: KlineData) => {
    // RE-ENTRY GUARD: prevents duplicate saves at high replay speeds
    if (isSavingRef.current || !activeOrderRef.current) return

    const order = activeOrderRef.current
    const lines = priceLinesRef.current

    // Read current prices from draggable price lines (user may have adjusted them)
    const currentSl = lines.sl ? lines.sl.options().price : order.sl
    const currentTps = lines.tps.length > 0
      ? lines.tps.map((line: any, i: number) => ({
          price: line.options().price,
          percent: order.tps[i]?.percent ?? 100,
        }))
      : order.tps
    const currentEntry = lines.entry ? lines.entry.options().price : order.entry

    let hitPrice: number | null = null
    let isSL = false

    if (order.type === 'LONG') {
      // Check SL hit (candle low crossed below SL)
      if (candle.low <= currentSl) {
        hitPrice = currentSl
        isSL = true
      }
      // Check TP hits (candle high crossed above TP)
      if (!isSL) {
        for (const tp of currentTps) {
          if (candle.high >= tp.price) {
            hitPrice = tp.price
            break
          }
        }
      }
    } else {
      // SHORT
      // Check SL hit (candle high crossed above SL)
      if (candle.high >= currentSl) {
        hitPrice = currentSl
        isSL = true
      }
      // Check TP hits (candle low crossed below TP)
      if (!isSL) {
        for (const tp of currentTps) {
          if (candle.low <= tp.price) {
            hitPrice = tp.price
            break
          }
        }
      }
    }

    if (hitPrice === null) return

    // Hit detected — set saving guard
    isSavingRef.current = true

    try {
      // Save trade to DB with source=BACKTEST
      const coinSymbol = symbol.toUpperCase().endsWith('USDT')
        ? symbol.replace(/USDT$/i, '')
        : symbol

      const tpsPayload: TradeTP[] = currentTps.map(tp => ({
        price: tp.price,
        percent: tp.percent,
      }))

      const savedTrade = await createTrade({
        coin: coinSymbol,
        type: order.type,
        leverage: order.leverage,
        entryPrice: currentEntry,
        amount: order.amount,
        stopLoss: currentSl,
        takeProfits: tpsPayload,
        source: 'BACKTEST',
      })

      // Close trade at hit price with 100%
      const closedTrade = await closeTrade(savedTrade.id, hitPrice, 100)

      setClosedTrades(prev => [...prev, closedTrade])

      // Remove all price lines
      if (candleSeriesRef.current) {
        const series = candleSeriesRef.current
        const lines2 = priceLinesRef.current
        if (lines2.entry) { try { series.removePriceLine(lines2.entry) } catch {} }
        if (lines2.sl) { try { series.removePriceLine(lines2.sl) } catch {} }
        for (const tp of lines2.tps) { try { series.removePriceLine(tp) } catch {} }
      }

      updatePriceLines({ entry: null, sl: null, tps: [] })
      updateActiveOrder(null)
      setCurrentPnl(0)
    } catch (err) {
      console.error('[useBacktestTrading] Failed to save trade:', err)
    } finally {
      isSavingRef.current = false
    }
  }, [candleSeriesRef, symbol])

  const updatePnl = useCallback((currentPrice: number) => {
    const order = activeOrderRef.current
    if (!order) {
      setCurrentPnl(0)
      return
    }

    // Read current entry from draggable line if available
    const currentEntry = priceLinesRef.current.entry
      ? priceLinesRef.current.entry.options().price
      : order.entry

    const direction = order.type === 'LONG' ? 1 : -1
    const priceDiff = (currentPrice - currentEntry) * direction
    const pnlPercent = (priceDiff / currentEntry) * 100 * order.leverage
    const pnlUsdt = order.amount * (pnlPercent / 100)
    setCurrentPnl(Math.round(pnlUsdt * 100) / 100)
  }, [])

  return {
    activeOrder,
    priceLines,
    closedTrades,
    currentPnl,
    isSavingRef,
    placeOrder,
    cancelOrder,
    checkCandle,
    updatePnl,
  }
}
