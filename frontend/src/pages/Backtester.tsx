import { useState, useEffect, useRef } from 'react'
import { createChart, IChartApi, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import { getKlines, KlineData } from '../api/client'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D']

export default function Backtester() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [inputSymbol, setInputSymbol] = useState('BTCUSDT')
  const [tf, setTf] = useState('1h')
  const [klines, setKlines] = useState<KlineData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  // Load data when symbol or tf changes
  useEffect(() => {
    setLoading(true)
    setError('')
    getKlines(symbol, tf, 1000)
      .then(response => {
        setKlines(response.data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
        setKlines([])
      })
  }, [symbol, tf])

  // Render chart when klines change
  useEffect(() => {
    if (klines.length === 0 || !containerRef.current) return

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

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
    }
  }, [klines])

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
            className="bg-input text-text-primary border border-card rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-accent transition-colors"
          />
          <button
            onClick={loadSymbol}
            className="px-4 py-2 bg-accent text-primary rounded-lg font-medium hover:bg-accent/90 transition-colors"
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
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
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

      {/* Chart container */}
      <div ref={containerRef} className="rounded-lg overflow-hidden border border-card" />
    </div>
  )
}
