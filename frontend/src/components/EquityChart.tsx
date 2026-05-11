import { useEffect, useRef } from 'react'
import { createChart, IChartApi, ISeriesApi, AreaSeries, LineSeries } from 'lightweight-charts'

interface Props {
  data: { date: string; equity: number }[]
  startEquity?: number
  height?: number
}

export default function EquityChart({ data, startEquity, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null)
  const baselineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const lastColorUpRef = useRef<boolean | null>(null)

  // Создаём chart один раз. Перерисовка данных идёт через setData,
  // чтобы каждые 3с (livePrices tick → новая ссылка data) не было
  // remove()+createChart() — иначе layout shift сбрасывает скролл страницы.
  useEffect(() => {
    if (!containerRef.current) return

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

    const area = chart.addSeries(AreaSeries, {
      lineColor: '#0ecb81',
      topColor: 'rgba(14, 203, 129, 0.28)',
      bottomColor: 'rgba(14, 203, 129, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    areaRef.current = area

    const baseline = chart.addSeries(LineSeries, {
      color: '#848e9c',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    baselineRef.current = baseline

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
      areaRef.current = null
      baselineRef.current = null
      lastColorUpRef.current = null
    }
  }, [height])

  // Обновляем данные без пересоздания chart.
  useEffect(() => {
    const area = areaRef.current
    const baseline = baselineRef.current
    const chart = chartRef.current
    if (!area || !baseline || !chart) return
    if (!data || data.length === 0) {
      area.setData([])
      baseline.setData([])
      return
    }

    const equityFirst = data[0].equity
    const equityLast = data[data.length - 1].equity
    const isUp = equityLast >= equityFirst

    if (lastColorUpRef.current !== isUp) {
      area.applyOptions({
        lineColor: isUp ? '#0ecb81' : '#f6465d',
        topColor: isUp ? 'rgba(14, 203, 129, 0.28)' : 'rgba(246, 70, 93, 0.28)',
        bottomColor: isUp ? 'rgba(14, 203, 129, 0.02)' : 'rgba(246, 70, 93, 0.02)',
      })
      lastColorUpRef.current = isUp
    }

    area.setData(data.map(d => ({ time: d.date as any, value: d.equity })))

    if (typeof startEquity === 'number' && startEquity > 0) {
      baseline.setData(data.map(d => ({ time: d.date as any, value: startEquity })))
    } else {
      baseline.setData([])
    }

    chart.timeScale().fitContent()
  }, [data, startEquity])

  if (!data || data.length === 0) {
    return (
      <div className="bg-input rounded-lg p-6 text-center text-text-secondary text-sm">
        Нет данных
      </div>
    )
  }

  return <div ref={containerRef} className="rounded overflow-hidden" />
}
