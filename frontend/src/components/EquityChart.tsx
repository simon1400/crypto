import { useEffect, useRef } from 'react'
import { createChart, IChartApi, AreaSeries, LineSeries } from 'lightweight-charts'

interface Props {
  data: { date: string; equity: number }[]
  startEquity?: number
  height?: number
}

export default function EquityChart({ data, startEquity, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    if (!data || data.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
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
        timeVisible: false,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#2b3139',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
    })

    chartRef.current = chart

    const equityFirst = data[0].equity
    const equityLast = data[data.length - 1].equity
    const isUp = equityLast >= equityFirst
    const lineColor = isUp ? '#0ecb81' : '#f6465d'
    const topColor = isUp ? 'rgba(14, 203, 129, 0.28)' : 'rgba(246, 70, 93, 0.28)'
    const bottomColor = isUp ? 'rgba(14, 203, 129, 0.02)' : 'rgba(246, 70, 93, 0.02)'

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })

    series.setData(data.map(d => ({ time: d.date as any, value: d.equity })))

    if (typeof startEquity === 'number' && startEquity > 0) {
      const baseline = chart.addSeries(LineSeries, {
        color: '#848e9c',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      baseline.setData(data.map(d => ({ time: d.date as any, value: startEquity })))
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [data, startEquity, height])

  if (!data || data.length === 0) {
    return (
      <div className="bg-input rounded-lg p-6 text-center text-text-secondary text-sm">
        Нет данных
      </div>
    )
  }

  return <div ref={containerRef} className="rounded overflow-hidden" />
}
