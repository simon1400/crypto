import { useEffect, useRef } from 'react'
import {
  createChart,
  IChartApi,
  CandlestickSeries,
  LineSeries,
  BaselineSeries,
  LineStyle,
  UTCTimestamp,
  createSeriesMarkers,
} from 'lightweight-charts'
import { createDarkChartOptions } from '../lib/chartConfig'
import { usePositionChart, toUnix, snapToHour, pickPrecision, FUTURE_BARS, CLOSED_TAIL_BARS } from '../hooks/usePositionChart'

// =============================================================================
// Position overlay modal: renders a TradingView-style Long/Short Position tool
// on top of a 1h candlestick chart. Reused by Trades and Scanner pages.
// Data fetching is handled by usePositionChart hook.
// =============================================================================

export type { PositionChartPosition } from '../hooks/usePositionChart'
import type { PositionChartPosition } from '../hooks/usePositionChart'

interface Props {
  position: PositionChartPosition
  onClose: () => void
}

export default function PositionChartModal({ position, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  const {
    klines,
    loading,
    error,
    symbol,
    isLong,
    latestKlineTime,
    depEntry,
    depStopLoss,
    depTakeProfits,
    depOpenedAt,
    depClosedAt,
    depCurrentPrice,
    depPartials,
    candleSeriesRef,
    profitBgRef,
    lossBgRef,
    profitFgRef,
    lossFgRef,
    diagonalRef,
    zoneEdgesRef,
    liveCandleRef,
  } = usePositionChart(position)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Build chart whenever klines arrive or structural position fields change.
  // IMPORTANT: this effect does NOT depend on currentPrice — that's updated
  // by the lightweight effect below via setData, without touching the chart.
  useEffect(() => {
    if (!containerRef.current || klines.length === 0) return

    const chart = createChart(containerRef.current, {
      ...createDarkChartOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        background: 'primary',
        timeVisible: true,
        secondsVisible: false,
        crosshairMode: 0,
      }),
    } as any)
    chartRef.current = chart

    const precision = pickPrecision(position.entry)
    const minMove = Math.pow(10, -precision)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
      priceFormat: {
        type: 'price',
        precision,
        minMove,
      },
    })
    candleSeriesRef.current = candleSeries

    candleSeries.setData(
      klines.map(k => ({
        time: k.time as UTCTimestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }))
    )

    // Always ensure there is a visible candle at the current hour.
    // Bybit may not include the currently-forming candle, leaving a gap.
    if (klines.length > 0) {
      const lastK = klines[klines.length - 1]
      const nowSec = Math.floor(Date.now() / 1000)
      const currentHourStart = (Math.floor(nowSec / 3600) * 3600) as UTCTimestamp
      const price = position.currentPrice ?? lastK.close

      // Determine base OHLC for the live candle
      const isNewHour = currentHourStart > lastK.time
      const targetTime = (isNewHour ? currentHourStart : lastK.time) as UTCTimestamp
      const baseOpen = isNewHour ? lastK.close : lastK.open
      const baseHigh = isNewHour ? Math.max(lastK.close, price) : Math.max(lastK.high, price)
      const baseLow = isNewHour ? Math.min(lastK.close, price) : Math.min(lastK.low, price)

      liveCandleRef.current = { time: targetTime, open: baseOpen, high: baseHigh, low: baseLow }

      try {
        candleSeries.update({
          time: targetTime,
          open: baseOpen,
          high: baseHigh,
          low: baseLow,
          close: price,
        })
      } catch {}
    }

    // ---- Position overlay ----
    const { entry, stopLoss, takeProfits } = position
    const lastTP = takeProfits.length > 0 ? takeProfits[takeProfits.length - 1] : entry

    // Time anchors
    const firstCandleSec = klines[0].time
    const lastCandleSec = klines[klines.length - 1].time

    // Entry time: openedAt if known, else last candle (for NEW scanner signals)
    const openedSec = toUnix(position.openedAt)
    const entryTime = openedSec != null
      ? snapToHour(Math.max(openedSec, firstCandleSec))
      : snapToHour(lastCandleSec)

    const closedSec = toUnix(position.closedAt)
    // Right edge of the zone. Stable — does NOT depend on Date.now().
    //   closed → closedAt + small tail
    //   open   → lastCandle + 3 days (72 * 1h)
    //   new    → lastCandle + 3 days
    const rightEdgeSec = closedSec != null
      ? snapToHour(closedSec) + CLOSED_TAIL_BARS * 3600
      : snapToHour(lastCandleSec) + FUTURE_BARS * 3600

    // Two hourly ticks is enough — BaselineSeries draws flat zones.
    const leftEdge = entryTime as UTCTimestamp
    const rightEdge = rightEdgeSec as UTCTimestamp
    zoneEdgesRef.current = { left: leftEdge, right: rightEdge }

    // Colors: pale = background "full zone", opaque = realized part
    const T = 'rgba(0, 0, 0, 0)'
    const G = (a: number) => `rgba(14, 203, 129, ${a})`
    const R = (a: number) => `rgba(246, 70, 93, ${a})`

    // Helper: add a flat baseline zone series and set its initial data
    function addZone(
      basePrice: number,
      topC1: string, topC2: string,
      botC1: string, botC2: string,
      initValue: number,
    ) {
      const s = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: basePrice },
        topFillColor1: topC1, topFillColor2: topC2, topLineColor: T,
        bottomFillColor1: botC1, bottomFillColor2: botC2, bottomLineColor: T,
        lastValueVisible: false, priceLineVisible: false,
      })
      s.setData([{ time: leftEdge, value: initValue }, { time: rightEdge, value: initValue }])
      return s
    }

    // Pale background: full zones
    const profitBg = addZone(entry,
      isLong ? G(0.12) : T, isLong ? G(0.06) : T,
      isLong ? T : G(0.12), isLong ? T : G(0.06), lastTP)
    profitBgRef.current = profitBg

    const lossBg = addZone(entry,
      isLong ? T : R(0.12), isLong ? T : R(0.06),
      isLong ? R(0.12) : T, isLong ? R(0.06) : T, stopLoss)
    lossBgRef.current = lossBg

    // Opaque foreground: realized parts (start at entry = zero area, updated by zone effect)
    const profitFg = addZone(entry,
      isLong ? G(0.38) : T, isLong ? G(0.22) : T,
      isLong ? T : G(0.38), isLong ? T : G(0.22), entry)
    profitFgRef.current = profitFg

    const lossFg = addZone(entry,
      isLong ? T : R(0.38), isLong ? T : R(0.22),
      isLong ? R(0.38) : T, isLong ? R(0.22) : T, entry)
    lossFgRef.current = lossFg

    // --- Dashed diagonal: Entry → last TP ---
    const diagonalSeries = chart.addSeries(LineSeries, {
      color: 'rgba(234, 236, 239, 0.6)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    diagonalSeries.setData([
      { time: entryTime, value: entry },
      { time: rightEdgeSec as UTCTimestamp, value: lastTP },
    ])
    diagonalRef.current = diagonalSeries

    // --- Horizontal price levels (Entry / SL / TP1..N) ---
    candleSeries.createPriceLine({
      price: entry,
      color: '#f0b90b',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: isLong ? 'LONG' : 'SHORT',
    })
    candleSeries.createPriceLine({
      price: stopLoss,
      color: '#f6465d',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'SL',
    })
    takeProfits.forEach((tp, i) => {
      candleSeries.createPriceLine({
        price: tp,
        color: '#0ecb81',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `TP${i + 1}`,
      })
    })

    // --- Markers: entry (Buy/Sell) + partial closes ---
    type SeriesMarker = {
      time: UTCTimestamp
      position: 'aboveBar' | 'belowBar'
      color: string
      shape: 'arrowUp' | 'arrowDown' | 'circle'
      text: string
    }
    const markers: SeriesMarker[] = []

    if (openedSec != null) {
      markers.push({
        time: entryTime,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: isLong ? '#0ecb81' : '#f6465d',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: isLong ? 'Buy' : 'Sell',
      })
    }

    if (position.partialCloses && position.partialCloses.length > 0) {
      for (const close of position.partialCloses) {
        const closeSec = toUnix(close.closedAt)
        if (closeSec == null) continue
        const time = snapToHour(closeSec)
        markers.push({
          time,
          position: close.isSL ? (isLong ? 'belowBar' : 'aboveBar') : (isLong ? 'aboveBar' : 'belowBar'),
          color: close.isSL ? '#f6465d' : '#0ecb81',
          shape: 'circle',
          text: close.isSL ? `SL` : `−${close.percent}%`,
        })
      }
    }

    if (markers.length > 0) {
      createSeriesMarkers(candleSeries, markers)
    }

    // Fit the chart to content on initial build, then scroll so the latest candle
    // is visible on the right edge (not buried under future overlay zones).
    chart.timeScale().fitContent()
    chart.timeScale().scrollToRealTime()

    // Resize handler
    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      })
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      profitBgRef.current = null
      lossBgRef.current = null
      profitFgRef.current = null
      lossFgRef.current = null
      diagonalRef.current = null
      zoneEdgesRef.current = null
      liveCandleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, isLong, depEntry, depStopLoss, depTakeProfits, depOpenedAt, depClosedAt, depPartials])

  // Micro-effect: push a live-price candle as soon as BOTH series and price are available.
  // Deps include klines.length so it re-fires after heavy effect builds the chart.
  useEffect(() => {
    if (depCurrentPrice == null || !candleSeriesRef.current || klines.length === 0) return
    const lc = liveCandleRef.current
    if (!lc) return
    try {
      lc.high = Math.max(lc.high, depCurrentPrice)
      lc.low = Math.min(lc.low, depCurrentPrice)
      candleSeriesRef.current.update({
        time: lc.time as UTCTimestamp,
        open: lc.open,
        high: lc.high,
        low: lc.low,
        close: depCurrentPrice,
      })
    } catch {}
  }, [depCurrentPrice, klines.length])

  // Lightweight effect: updates overlay zones in place on every live-data tick.
  // Recomputes right edge from latestKlineTime so the zone extends candle-by-candle
  // as new bars come in. Does NOT rebuild the chart — only setData on existing series.
  // This preserves user's pan/zoom completely.
  useEffect(() => {
    const edges = zoneEdgesRef.current
    const profitBg = profitBgRef.current
    const lossBg = lossBgRef.current
    const profitFg = profitFgRef.current
    const lossFg = lossFgRef.current
    const diagonal = diagonalRef.current
    if (!edges || !profitBg || !lossBg || !profitFg || !lossFg || !diagonal) return

    const entry = depEntry
    const stopLoss = depStopLoss
    const tpsArr = depTakeProfits.split(',').map(Number).filter(n => !Number.isNaN(n))
    const lastTP = tpsArr.length > 0 ? tpsArr[tpsArr.length - 1] : entry
    const live = depCurrentPrice

    // Recompute right edge: closed trades stay frozen; open trades follow the latest candle.
    const closedSec = toUnix(depClosedAt)
    let rightEdge: UTCTimestamp
    if (closedSec != null) {
      rightEdge = (snapToHour(closedSec) + CLOSED_TAIL_BARS * 3600) as UTCTimestamp
    } else if (latestKlineTime > 0) {
      rightEdge = (snapToHour(latestKlineTime) + FUTURE_BARS * 3600) as UTCTimestamp
    } else {
      rightEdge = edges.right
    }

    // Only update refs if edge actually moved — avoids unnecessary setData.
    if (rightEdge !== edges.right) {
      zoneEdgesRef.current = { left: edges.left, right: rightEdge }
    }
    const leftEdge = edges.left

    // Foreground levels: realized part (entry → currentPrice, clamped by TP/SL)
    let profitLevel = entry
    let lossLevel = entry
    if (live != null) {
      if (isLong) {
        if (live > entry) profitLevel = Math.min(live, lastTP)
        else if (live < entry) lossLevel = Math.max(live, stopLoss)
      } else {
        if (live < entry) profitLevel = Math.max(live, lastTP)
        else if (live > entry) lossLevel = Math.min(live, stopLoss)
      }
    }

    // Update candle with current live price — preserve tracked high/low
    if (live != null && candleSeriesRef.current) {
      const lc = liveCandleRef.current
      if (lc) {
        try {
          lc.high = Math.max(lc.high, live)
          lc.low = Math.min(lc.low, live)
          candleSeriesRef.current.update({
            time: lc.time as UTCTimestamp,
            open: lc.open,
            high: lc.high,
            low: lc.low,
            close: live,
          })
        } catch {}
      }
    }

    try {
      // Pale background: full zones Entry→lastTP and Entry→SL
      profitBg.setData([
        { time: leftEdge, value: lastTP },
        { time: rightEdge, value: lastTP },
      ])
      lossBg.setData([
        { time: leftEdge, value: stopLoss },
        { time: rightEdge, value: stopLoss },
      ])
      // Opaque foreground: realized part only
      profitFg.setData([
        { time: leftEdge, value: profitLevel },
        { time: rightEdge, value: profitLevel },
      ])
      lossFg.setData([
        { time: leftEdge, value: lossLevel },
        { time: rightEdge, value: lossLevel },
      ])
      // Dashed diagonal: Entry → lastTP
      diagonal.setData([
        { time: leftEdge, value: entry },
        { time: rightEdge, value: lastTP },
      ])
    } catch {}
  }, [depCurrentPrice, depEntry, depStopLoss, depTakeProfits, depClosedAt, isLong, latestKlineTime])

  const headerTitle = position.title || `${position.coin.replace('USDT', '')} · ${position.type}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-primary border border-card rounded-lg shadow-2xl flex flex-col"
        style={{ width: '90vw', height: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-card flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-text-primary font-semibold">{headerTitle}</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${isLong ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}>
              {position.type}
            </span>
            <span className="text-text-secondary text-xs font-mono">1h · Bybit</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`https://www.tradingview.com/chart/?symbol=BYBIT:${symbol}.P`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary hover:text-accent text-xs transition-colors"
              title="Открыть в TradingView"
            >
              TV ↗
            </a>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary p-1"
              title="Закрыть (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 relative min-h-0">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-text-secondary text-sm">
              Загрузка данных...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-short text-sm">
              {error}
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
        </div>
      </div>
    </div>
  )
}
