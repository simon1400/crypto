import { useState, useEffect, useRef } from 'react'
import { safeParse } from '../utils/safeParse'
import { createChart, IChartApi, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts'
import { DrawingManager, getToolRegistry } from 'lightweight-charts-drawing'
import { getKlines, KlineData } from '../api/client'
import DrawingToolbar from '../components/backtester/DrawingToolbar'
import ReplayControls from '../components/backtester/ReplayControls'
import IndicatorToolbar from '../components/backtester/IndicatorToolbar'
import TradingPanel from '../components/backtester/TradingPanel'
import TradeHistory from '../components/backtester/TradeHistory'
import { useBacktestTrading } from '../hooks/useBacktestTrading'
import { ema, rsiSeries, macdSeries } from '../lib/indicators'
import { createDarkChartOptions } from '../lib/chartConfig'
import { useDrawingPersistence } from '../hooks/useDrawingPersistence'
import { useReplay } from '../hooks/useReplay'

const SESSION_KEY = 'backtest_session'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D', 'M']


function createSubChart(container: HTMLDivElement, height: number): IChartApi {
  return createChart(container, {
    ...createDarkChartOptions({
      width: container.clientWidth,
      height,
      timeVisible: true,
      secondsVisible: false,
    }),
  } as any)
}

export default function Backtester() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [inputSymbol, setInputSymbol] = useState('BTCUSDT')
  const [tf, setTf] = useState('1h')
  const [klines, setKlines] = useState<KlineData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [fibLevels, setFibLevels] = useState<number[]>(() => {
    const saved = localStorage.getItem('fib_levels')
    return saved ? safeParse<number[]>(saved, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618], 'Backtester:fib') : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618]
  })
  const pendingAnchorsRef = useRef<{ time: any; price: number }[]>([])

  // How many anchors each tool needs
  const TOOL_ANCHORS: Record<string, number> = {
    'trend-line': 2, 'ray': 2, 'horizontal-line': 1, 'horizontal-ray': 1,
    'fib-retracement': 2, 'rectangle': 2,
    'parallel-channel': 3, 'triangle': 3,
  }

  // Drawing persistence hook
  const { saveDrawings, loadDrawings, getStorageKey } = useDrawingPersistence()

  // Replay state
  const [allCandles, setAllCandles] = useState<KlineData[]>([])

  // Indicator toggle state
  const [emaEnabled, setEmaEnabled] = useState(false)
  const [rsiEnabled, setRsiEnabled] = useState(false)
  const [macdEnabled, setMacdEnabled] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const managerRef = useRef<DrawingManager | null>(null)
  const candleSeriesRef = useRef<any>(null)
  const volumeSeriesRef = useRef<any>(null)

  // EMA refs (on main chart)
  const ema20SeriesRef = useRef<any>(null)
  const ema50SeriesRef = useRef<any>(null)

  // RSI sub-chart refs
  const rsiContainerRef = useRef<HTMLDivElement>(null)
  const rsiChartRef = useRef<IChartApi | null>(null)
  const rsiSeriesRef = useRef<any>(null)

  // MACD sub-chart refs
  const macdContainerRef = useRef<HTMLDivElement>(null)
  const macdChartRef = useRef<IChartApi | null>(null)
  const macdLineRef = useRef<any>(null)
  const macdSignalRef = useRef<any>(null)
  const macdHistRef = useRef<any>(null)

  // Session save/load state
  const [saveToast, setSaveToast] = useState(false)
  const [hasSavedSession, setHasSavedSession] = useState(() => !!localStorage.getItem(SESSION_KEY))

  // Pending session order: deferred placeOrder call until candleSeriesRef is ready
  const [pendingSessionOrder, setPendingSessionOrder] = useState<{
    type: 'LONG' | 'SHORT'
    entry: number
    sl: number
    tps: { price: number; percent: number }[]
    leverage: number
    amount: number
  } | null>(null)
  const [pendingSessionIndex, setPendingSessionIndex] = useState<number | null>(null)

  // Virtual trading hook (replayMode will be provided from useReplay below)
  const {
    activeOrder,
    currentPnl,
    closedTrades,
    checkCandle,
    updatePnl,
    placeOrder,
    cancelOrder,
  } = useBacktestTrading({ candleSeriesRef, symbol, replayMode: false })

  // Replay hook
  const {
    replayMode, setReplayMode,
    currentIndex, setCurrentIndex,
    isPlaying, setIsPlaying,
    speed,
    displayCandles,
    handleStartReplay,
    handlePlay,
    handlePause,
    handleStep,
    handleSpeedChange,
    handleExitReplay,
  } = useReplay(allCandles, { candleSeriesRef, volumeSeriesRef, chartRef }, {
    updateIndicatorsForNewCandle,
    setIndicatorData,
    checkCandle,
    updatePnl,
  })

  // Deferred price line recreation: fires once candleSeriesRef is ready and pending order is set
  useEffect(() => {
    if (!pendingSessionOrder || !candleSeriesRef.current) return
    const o = pendingSessionOrder
    placeOrder(o.type, o.entry, o.sl, o.tps, o.leverage, o.amount)
    setPendingSessionOrder(null)
  }, [pendingSessionOrder, candleSeriesRef.current])

  // Load data when symbol or tf changes
  useEffect(() => {
    // Load enough candles to cover ~6 months on any timeframe
    const candleCount: Record<string, number> = {
      '1m': 2000,  // ~1.4 days
      '5m': 2000,  // ~7 days
      '15m': 2000, // ~21 days
      '1h': 4000,  // ~166 days
      '4h': 2000,  // ~333 days
      '1D': 1000,  // ~2.7 years
      'M': 500,    // ~41 years
    }
    setLoading(true)
    setError('')
    // Remember replay position (timestamp) before reload
    const wasReplaying = replayMode
    const replayTime = wasReplaying && allCandles[currentIndex]
      ? allCandles[currentIndex].time
      : null

    getKlines(symbol, tf, candleCount[tf] || 1000)
      .then(response => {
        setKlines(response.data)
        setAllCandles(response.data)

        if (wasReplaying && replayTime && response.data.length > 0) {
          // Find nearest candle to the replay timestamp in new TF
          let idx = response.data.findIndex((c: KlineData) => c.time >= replayTime)
          if (idx === -1) idx = response.data.length - 1
          if (idx === 0) idx = 1
          setCurrentIndex(idx)
          setIsPlaying(false)
          // replayMode stays true
        } else {
          setReplayMode(false)
          setIsPlaying(false)
          setCurrentIndex(0)
        }
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
        setKlines([])
        setAllCandles([])
      })
  }, [symbol, tf])

  // Deferred session index restoration: fires when klines reload after cross-symbol session load
  useEffect(() => {
    if (pendingSessionIndex === null || allCandles.length === 0) return
    setReplayMode(true)
    setIsPlaying(false)
    const idx = Math.min(pendingSessionIndex, allCandles.length - 1)
    setCurrentIndex(idx)
    displayCandles(idx)
    setPendingSessionIndex(null)
  }, [allCandles, pendingSessionIndex])

  // Helper: compute and set all indicator data from a candle array
  function setIndicatorData(candles: KlineData[]): void {
    if (candles.length === 0) return
    const closes = candles.map(c => c.close)

    // EMA 20
    if (ema20SeriesRef.current) {
      if (emaEnabled) {
        const ema20Arr = ema(closes, 20)
        ema20SeriesRef.current.setData(
          candles.map((c, i) => ({ time: c.time as any, value: ema20Arr[i] }))
        )
      } else {
        ema20SeriesRef.current.setData([])
      }
    }

    // EMA 50
    if (ema50SeriesRef.current) {
      if (emaEnabled) {
        const ema50Arr = ema(closes, 50)
        ema50SeriesRef.current.setData(
          candles.map((c, i) => ({ time: c.time as any, value: ema50Arr[i] }))
        )
      } else {
        ema50SeriesRef.current.setData([])
      }
    }

    // RSI
    if (rsiSeriesRef.current && rsiEnabled) {
      const rsiArr = rsiSeries(closes, 14)
      rsiSeriesRef.current.setData(
        candles.map((c, i) => ({ time: c.time as any, value: rsiArr[i] }))
      )
    }

    // MACD
    if (macdLineRef.current && macdSignalRef.current && macdHistRef.current && macdEnabled) {
      const { macd, signal, histogram } = macdSeries(closes)
      macdLineRef.current.setData(
        candles.map((c, i) => ({ time: c.time as any, value: macd[i] }))
      )
      macdSignalRef.current.setData(
        candles.map((c, i) => ({ time: c.time as any, value: signal[i] }))
      )
      macdHistRef.current.setData(
        candles.map((c, i) => ({
          time: c.time as any,
          value: histogram[i],
          color: histogram[i] >= 0 ? '#0ecb81' : '#f6465d',
        }))
      )
    }
  }

  // Helper: update indicator data for a single new candle during replay
  function updateIndicatorsForNewCandle(candles: KlineData[], newIndex: number): void {
    if (newIndex < 0 || newIndex >= candles.length) return
    const visible = candles.slice(0, newIndex + 1)
    const closes = visible.map(c => c.close)
    const newCandle = candles[newIndex]

    // EMA 20
    if (ema20SeriesRef.current && emaEnabled) {
      const ema20Arr = ema(closes, 20)
      ema20SeriesRef.current.update({ time: newCandle.time as any, value: ema20Arr[ema20Arr.length - 1] })
    }

    // EMA 50
    if (ema50SeriesRef.current && emaEnabled) {
      const ema50Arr = ema(closes, 50)
      ema50SeriesRef.current.update({ time: newCandle.time as any, value: ema50Arr[ema50Arr.length - 1] })
    }

    // RSI
    if (rsiSeriesRef.current && rsiEnabled) {
      const rsiArr = rsiSeries(closes, 14)
      rsiSeriesRef.current.update({ time: newCandle.time as any, value: rsiArr[rsiArr.length - 1] })
    }

    // MACD
    if (macdLineRef.current && macdSignalRef.current && macdHistRef.current && macdEnabled) {
      const { macd, signal, histogram } = macdSeries(closes)
      const lastMacd = macd[macd.length - 1]
      const lastSignal = signal[signal.length - 1]
      const lastHist = histogram[histogram.length - 1]
      macdLineRef.current.update({ time: newCandle.time as any, value: lastMacd })
      macdSignalRef.current.update({ time: newCandle.time as any, value: lastSignal })
      macdHistRef.current.update({
        time: newCandle.time as any,
        value: lastHist,
        color: lastHist >= 0 ? '#0ecb81' : '#f6465d',
      })
    }
  }

  // Render chart when klines change
  useEffect(() => {
    if (klines.length === 0 || !containerRef.current) return

    // Cleanup previous chart (drawings saved in useEffect cleanup)
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      ema20SeriesRef.current = null
      ema50SeriesRef.current = null
    }

    const chart = createChart(containerRef.current, {
      ...createDarkChartOptions({
        width: containerRef.current.clientWidth,
        height: window.innerHeight - 275,
        timeVisible: true,
        secondsVisible: false,
        crosshairMode: 0,
      }),
    } as any)

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
    })

    // In replay mode, show only candles up to currentIndex
    const visibleCandles = replayMode && currentIndex > 0
      ? klines.slice(0, currentIndex + 1)
      : klines

    candleSeries.setData(
      visibleCandles.map(k => ({
        time: k.time as any,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }))
    )

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    })

    volumeSeries.setData(
      visibleCandles.map(k => ({
        time: k.time as any,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)',
      }))
    )

    // EMA 20 overlay on main chart
    const ema20Series = chart.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    })

    // EMA 50 overlay on main chart
    const ema50Series = chart.addSeries(LineSeries, {
      color: '#e040fb',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    })

    ema20SeriesRef.current = ema20Series
    ema50SeriesRef.current = ema50Series

    chart.timeScale().fitContent()
    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    // Attach DrawingManager
    const manager = new DrawingManager()
    manager.attach(chart, candleSeries, containerRef.current!)
    managerRef.current = manager

    // Disable chart dragging when a drawing is selected (prevents conflict)
    manager.on('drawing:selected', () => {
      chart.applyOptions({
        handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
      })
    })
    manager.on('drawing:deselected', () => {
      // Only re-enable if no active tool
      if (!managerRef.current?.getActiveTool()) {
        chart.applyOptions({
          handleScroll: true,
          handleScale: true,
        })
      }
    })
    manager.on('tool:changed', (e: any) => {
      if (e.toolType) {
        // Tool activated — disable drag
        chart.applyOptions({
          handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
          handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
        })
      } else {
        // Tool deactivated — re-enable drag
        chart.applyOptions({
          handleScroll: true,
          handleScale: true,
        })
      }
    })

    // Handle chart clicks for drawing tool placement with live preview
    let previewDrawingId: string | null = null

    chart.subscribeClick((param) => {
      const tool = managerRef.current?.getActiveTool()
      if (!tool || !param.point) return

      const time = chart.timeScale().coordinateToTime(param.point.x as any)
      const price = candleSeries.coordinateToPrice(param.point.y as any)
      if (time === null || price === null) return

      const anchor = { time, price }
      pendingAnchorsRef.current = [...pendingAnchorsRef.current, anchor]

      const needed = TOOL_ANCHORS[tool] ?? 2

      // Remove preview drawing if exists
      if (previewDrawingId && managerRef.current) {
        managerRef.current.removeDrawing(previewDrawingId)
        previewDrawingId = null
      }

      if (pendingAnchorsRef.current.length >= needed) {
        // Final drawing with all anchors
        const registry = getToolRegistry()
        const id = tool + '-' + Date.now()
        const drawing = registry.createDrawing(tool, id, pendingAnchorsRef.current.slice(0, needed))
        if (drawing && managerRef.current) {
          // Apply fib levels after creation (constructor doesn't always honor opts)
          if (tool === 'fib-retracement' && 'setFibOptions' in drawing) {
            (drawing as any).setFibOptions({ levels: fibLevels })
          }
          managerRef.current.addDrawing(drawing)
        }
        pendingAnchorsRef.current = []
      }
    })

    // Live preview: update preview drawing as mouse moves after first click
    containerRef.current!.addEventListener('mousemove', (e) => {
      const tool = managerRef.current?.getActiveTool()
      if (!tool || pendingAnchorsRef.current.length === 0) return
      const needed = TOOL_ANCHORS[tool] ?? 2
      if (pendingAnchorsRef.current.length >= needed) return

      const rect = containerRef.current!.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const time = chart.timeScale().coordinateToTime(x as any)
      const price = candleSeries.coordinateToPrice(y as any)
      if (time === null || price === null) return

      // Build preview anchors: existing + current mouse position
      const previewAnchors = [...pendingAnchorsRef.current, { time, price }]
      // For 3-point tools with only 1 anchor placed, duplicate last anchor for preview
      while (previewAnchors.length < needed) {
        previewAnchors.push({ time, price })
      }

      // Remove old preview
      if (previewDrawingId && managerRef.current) {
        managerRef.current.removeDrawing(previewDrawingId)
      }

      // Create preview drawing
      const registry = getToolRegistry()
      previewDrawingId = '__preview__'
      const preview = registry.createDrawing(tool, previewDrawingId, previewAnchors.slice(0, needed), { lineColor: 'rgba(255,255,255,0.5)', lineWidth: 1 })
      if (preview && managerRef.current) {
        if (tool === 'fib-retracement' && 'setFibOptions' in preview) {
          (preview as any).setFibOptions({ levels: fibLevels })
        }
        managerRef.current.addDrawing(preview)
      }
    })

    // Restore drawings from localStorage
    loadDrawings(manager, symbol)

    // Track if we're rebuilding chart (block saves during rebuild)
    let isAlive = true

    // Auto-save on user drawing changes only (not during rebuild)
    const unsubs = [
      manager.on('drawing:added', () => { if (isAlive) saveDrawings(manager, symbol) }),
      manager.on('drawing:updated', () => { if (isAlive) saveDrawings(manager, symbol) }),
      manager.on('drawing:removed', () => { if (isAlive) saveDrawings(manager, symbol) }),
    ]

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
        })
        if (rsiChartRef.current && rsiContainerRef.current) {
          rsiChartRef.current.applyOptions({ width: rsiContainerRef.current.clientWidth })
        }
        if (macdChartRef.current && macdContainerRef.current) {
          macdChartRef.current.applyOptions({ width: macdContainerRef.current.clientWidth })
        }
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      isAlive = false // Block all auto-saves during cleanup
      window.removeEventListener('resize', handleResize)
      unsubs.forEach(fn => fn())
      if (managerRef.current) {
        managerRef.current.detach()
        managerRef.current = null
      }
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      ema20SeriesRef.current = null
      ema50SeriesRef.current = null
    }
  }, [klines])

  // Trigger resize when sub-charts toggle (autoSize picks up container change)
  useEffect(() => {
    // Small delay to let CSS recalculate container height
    const timer = setTimeout(() => {
      if (chartRef.current) {
        chartRef.current.timeScale().fitContent()
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [rsiEnabled, macdEnabled, replayMode])

  // EMA visibility toggle
  useEffect(() => {
    if (emaEnabled) {
      setIndicatorData(klines)
    } else {
      if (ema20SeriesRef.current) ema20SeriesRef.current.setData([])
      if (ema50SeriesRef.current) ema50SeriesRef.current.setData([])
    }
  }, [emaEnabled, klines])

  // RSI sub-chart effect
  useEffect(() => {
    if (!rsiEnabled) {
      // Cleanup
      if (rsiChartRef.current) {
        rsiChartRef.current.remove()
        rsiChartRef.current = null
        rsiSeriesRef.current = null
      }
      return
    }

    // Need container and main chart to exist
    if (!rsiContainerRef.current || !chartRef.current) return

    // Create RSI chart
    const rsiChart = createSubChart(rsiContainerRef.current, 150)
    const rsiLine = rsiChart.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    })

    // 30/70 reference lines
    rsiLine.createPriceLine({ price: 30, color: '#0ecb81', lineWidth: 1, lineStyle: 2, axisLabelVisible: true })
    rsiLine.createPriceLine({ price: 70, color: '#f6465d', lineWidth: 1, lineStyle: 2, axisLabelVisible: true })

    rsiChartRef.current = rsiChart
    rsiSeriesRef.current = rsiLine

    // Set initial RSI data
    setIndicatorData(klines)

    // Time scale sync (bidirectional) with main chart
    let isSyncing = false
    const mainChart = chartRef.current

    const onMainRangeChange = (range: any) => {
      if (isSyncing || !range) return
      isSyncing = true
      rsiChart.timeScale().setVisibleRange(range)
      isSyncing = false
    }

    const onRsiRangeChange = (range: any) => {
      if (isSyncing || !range) return
      isSyncing = true
      mainChart.timeScale().setVisibleRange(range)
      isSyncing = false
    }

    mainChart.timeScale().subscribeVisibleTimeRangeChange(onMainRangeChange)
    rsiChart.timeScale().subscribeVisibleTimeRangeChange(onRsiRangeChange)

    const handleResize = () => {
      if (rsiContainerRef.current) {
        rsiChart.applyOptions({ width: rsiContainerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      mainChart.timeScale().unsubscribeVisibleTimeRangeChange(onMainRangeChange)
      rsiChart.timeScale().unsubscribeVisibleTimeRangeChange(onRsiRangeChange)
      if (rsiChartRef.current) {
        rsiChartRef.current.remove()
        rsiChartRef.current = null
        rsiSeriesRef.current = null
      }
    }
  }, [rsiEnabled, klines])

  // MACD sub-chart effect
  useEffect(() => {
    if (!macdEnabled) {
      // Cleanup
      if (macdChartRef.current) {
        macdChartRef.current.remove()
        macdChartRef.current = null
        macdLineRef.current = null
        macdSignalRef.current = null
        macdHistRef.current = null
      }
      return
    }

    // Need container and main chart to exist
    if (!macdContainerRef.current || !chartRef.current) return

    // Create MACD chart
    const macdChart = createSubChart(macdContainerRef.current, 150)
    const macdLine = macdChart.addSeries(LineSeries, {
      color: '#2196f3',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const macdSignalLine = macdChart.addSeries(LineSeries, {
      color: '#ff9800',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const macdHist = macdChart.addSeries(HistogramSeries, {
      lastValueVisible: false,
      priceLineVisible: false,
    })

    macdChartRef.current = macdChart
    macdLineRef.current = macdLine
    macdSignalRef.current = macdSignalLine
    macdHistRef.current = macdHist

    // Set initial MACD data
    setIndicatorData(klines)

    // Time scale sync (bidirectional) with main chart
    let isSyncing = false
    const mainChart = chartRef.current

    const onMainRangeChangeMacd = (range: any) => {
      if (isSyncing || !range) return
      isSyncing = true
      macdChart.timeScale().setVisibleRange(range)
      isSyncing = false
    }

    const onMacdRangeChange = (range: any) => {
      if (isSyncing || !range) return
      isSyncing = true
      mainChart.timeScale().setVisibleRange(range)
      isSyncing = false
    }

    mainChart.timeScale().subscribeVisibleTimeRangeChange(onMainRangeChangeMacd)
    macdChart.timeScale().subscribeVisibleTimeRangeChange(onMacdRangeChange)

    const handleResize = () => {
      if (macdContainerRef.current) {
        macdChart.applyOptions({ width: macdContainerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      mainChart.timeScale().unsubscribeVisibleTimeRangeChange(onMainRangeChangeMacd)
      macdChart.timeScale().unsubscribeVisibleTimeRangeChange(onMacdRangeChange)
      if (macdChartRef.current) {
        macdChartRef.current.remove()
        macdChartRef.current = null
        macdLineRef.current = null
        macdSignalRef.current = null
        macdHistRef.current = null
      }
    }
  }, [macdEnabled, klines])

  // Keyboard shortcuts for Delete and Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't intercept when typing in input
        if ((e.target as HTMLElement).tagName === 'INPUT') return
        handleDeleteSelected()
      }
      if (e.key === 'Escape') {
        handleSelectTool(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [symbol, tf])

  function saveSession() {
    const session = {
      symbol,
      tf,
      currentIndex,
      replayMode,
      activeOrder: activeOrder
        ? {
            type: activeOrder.type,
            entry: activeOrder.entry,
            sl: activeOrder.sl,
            tps: activeOrder.tps,
            leverage: activeOrder.leverage,
            amount: activeOrder.amount,
          }
        : null,
      closedTradeIds: closedTrades.map(t => t.id),
      savedAt: new Date().toISOString(),
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    setHasSavedSession(true)
    setSaveToast(true)
    setTimeout(() => setSaveToast(false), 2000)
  }

  function loadSession() {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return
    try {
      const session = safeParse<any>(raw, null, 'Backtester:session')
      if (!session) return

      // If symbol/tf differ, load the new symbol first, then session will be applied via currentIndex
      if (session.symbol !== symbol || session.tf !== tf) {
        setInputSymbol(session.symbol)
        setSymbol(session.symbol)
        setTf(session.tf)
        // Store session order for after chart/candles reload
        if (session.activeOrder) {
          setPendingSessionOrder(session.activeOrder)
        }
        // After symbol/tf change the useEffect will reload klines;
        // we can't easily resume index until data is loaded — set a flag
        // For simplicity: set currentIndex after a brief delay via a separate effect
        setPendingSessionIndex(session.currentIndex)
        return
      }

      // Same symbol/tf — restore replay position
      setReplayMode(true)
      setIsPlaying(false)
      setCurrentIndex(session.currentIndex)
      displayCandles(session.currentIndex)

      // Restore active order if present (deferred until candleSeriesRef ready)
      if (session.activeOrder) {
        setPendingSessionOrder(session.activeOrder)
      }
    } catch (e) {
      console.warn('[Backtester] Failed to load session:', e)
    }
  }

  // handleStartReplay with error display (wraps hook's handleStartReplay)
  function onStartReplay(dateStr: string) {
    const result = handleStartReplay(dateStr)
    if (result === undefined && dateStr) {
      setError('Дата за пределами данных')
    }
  }

  function handleSelectTool(tool: string | null) {
    setActiveTool(tool)
    pendingAnchorsRef.current = []
    if (managerRef.current) {
      // Remove any preview drawing
      try { managerRef.current.removeDrawing('__preview__') } catch {}
      managerRef.current.setActiveTool(tool)
    }
  }

  function handleDeleteSelected() {
    if (!managerRef.current) return
    const selected = managerRef.current.getSelectedDrawing()
    if (selected) {
      managerRef.current.removeDrawing(selected.id)
    }
  }

  function handleClearAll() {
    if (!managerRef.current) return
    localStorage.removeItem(getStorageKey(symbol))
    managerRef.current.clearAll()
  }

  function loadSymbol() {
    const trimmed = inputSymbol.toUpperCase().trim()
    if (trimmed) setSymbol(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') loadSymbol()
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Compact header row */}
      <div className="flex items-center gap-3 px-2 py-1 flex-shrink-0">
        <span className="text-lg font-semibold text-text-primary">Бэктестер</span>
        <span className="text-xs text-text-secondary font-mono">{symbol} · {tf} · {klines.length} свечей</span>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 flex-shrink-0">
        {/* Symbol input */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={inputSymbol}
            onChange={e => setInputSymbol(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="BTCUSDT"
            disabled={isPlaying}
            className="bg-input text-text-primary border border-card rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={loadSymbol}
            disabled={isPlaying}
            className="px-4 py-2 bg-accent text-primary rounded-lg font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Загрузить
          </button>
        </div>

        {/* Timeframe buttons */}
        <div className="flex items-center gap-1">
          {INTERVALS.map(i => (
            <button
              key={i}
              onClick={() => setTf(i)}
              disabled={isPlaying}
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                tf === i
                  ? 'bg-accent/20 text-accent border-accent'
                  : 'bg-input text-text-secondary border-transparent hover:text-text-primary'
              }`}
            >
              {i}
            </button>
          ))}
        </div>
      </div>



      {/* Error */}
      {error && (
        <div className="bg-short/10 text-short px-4 py-2 rounded-lg mb-4 text-sm">{error}</div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-text-secondary text-sm mb-2">Загрузка...</div>
      )}

      {/* Drawing toolbar */}
      <DrawingToolbar
        activeTool={activeTool}
        onSelectTool={handleSelectTool}
        onClearAll={handleClearAll}
        onDeleteSelected={handleDeleteSelected}
        fibLevels={fibLevels}
        onFibLevelsChange={(levels) => {
          setFibLevels(levels)
          localStorage.setItem('fib_levels', JSON.stringify(levels))
          // Update all existing fib-retracement drawings
          if (managerRef.current) {
            for (const d of managerRef.current.getAllDrawings()) {
              if (d.type === 'fib-retracement') {
                (d as any).setFibOptions({ levels })
              }
            }
          }
        }}
      />

      {/* Replay controls */}
      <ReplayControls
        replayMode={replayMode}
        isPlaying={isPlaying}
        speed={speed}
        currentIndex={currentIndex}
        totalCandles={allCandles.length}
        onStartReplay={onStartReplay}
        onPlay={handlePlay}
        onPause={handlePause}
        onStep={handleStep}
        onSpeedChange={handleSpeedChange}
        onExit={handleExitReplay}
      />

      {/* Session save/load buttons */}
      <div className="flex items-center gap-2 px-2 flex-shrink-0">
        {replayMode && (
          <button
            onClick={saveSession}
            className="bg-input text-text-secondary rounded-lg px-3 py-1.5 text-sm hover:text-text-primary transition-colors"
          >
            {saveToast ? 'Сохранено' : 'Сохранить сессию'}
          </button>
        )}
        {hasSavedSession && (
          <button
            onClick={loadSession}
            className="bg-input text-text-secondary rounded-lg px-3 py-1.5 text-sm hover:text-text-primary transition-colors"
          >
            Загрузить сессию
          </button>
        )}
      </div>

      {/* Indicator toolbar + session controls in one row */}
      <IndicatorToolbar
        emaEnabled={emaEnabled}
        rsiEnabled={rsiEnabled}
        macdEnabled={macdEnabled}
        onToggleEma={() => setEmaEnabled(v => !v)}
        onToggleRsi={() => setRsiEnabled(v => !v)}
        onToggleMacd={() => setMacdEnabled(v => !v)}
      />

      {/* Chart container — shrink when sub-charts are active */}
      <div ref={containerRef} className="border border-card" style={{
        height: `calc(100vh - ${replayMode ? 200 : 160}px${rsiEnabled ? ' - 155px' : ''}${macdEnabled ? ' - 155px' : ''})`
      }} />

      {/* RSI sub-chart */}
      {rsiEnabled && (
        <div ref={rsiContainerRef} className="overflow-hidden border border-card" style={{ height: '150px' }} />
      )}

      {/* MACD sub-chart */}
      {macdEnabled && (
        <div ref={macdContainerRef} className="overflow-hidden border border-card" style={{ height: '150px' }} />
      )}

      {/* Floating trading panel — bottom-left overlay */}
      {replayMode && (
        <div className="fixed bottom-4 left-4 z-50 bg-card border border-card rounded-lg shadow-2xl max-w-sm">
          <TradingPanel
            replayMode={replayMode}
            activeOrder={activeOrder}
            currentPnl={currentPnl}
            onPlace={placeOrder}
            onCancel={cancelOrder}
            lastPrice={klines.length > 0 ? klines[klines.length - 1].close : 0}
          />
        </div>
      )}

      {/* Floating trade history — bottom-right overlay, only when trades exist */}
      {closedTrades.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 bg-card border border-card rounded-lg shadow-2xl max-w-md max-h-64 overflow-auto">
          <TradeHistory
            trades={closedTrades}
            sessionPnl={closedTrades.reduce((sum, t) => sum + t.realizedPnl, 0)}
          />
        </div>
      )}
    </div>
  )
}
