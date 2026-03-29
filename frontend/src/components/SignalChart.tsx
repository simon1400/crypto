import { useEffect, useRef } from 'react'
import { createChart, IChartApi, LineStyle, LineSeries } from 'lightweight-charts'
import { Signal } from '../api/client'

interface Props {
  signal: Signal
}

export default function SignalChart({ signal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Only show chart after entry is filled
    if (!signal.entryFilledAt || signal.priceHistory.length < 2) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 280,
      layout: {
        background: { color: '#1e2329' },
        textColor: '#848e9c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#2b3139' },
        horzLines: { color: '#2b3139' },
      },
      crosshair: {
        horzLine: { color: '#f0b90b', labelBackgroundColor: '#f0b90b' },
        vertLine: { color: '#f0b90b', labelBackgroundColor: '#f0b90b' },
      },
      timeScale: {
        timeVisible: true,
        borderColor: '#2b3139',
      },
      rightPriceScale: {
        borderColor: '#2b3139',
      },
    })

    chartRef.current = chart

    // Price line
    const priceSeries = chart.addSeries(LineSeries, {
      color: '#eaecef',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        minMove: 0.00001,
        precision: 5,
      },
    })

    // Filter price history from entry time onwards
    const entryTime = new Date(signal.entryFilledAt!).getTime()
    const filteredHistory = signal.priceHistory
      .filter(p => p.time >= entryTime)
      .map(p => ({
        time: Math.floor(p.time / 1000) as any,
        value: p.price,
      }))

    if (filteredHistory.length > 0) {
      priceSeries.setData(filteredHistory)
    }

    // Entry zone — horizontal lines
    priceSeries.createPriceLine({
      price: signal.entryMin,
      color: '#f0b90b',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Entry',
    })
    if (signal.entryMin !== signal.entryMax) {
      priceSeries.createPriceLine({
        price: signal.entryMax,
        color: '#f0b90b',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Entry',
      })
    }

    // Stop Loss line
    priceSeries.createPriceLine({
      price: signal.stopLoss,
      color: '#f6465d',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: 'SL',
    })

    // Take Profit lines
    const tpColors = ['#0ecb81', '#00a86b', '#009060', '#007a50', '#006040']
    signal.takeProfits.forEach((tp, i) => {
      priceSeries.createPriceLine({
        price: tp,
        color: tpColors[i] || tpColors[tpColors.length - 1],
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `TP${i + 1}`,
      })
    })

    chart.timeScale().fitContent()

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
  }, [signal])

  if (!signal.entryFilledAt || signal.priceHistory.length < 2) {
    return (
      <div className="bg-input rounded-lg p-6 text-center text-text-secondary text-sm">
        График появится после того как цена войдёт в зону входа
      </div>
    )
  }

  return <div ref={containerRef} className="rounded-lg overflow-hidden" />
}
