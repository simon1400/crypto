import { useEffect, useRef, useState } from 'react'
import { UTCTimestamp } from 'lightweight-charts'
import { getKlines, KlineData } from '../api/client'

export type ChartInterval = '5m' | '1h'

export const INTERVAL_SECONDS: Record<ChartInterval, number> = {
  '5m': 300,
  '1h': 3600,
}

// =============================================================================
// Data fetching + state management for PositionChartModal.
// Extracted so the modal component focuses purely on chart rendering.
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

// 1h candles: 24 = 1 day forward projection for open positions
export const FUTURE_BARS = 24
export const CLOSED_TAIL_BARS = 5

/** Snap a unix-seconds timestamp to the floor of a bar boundary of given interval. */
export function snapToBar(unixSec: number, intervalSec: number): UTCTimestamp {
  return (Math.floor(unixSec / intervalSec) * intervalSec) as UTCTimestamp
}

export function normalizeSymbol(coin: string): string {
  const upper = coin.toUpperCase()
  return upper.endsWith('USDT') ? upper : `${upper}USDT`
}

export function toUnix(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

/**
 * Pick a price precision that shows enough significant digits for the given price.
 * Price ~100   → 2 digits  ($102.34)
 * Price ~1     → 4 digits  ($1.2345)
 * Price ~0.03  → 5 digits  ($0.03451)
 * Price ~0.00001 → 8 digits
 */
export function pickPrecision(price: number): number {
  const p = Math.abs(price)
  if (p <= 0 || !Number.isFinite(p)) return 4
  if (p >= 1000) return 2
  if (p >= 100) return 2
  if (p >= 1) return 4
  // For sub-dollar prices, keep 3 significant digits after the first non-zero.
  const magnitude = Math.floor(Math.log10(p))
  return Math.min(8, Math.max(4, -magnitude + 3))
}

export interface UsePositionChartResult {
  klines: KlineData[]
  loading: boolean
  error: string | null
  symbol: string
  isLong: boolean
  precision: number
  isPositionOpen: boolean
  latestKlineTime: number
  interval: ChartInterval
  setInterval: (iv: ChartInterval) => void
  intervalSec: number
  // Stable primitive deps — avoids rebuilding chart on parent re-renders
  depEntry: number
  depStopLoss: number
  depTakeProfits: string
  depOpenedAt: string | null
  depClosedAt: string | null
  depCurrentPrice: number | null
  depPartials: string
  // Refs owned by hook (updated in-place; passed to modal for chart building)
  candleSeriesRef: React.MutableRefObject<any>
  profitBgRef: React.MutableRefObject<any>
  lossBgRef: React.MutableRefObject<any>
  profitFgRef: React.MutableRefObject<any>
  lossFgRef: React.MutableRefObject<any>
  diagonalRef: React.MutableRefObject<any>
  zoneEdgesRef: React.MutableRefObject<{ left: UTCTimestamp; right: UTCTimestamp } | null>
  liveCandleRef: React.MutableRefObject<{ time: number; open: number; high: number; low: number } | null>
}

export function usePositionChart(position: PositionChartPosition): UsePositionChartResult {
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
  // Track live candle OHLC so updates don't overwrite high/low
  const liveCandleRef = useRef<{ time: number; open: number; high: number; low: number } | null>(null)

  const [klines, setKlines] = useState<KlineData[]>([])
  const [latestKlineTime, setLatestKlineTime] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [interval, setChartInterval] = useState<ChartInterval>('1h')
  const intervalSec = INTERVAL_SECONDS[interval]

  const symbol = normalizeSymbol(position.coin)
  const isLong = position.type === 'LONG'
  const precision = pickPrecision(position.entry)

  // Stable primitive deps — avoid rebuilding chart when parent re-renders with a new position object.
  const depEntry = position.entry
  const depStopLoss = position.stopLoss
  const depTakeProfits = position.takeProfits.join(',')
  const depOpenedAt = position.openedAt
  const depClosedAt = position.closedAt
  const depCurrentPrice = position.currentPrice ?? null
  const depPartials = (position.partialCloses || []).map(c => `${c.closedAt}:${c.price}:${c.percent}:${c.isSL ? 1 : 0}`).join('|')

  // Fetch klines on mount, then poll every 15s while the position is still open
  // so the zone right-edge follows new candles in real time.
  const isPositionOpen = position.closedAt == null
  useEffect(() => {
    let cancelled = false

    async function fetchKlines(isInitial: boolean) {
      try {
        const res = await getKlines(symbol, interval, 500)
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
                res.data.map((k: KlineData) => ({
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
    setKlines([])
    setLatestKlineTime(0)
    fetchKlines(true)

    let timer: ReturnType<typeof setInterval> | null = null
    if (isPositionOpen) {
      timer = setInterval(() => fetchKlines(false), 15_000)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [symbol, isPositionOpen, interval])

  return {
    klines,
    loading,
    error,
    symbol,
    isLong,
    precision,
    isPositionOpen,
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
  }
}
