import { useEffect, useRef, useState } from 'react'
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
import { getKlines, KlineData } from '../api/client'

// =============================================================================
// Position overlay modal: renders a TradingView-style Long/Short Position tool
// on top of a 1h candlestick chart. Reused by Trades and Scanner pages.
// =============================================================================

export interface PositionChartPosition {
  coin: string                               // "BTC" or "BTCUSDT" — both supported
  type: 'LONG' | 'SHORT'
  entry: number
  stopLoss: number
  takeProfits: number[]                      // sorted in trade direction (LONG: asc, SHORT: desc)
  openedAt: string | null                    // ISO; null for NEW scanner signals (not taken yet)
  closedAt: string | null                    // ISO; null if still open
  currentPrice?: number | null               // live price for open positions, final price for closed
  partialCloses?: { price: number; percent: number; closedAt: string; isSL?: boolean }[]
  // optional display-only fields
  title?: string                             // modal header override
}

interface Props {
  position: PositionChartPosition
  onClose: () => void
}

// 1h candles: 72 = 3 days forward projection for open positions
const FUTURE_BARS = 72
const CLOSED_TAIL_BARS = 5

function normalizeSymbol(coin: string): string {
  const upper = coin.toUpperCase()
  return upper.endsWith('USDT') ? upper : `${upper}USDT`
}

function toUnix(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

/** Snap a unix-seconds timestamp to the floor of a 1h candle boundary. */
function snapToHour(unixSec: number): UTCTimestamp {
  return (Math.floor(unixSec / 3600) * 3600) as UTCTimestamp
}

/**
 * Pick a price precision that shows enough significant digits for the given price.
 * Price ~100   → 2 digits  ($102.34)
 * Price ~1     → 4 digits  ($1.2345)
 * Price ~0.03  → 5 digits  ($0.03451)
 * Price ~0.00001 → 8 digits
 */
function pickPrecision(price: number): number {
  const p = Math.abs(price)
  if (p <= 0 || !Number.isFinite(p)) return 4
  if (p >= 1000) return 2
  if (p >= 100) return 2
  if (p >= 1) return 4
  // For sub-dollar prices, keep 3 significant digits after the first non-zero.
  const magnitude = Math.floor(Math.log10(p))
  return Math.min(8, Math.max(4, -magnitude + 3))
}

export default function PositionChartModal({ position, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  // Candle series ref — updated in place when new klines arrive.
  const candleSeriesRef = useRef<any>(null)
  // Overlay baseline series refs — updated in place without rebuilding the chart.
  const profitBgRef = useRef<any>(null)
  const lossBgRef = useRef<any>(null)
  const profitFgRef = useRef<any>(null)
  const lossFgRef = useRef<any>(null)
  const diagonalRef = useRef<any>(null)
  // Zone time anchors, stable across live updates
  const zoneEdgesRef = useRef<{ left: UTCTimestamp; right: UTCTimestamp } | null>(null)
  const [klines, setKlines] = useState<KlineData[]>([])
  const [latestKlineTime, setLatestKlineTime] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const symbol = normalizeSymbol(position.coin)
  const isLong = position.type === 'LONG'

  // Stable primitive deps — avoid rebuilding chart when parent re-renders with a new position object.
  const depEntry = position.entry
  const depStopLoss = position.stopLoss
  const depTakeProfits = position.takeProfits.join(',')
  const depOpenedAt = position.openedAt
  const depClosedAt = position.closedAt
  const depCurrentPrice = position.currentPrice ?? null
  const depPartials = (position.partialCloses || []).map(c => `${c.closedAt}:${c.price}:${c.percent}:${c.isSL ? 1 : 0}`).join('|')

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Fetch klines on mount, then poll every 60s while the position is still open
  // so the zone right-edge follows new candles in real time.
  const isPositionOpen = position.closedAt == null
  useEffect(() => {
    let cancelled = false

    async function fetchKlines(isInitial: boolean) {
      try {
        const res = await getKlines(symbol, '1h', 500)
        if (cancelled) return
        if (isInitial) {
          setKlines(res.data)
          if (res.data.length > 0) {
            setLatestKlineTime(res.data[res.data.length - 1].time)
          }
        } else {
          // Light update: only mutate candleSeries in-place, don't touch React klines state
          // (otherwise the heavy effect would rebuild the chart and lose pan/zoom).
          const candleSeries = candleSeriesRef.current
          if (candleSeries && res.data.length > 0) {
            try {
              // setData replaces all candles but doesn't reset timeScale or overlay series
              candleSeries.setData(
                res.data.map(k => ({
                  time: k.time as UTCTimestamp,
                  open: k.open,
                  high: k.high,
                  low: k.low,
                  close: k.close,
                }))
              )
            } catch {}
            // Trigger the zone-edge light effect via latestKlineTime state
            setLatestKlineTime(res.data[res.data.length - 1].time)
          }
        }
      } catch (err: any) {
        if (cancelled) return
        if (isInitial) setError(err?.message || 'Failed to load chart data')
      } finally {
        if (!cancelled && isInitial) setLoading(false)
      }
    }

    setLoading(true)
    setError(null)
    fetchKlines(true)

    let timer: ReturnType<typeof setInterval> | null = null
    if (isPositionOpen) {
      timer = setInterval(() => fetchKlines(false), 60_000)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [symbol, isPositionOpen])

  // Build chart whenever klines arrive or structural position fields change.
  // IMPORTANT: this effect does NOT depend on currentPrice — that's updated
  // by the lightweight effect below via setData, without touching the chart.
  useEffect(() => {
    if (!containerRef.current || klines.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#848e9c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e2329' },
        horzLines: { color: '#1e2329' },
      },
      crosshair: {
        mode: 0,
        horzLine: { color: '#f0b90b', labelBackgroundColor: '#f0b90b' },
        vertLine: { color: '#f0b90b', labelBackgroundColor: '#f0b90b' },
      },
      timeScale: {
        timeVisible: true,
        borderColor: '#2b3139',
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#2b3139',
      },
    })
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

    // ---- Position overlay ----
    const { entry, stopLoss, takeProfits, currentPrice } = position
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
    const GREEN_OPAQUE_1 = 'rgba(14, 203, 129, 0.38)'
    const GREEN_OPAQUE_2 = 'rgba(14, 203, 129, 0.22)'
    const GREEN_PALE_1 = 'rgba(14, 203, 129, 0.12)'
    const GREEN_PALE_2 = 'rgba(14, 203, 129, 0.06)'
    const RED_OPAQUE_1 = 'rgba(246, 70, 93, 0.38)'
    const RED_OPAQUE_2 = 'rgba(246, 70, 93, 0.22)'
    const RED_PALE_1 = 'rgba(246, 70, 93, 0.12)'
    const RED_PALE_2 = 'rgba(246, 70, 93, 0.06)'
    const TRANSPARENT = 'rgba(0, 0, 0, 0)'

    // --- Pale background: full profit zone (Entry → lastTP) ---
    // LONG: lastTP > entry → top fill green
    // SHORT: lastTP < entry → bottom fill green
    const profitBg = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: entry },
      topFillColor1: isLong ? GREEN_PALE_1 : TRANSPARENT,
      topFillColor2: isLong ? GREEN_PALE_2 : TRANSPARENT,
      topLineColor: TRANSPARENT,
      bottomFillColor1: isLong ? TRANSPARENT : GREEN_PALE_1,
      bottomFillColor2: isLong ? TRANSPARENT : GREEN_PALE_2,
      bottomLineColor: TRANSPARENT,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    profitBg.setData([
      { time: leftEdge, value: lastTP },
      { time: rightEdge, value: lastTP },
    ])
    profitBgRef.current = profitBg

    // --- Pale background: full loss zone (Entry → SL) ---
    const lossBg = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: entry },
      topFillColor1: isLong ? TRANSPARENT : RED_PALE_1,
      topFillColor2: isLong ? TRANSPARENT : RED_PALE_2,
      topLineColor: TRANSPARENT,
      bottomFillColor1: isLong ? RED_PALE_1 : TRANSPARENT,
      bottomFillColor2: isLong ? RED_PALE_2 : TRANSPARENT,
      bottomLineColor: TRANSPARENT,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    lossBg.setData([
      { time: leftEdge, value: stopLoss },
      { time: rightEdge, value: stopLoss },
    ])
    lossBgRef.current = lossBg

    // --- Opaque foreground: profit realized part ---
    // Starts empty (value = entry → zero area). Updated by the light effect below
    // when currentPrice changes, without rebuilding the chart.
    const profitFg = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: entry },
      topFillColor1: isLong ? GREEN_OPAQUE_1 : TRANSPARENT,
      topFillColor2: isLong ? GREEN_OPAQUE_2 : TRANSPARENT,
      topLineColor: TRANSPARENT,
      bottomFillColor1: isLong ? TRANSPARENT : GREEN_OPAQUE_1,
      bottomFillColor2: isLong ? TRANSPARENT : GREEN_OPAQUE_2,
      bottomLineColor: TRANSPARENT,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    profitFg.setData([
      { time: leftEdge, value: entry },
      { time: rightEdge, value: entry },
    ])
    profitFgRef.current = profitFg

    // --- Opaque foreground: loss realized part ---
    const lossFg = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: entry },
      topFillColor1: isLong ? TRANSPARENT : RED_OPAQUE_1,
      topFillColor2: isLong ? TRANSPARENT : RED_OPAQUE_2,
      topLineColor: TRANSPARENT,
      bottomFillColor1: isLong ? RED_OPAQUE_1 : TRANSPARENT,
      bottomFillColor2: isLong ? RED_OPAQUE_2 : TRANSPARENT,
      bottomLineColor: TRANSPARENT,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    lossFg.setData([
      { time: leftEdge, value: entry },
      { time: rightEdge, value: entry },
    ])
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

    // Fit the chart to content on initial build. Subsequent live-price updates
    // go through a separate effect that only mutates overlay series (no rebuild),
    // so the user's pan/zoom is never touched.
    chart.timeScale().fitContent()

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, isLong, depEntry, depStopLoss, depTakeProfits, depOpenedAt, depClosedAt, depPartials])

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
        className="bg-primary border border-card rounded-lg shadow-2xl w-full max-w-6xl flex flex-col"
        style={{ height: '85vh' }}
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
