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
import { usePositionChart, toUnix, snapToBar, pickPrecision, FUTURE_BARS, CLOSED_TAIL_BARS, ChartInterval } from '../hooks/usePositionChart'

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

// Killzone definitions in UTC hour ranges. NY_PM is filtered out by engine but still
// shown on chart so user can see why no signals appeared during it.
const KILLZONE_RANGES: { name: string; startHour: number; endHour: number; color: string; label: string }[] = [
  { name: 'ASIAN',  startHour: 23, endHour: 4,  color: 'rgba(156, 163, 175, 0.07)', label: 'Asian' },   // grey
  { name: 'LONDON', startHour: 6,  endHour: 9,  color: 'rgba(96, 165, 250, 0.10)',  label: 'London' }, // blue (best edge)
  { name: 'NY',     startHour: 12, endHour: 15, color: 'rgba(34, 197, 94, 0.07)',   label: 'NY' },     // green
  { name: 'NY_PM',  startHour: 15, endHour: 17, color: 'rgba(246, 70, 93, 0.07)',   label: 'NY PM' },  // red (excluded)
]

export default function PositionChartModal({ position, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const {
    klines,
    loading,
    error,
    symbol,
    isLong,
    latestKlineTime,
    interval,
    setInterval: setChartInterval,
    intervalSec,
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

    // Always ensure there is a visible candle at the current bar boundary.
    // Bybit may not include the currently-forming candle, leaving a gap.
    if (klines.length > 0) {
      const lastK = klines[klines.length - 1]
      const nowSec = Math.floor(Date.now() / 1000)
      const currentBarStart = (Math.floor(nowSec / intervalSec) * intervalSec) as UTCTimestamp
      const price = position.currentPrice ?? lastK.close

      // Determine base OHLC for the live candle
      const isNewBar = currentBarStart > lastK.time
      const targetTime = (isNewBar ? currentBarStart : lastK.time) as UTCTimestamp
      const baseOpen = isNewBar ? lastK.close : lastK.open
      const baseHigh = isNewBar ? Math.max(lastK.close, price) : Math.max(lastK.high, price)
      const baseLow = isNewBar ? Math.min(lastK.close, price) : Math.min(lastK.low, price)

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
      ? snapToBar(Math.max(openedSec, firstCandleSec), intervalSec)
      : snapToBar(lastCandleSec, intervalSec)

    const closedSec = toUnix(position.closedAt)
    // Right edge of the zone. Stable — does NOT depend on Date.now().
    //   closed → closedAt + small tail
    //   open   → lastCandle + FUTURE_BARS
    //   new    → lastCandle + FUTURE_BARS
    const rightEdgeSec = closedSec != null
      ? snapToBar(closedSec, intervalSec) + CLOSED_TAIL_BARS * intervalSec
      : snapToBar(lastCandleSec, intervalSec) + FUTURE_BARS * intervalSec

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

    // --- Structural reference levels (PDH/PDL/PWH/PWL + nearest M15/H1 fractals) ---
    if (position.keyLevels && position.keyLevels.length > 0) {
      // Color per kind for quick recognition
      const colorByKind: Record<string, string> = {
        PDH: '#9ca3af',         // grey-400 — yesterday's high
        PDL: '#9ca3af',
        PWH: '#a78bfa',         // violet — last week's high (stronger)
        PWL: '#a78bfa',
        FRACTAL_H1: '#60a5fa',  // blue — H1 fractal (strong swing)
        FRACTAL_M15: '#3b82f6', // blue-darker — M15 fractal
        FRACTAL_5M: '#475569',
        OTHER: '#475569',
      }
      // Skip levels that overlap entry/SL/TP within ±0.05% — they're already drawn
      const eps = entry * 0.0005
      const drawn = [entry, stopLoss, ...takeProfits]
      const isOverlap = (p: number) => drawn.some(d => Math.abs(p - d) <= eps)

      for (const kl of position.keyLevels) {
        if (isOverlap(kl.price)) continue
        candleSeries.createPriceLine({
          price: kl.price,
          color: colorByKind[kl.kind] ?? '#475569',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: kl.label,
        })
      }
    }

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
        const time = snapToBar(closeSec, intervalSec)
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

    // Center the position horizontally around entryTime using logical indices.
    // On 5m TF use a wider window than on 1h — same covered time (~1.5 days each side)
    // and a slightly smaller zoom so price action is easier to read.
    // On narrow (mobile) screens use fewer bars — more zoom.
    // lightweight-charts needs rightOffset to extend the axis past the last candle,
    // so we also push rightOffset high enough to cover HALF_BARS of empty future.
    // Center entry horizontally by fixing barSpacing and rightOffset.
    // TOTAL_BARS = desired number of bars visible across the container width.
    // Entry is placed at ~50% — we calculate rightOffset so the position marker
    // lands in the middle: rightOffset = halfBars - (bars between entry and last candle).
    const applyView = () => {
      try {
        const container = containerRef.current
        if (!container) return
        const isMobile = container.clientWidth < 768
        const TOTAL_BARS = interval === '5m'
          ? (isMobile ? 60 : 150)
          : (isMobile ? 30 : 60)
        const halfBars = Math.round(TOTAL_BARS / 2)

        // Anchor = entry for open/new, midpoint(entry, closed) for closed.
        let anchorTime: number = entryTime
        if (closedSec != null) {
          anchorTime = Math.round((entryTime + snapToBar(closedSec, intervalSec)) / 2)
        }
        const lastK = klines[klines.length - 1]
        const barsAnchorToLast = Math.round((lastK.time - anchorTime) / intervalSec)
        const rightOffset = halfBars - barsAnchorToLast

        const barSpacing = container.clientWidth / TOTAL_BARS
        chart.timeScale().applyOptions({
          rightOffset,
          barSpacing,
        })
      } catch {
        chart.timeScale().fitContent()
      }
    }
    applyView()
    // Re-apply after layout settles — on mobile the container may report a
    // smaller width during the first paint, which skews the initial zoom.
    requestAnimationFrame(applyView)
    // And once more after lightweight-charts has processed all pending series
    // updates (baseline setData, etc.) which can otherwise override barSpacing.
    const t1 = setTimeout(applyView, 50)
    const t2 = setTimeout(applyView, 200)

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
      clearTimeout(t1)
      clearTimeout(t2)
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

  // Effect: draw killzone vertical bands as DOM divs absolutely positioned over the chart.
  // Uses chart.timeScale().timeToCoordinate() for accurate UTC-hour → x-pixel mapping.
  // Re-renders on visible range / resize so bands stay aligned.
  useEffect(() => {
    if (klines.length === 0) return
    const overlay = overlayRef.current
    const chart = chartRef.current
    if (!overlay || !chart) return

    const timeScale = chart.timeScale()

    function render() {
      if (!overlay || !chart) return
      const range = timeScale.getVisibleRange()
      if (!range) return
      const fromMs = (range.from as number) * 1000
      const toMs = (range.to as number) * 1000

      // Build killzone segments for every UTC day in visible range
      type Segment = { startMs: number; endMs: number; color: string; label: string }
      const segments: Segment[] = []
      const dayMs = 24 * 60 * 60 * 1000
      const firstDayStart = Math.floor(fromMs / dayMs) * dayMs - dayMs
      const lastDayStart = Math.ceil(toMs / dayMs) * dayMs + dayMs
      for (let d = firstDayStart; d <= lastDayStart; d += dayMs) {
        for (const kz of KILLZONE_RANGES) {
          if (kz.startHour < kz.endHour) {
            const s = d + kz.startHour * 60 * 60 * 1000
            const e = d + kz.endHour * 60 * 60 * 1000
            if (e >= fromMs && s <= toMs) segments.push({ startMs: s, endMs: e, color: kz.color, label: kz.label })
          } else {
            // Wrap midnight (Asian: 23-04). Two segments per day.
            const s1 = d + kz.startHour * 60 * 60 * 1000
            const e1 = d + dayMs
            if (e1 >= fromMs && s1 <= toMs) segments.push({ startMs: s1, endMs: e1, color: kz.color, label: kz.label })
            const s2 = d
            const e2 = d + kz.endHour * 60 * 60 * 1000
            if (e2 >= fromMs && s2 <= toMs) segments.push({ startMs: s2, endMs: e2, color: kz.color, label: kz.label })
          }
        }
      }

      // Render
      overlay.innerHTML = ''
      const overlayWidth = overlay.clientWidth
      for (const seg of segments) {
        const x1 = timeScale.timeToCoordinate((seg.startMs / 1000) as UTCTimestamp)
        const x2 = timeScale.timeToCoordinate((seg.endMs / 1000) as UTCTimestamp)
        if (x1 == null || x2 == null) continue
        const left = Math.max(0, Math.min(overlayWidth, x1))
        const right = Math.max(0, Math.min(overlayWidth, x2))
        const width = right - left
        if (width <= 0) continue
        const div = document.createElement('div')
        div.style.position = 'absolute'
        div.style.left = `${left}px`
        div.style.top = '0'
        div.style.width = `${width}px`
        div.style.height = '100%'
        div.style.background = seg.color
        div.style.pointerEvents = 'none'
        overlay.appendChild(div)
      }
    }

    render()
    timeScale.subscribeVisibleTimeRangeChange(render)
    const resizeObs = new ResizeObserver(render)
    if (containerRef.current) resizeObs.observe(containerRef.current)

    return () => {
      timeScale.unsubscribeVisibleTimeRangeChange(render)
      resizeObs.disconnect()
      if (overlay) overlay.innerHTML = ''
    }
  }, [klines.length])

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
      rightEdge = (snapToBar(closedSec, intervalSec) + CLOSED_TAIL_BARS * intervalSec) as UTCTimestamp
    } else if (latestKlineTime > 0) {
      rightEdge = (snapToBar(latestKlineTime, intervalSec) + FUTURE_BARS * intervalSec) as UTCTimestamp
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

  const headerTitle = position.title || position.coin.replace('USDT', '')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 md:p-4"
      onClick={onClose}
    >
      <div
        className="bg-primary border-0 md:border md:border-card rounded-none md:rounded-lg shadow-2xl flex flex-col w-screen h-[100dvh] md:w-[90vw] md:h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 md:px-4 py-2 md:py-3 border-b border-card flex-shrink-0 gap-2">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <h3 className="text-text-primary font-semibold text-sm md:text-base truncate">{headerTitle}</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-bold flex-shrink-0 ${isLong ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}>
              {position.type}
            </span>
            <span className="hidden md:inline text-text-secondary text-xs font-mono">{interval} · Bybit</span>
          </div>
          <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
            <div className="flex items-center bg-input rounded overflow-hidden text-xs">
              {(['5m', '1h'] as ChartInterval[]).map(iv => (
                <button
                  key={iv}
                  onClick={() => setChartInterval(iv)}
                  className={`px-2.5 py-1 transition-colors ${interval === iv ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
                  title={`Переключить на ${iv}`}
                >
                  {iv}
                </button>
              ))}
            </div>
            <a
              href={`https://www.tradingview.com/chart/?symbol=BYBIT:${symbol}.P`}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:inline text-text-secondary hover:text-accent text-xs transition-colors"
              title="Открыть в TradingView"
            >
              TV ↗
            </a>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary p-2 md:p-1"
              title="Закрыть (Esc)"
            >
              <svg className="w-7 h-7 md:w-[18px] md:h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          <div ref={containerRef} className="w-full h-full relative">
            {/* Killzone bands overlay (drawn by effect below) */}
            <div ref={overlayRef} className="absolute inset-0 pointer-events-none" />
          </div>
        </div>
      </div>
    </div>
  )
}
