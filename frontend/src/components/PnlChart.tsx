import { useEffect, useRef } from 'react'
import { createChart, IChartApi, AreaSeries } from 'lightweight-charts'

interface Props {
  data: { date: string; cumulativePnl: number }[]
}

export default function PnlChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (!data || data.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 250,
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
        borderColor: '#2b3139',
      },
      rightPriceScale: {
        borderColor: '#2b3139',
      },
    })

    chartRef.current = chart

    const series = chart.addSeries(AreaSeries, {
      lineColor: '#0ecb81',
      topColor: 'rgba(14, 203, 129, 0.3)',
      bottomColor: 'rgba(14, 203, 129, 0.02)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    })

    const chartData = data.map((d) => ({
      time: d.date as any,
      value: d.cumulativePnl,
    }))

    series.setData(chartData)
    chart.timeScale().fitContent()

    // ResizeObserver for auto-resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect
        chart.applyOptions({ width })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [data])

  if (!data || data.length === 0) {
    return (
      <div className="bg-input rounded-lg p-6 text-center text-text-secondary text-sm">
        No data for this period
      </div>
    )
  }

  return <div ref={containerRef} className="rounded-lg overflow-hidden" />
}
