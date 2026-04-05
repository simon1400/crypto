import { useState, useEffect, useRef } from 'react'
import { createChart, IChartApi, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import { DrawingManager, getToolRegistry, SerializedDrawing } from 'lightweight-charts-drawing'
import { getKlines, KlineData } from '../api/client'
import DrawingToolbar from '../components/backtester/DrawingToolbar'
import ReplayControls from '../components/backtester/ReplayControls'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D']

function getStorageKey(sym: string, interval: string): string {
  return `drawings_${sym}_${interval}`
}

function saveDrawings(manager: DrawingManager, sym: string, interval: string): void {
  try {
    const data = manager.exportDrawings()
    localStorage.setItem(getStorageKey(sym, interval), JSON.stringify(data))
  } catch (e) {
    console.warn('[Backtester] Failed to save drawings:', e)
  }
}

function loadDrawings(manager: DrawingManager, sym: string, interval: string): void {
  try {
    const raw = localStorage.getItem(getStorageKey(sym, interval))
    if (!raw) return
    const data: SerializedDrawing[] = JSON.parse(raw)
    const registry = getToolRegistry()
    manager.importDrawings(data, (type, d) => {
      return registry.createDrawing(type, d.id, d.anchors, d.style, d.options)
    })
  } catch (e) {
    console.warn('[Backtester] Failed to load drawings:', e)
  }
}

export default function Backtester() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [inputSymbol, setInputSymbol] = useState('BTCUSDT')
  const [tf, setTf] = useState('1h')
  const [klines, setKlines] = useState<KlineData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTool, setActiveTool] = useState<string | null>(null)

  // Replay state
  const [allCandles, setAllCandles] = useState<KlineData[]>([])
  const [replayMode, setReplayMode] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const managerRef = useRef<DrawingManager | null>(null)
  const candleSeriesRef = useRef<any>(null)
  const volumeSeriesRef = useRef<any>(null)
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load data when symbol or tf changes
  useEffect(() => {
    setLoading(true)
    setError('')
    getKlines(symbol, tf, 1000)
      .then(response => {
        setKlines(response.data)
        setAllCandles(response.data)
        // Exit replay mode when data reloads
        setReplayMode(false)
        setIsPlaying(false)
        setCurrentIndex(0)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
        setKlines([])
        setAllCandles([])
      })
  }, [symbol, tf])

  // Render chart when klines change
  useEffect(() => {
    if (klines.length === 0 || !containerRef.current) return

    // Save drawings before chart rebuild
    if (managerRef.current) {
      saveDrawings(managerRef.current, symbol, tf)
      managerRef.current.detach()
      managerRef.current = null
    }

    // Cleanup previous chart
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 500,
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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
    })

    candleSeries.setData(
      klines.map(k => ({
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
      klines.map(k => ({
        time: k.time as any,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)',
      }))
    )

    chart.timeScale().fitContent()
    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    // Attach DrawingManager
    const manager = new DrawingManager()
    manager.attach(chart, candleSeries, containerRef.current)
    managerRef.current = manager

    // Restore drawings from localStorage
    loadDrawings(manager, symbol, tf)

    // Auto-save on any drawing change
    const unsubs = [
      manager.on('drawing:added', () => saveDrawings(manager, symbol, tf)),
      manager.on('drawing:updated', () => saveDrawings(manager, symbol, tf)),
      manager.on('drawing:removed', () => saveDrawings(manager, symbol, tf)),
      manager.on('drawing:cleared', () => saveDrawings(manager, symbol, tf)),
    ]

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
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
    }
  }, [klines])

  // Auto-play useEffect
  useEffect(() => {
    if (!isPlaying || !replayMode) {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
        playIntervalRef.current = null
      }
      return
    }

    const intervalMs = 1000 / speed // 1x=1000ms, 2x=500ms, 5x=200ms, 10x=100ms

    playIntervalRef.current = setInterval(() => {
      setCurrentIndex(prev => {
        const next = prev + 1
        if (next >= allCandles.length) {
          setIsPlaying(false)
          return prev
        }
        const k = allCandles[next]
        if (candleSeriesRef.current) {
          candleSeriesRef.current.update({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close })
        }
        if (volumeSeriesRef.current) {
          volumeSeriesRef.current.update({ time: k.time as any, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)' })
        }
        chartRef.current?.timeScale().scrollToRealTime()
        return next
      })
    }, intervalMs)

    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
        playIntervalRef.current = null
      }
    }
  }, [isPlaying, speed, replayMode, allCandles])

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

  function displayCandles(idx: number) {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return
    const visible = allCandles.slice(0, idx + 1)
    candleSeriesRef.current.setData(
      visible.map(k => ({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close }))
    )
    volumeSeriesRef.current.setData(
      visible.map(k => ({
        time: k.time as any,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)',
      }))
    )
    chartRef.current?.timeScale().scrollToRealTime()
  }

  function handleStartReplay(dateStr: string) {
    if (!dateStr) return
    // Reset from current position
    if (currentIndex > 0) setCurrentIndex(0)
    const ts = Math.floor(new Date(dateStr).getTime() / 1000)
    let idx = allCandles.findIndex(c => c.time >= ts)
    if (idx === -1) {
      setError('Дата за пределами данных')
      return
    }
    if (idx === 0) idx = 1 // need at least 1 visible candle
    setReplayMode(true)
    setCurrentIndex(idx)
    setIsPlaying(false)
    setSpeed(1)
    displayCandles(idx)
  }

  function handlePlay() {
    setIsPlaying(true)
  }

  function handlePause() {
    setIsPlaying(false)
  }

  function handleStep() {
    if (!replayMode) return
    const atEnd = currentIndex >= allCandles.length - 1
    if (atEnd) return
    const next = currentIndex + 1
    setCurrentIndex(next)
    const k = allCandles[next]
    if (candleSeriesRef.current) {
      candleSeriesRef.current.update({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close })
    }
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.update({ time: k.time as any, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)' })
    }
    chartRef.current?.timeScale().scrollToRealTime()
  }

  function handleSpeedChange(s: number) {
    setSpeed(s)
  }

  function handleExitReplay() {
    if (!replayMode) return
    setReplayMode(false)
    setIsPlaying(false)
    setCurrentIndex(0)
    displayCandles(allCandles.length - 1)
  }

  function handleSelectTool(tool: string | null) {
    setActiveTool(tool)
    if (managerRef.current) {
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
    managerRef.current.clearAll()
    localStorage.removeItem(getStorageKey(symbol, tf))
  }

  function loadSymbol() {
    const trimmed = inputSymbol.toUpperCase().trim()
    if (trimmed) setSymbol(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') loadSymbol()
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-text-primary mb-4">Бэктестер</h1>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
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

      {/* Current symbol + interval display */}
      <div className="flex items-center gap-2 mb-2 text-sm text-text-secondary">
        <span className="font-mono text-text-primary font-semibold">{symbol}</span>
        <span>·</span>
        <span>{tf}</span>
        <span>·</span>
        <span>{klines.length} свечей</span>
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
      />

      {/* Replay controls */}
      <ReplayControls
        replayMode={replayMode}
        isPlaying={isPlaying}
        speed={speed}
        currentIndex={currentIndex}
        totalCandles={allCandles.length}
        onStartReplay={handleStartReplay}
        onPlay={handlePlay}
        onPause={handlePause}
        onStep={handleStep}
        onSpeedChange={handleSpeedChange}
        onExit={handleExitReplay}
      />

      {/* Chart container */}
      <div ref={containerRef} className="rounded-lg overflow-hidden border border-card" />
    </div>
  )
}
