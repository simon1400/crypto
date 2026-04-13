import { useState, useEffect, useRef, useCallback } from 'react'
import { KlineData } from '../api/client'

interface ReplayRefs {
  candleSeriesRef: React.MutableRefObject<any>
  volumeSeriesRef: React.MutableRefObject<any>
  chartRef: React.MutableRefObject<any>
}

interface ReplayCallbacks {
  updateIndicatorsForNewCandle: (candles: KlineData[], newIndex: number) => void
  setIndicatorData: (candles: KlineData[]) => void
  checkCandle: (candle: KlineData) => void
  updatePnl: (price: number) => void
}

export function useReplay(
  allCandles: KlineData[],
  refs: ReplayRefs,
  callbacks: ReplayCallbacks,
) {
  const [replayMode, setReplayMode] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // displayCandles helper -- shows candles up to idx
  const displayCandles = useCallback((idx: number) => {
    if (!refs.candleSeriesRef.current || !refs.volumeSeriesRef.current) return
    const visible = allCandles.slice(0, idx + 1)
    refs.candleSeriesRef.current.setData(
      visible.map((k: KlineData) => ({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close }))
    )
    refs.volumeSeriesRef.current.setData(
      visible.map((k: KlineData) => ({
        time: k.time as any,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)',
      }))
    )
    callbacks.setIndicatorData(visible)
    refs.chartRef.current?.timeScale().scrollToRealTime()
  }, [allCandles, refs, callbacks])

  // Auto-play interval effect
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
        if (refs.candleSeriesRef.current) {
          refs.candleSeriesRef.current.update({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close })
        }
        if (refs.volumeSeriesRef.current) {
          refs.volumeSeriesRef.current.update({ time: k.time as any, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)' })
        }
        callbacks.updateIndicatorsForNewCandle(allCandles, next)
        callbacks.checkCandle(allCandles[next])
        callbacks.updatePnl(allCandles[next].close)
        refs.chartRef.current?.timeScale().scrollToRealTime()
        return next
      })
    }, intervalMs)

    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
        playIntervalRef.current = null
      }
    }
  }, [isPlaying, speed, replayMode, allCandles, callbacks.checkCandle, callbacks.updatePnl])

  function handleStartReplay(dateStr: string) {
    if (!dateStr) return
    if (currentIndex > 0) setCurrentIndex(0)
    const ts = Math.floor(new Date(dateStr).getTime() / 1000)
    let idx = allCandles.findIndex(c => c.time >= ts)
    if (idx === -1) return // caller should handle error display
    if (idx === 0) idx = 1 // need at least 1 visible candle
    setReplayMode(true)
    setCurrentIndex(idx)
    setIsPlaying(false)
    setSpeed(1)
    displayCandles(idx)
    return idx
  }

  function handlePlay() { setIsPlaying(true) }
  function handlePause() { setIsPlaying(false) }

  function handleStep() {
    if (!replayMode) return
    if (currentIndex >= allCandles.length - 1) return
    const next = currentIndex + 1
    setCurrentIndex(next)
    const k = allCandles[next]
    if (refs.candleSeriesRef.current) {
      refs.candleSeriesRef.current.update({ time: k.time as any, open: k.open, high: k.high, low: k.low, close: k.close })
    }
    if (refs.volumeSeriesRef.current) {
      refs.volumeSeriesRef.current.update({ time: k.time as any, value: k.volume, color: k.close >= k.open ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)' })
    }
    callbacks.updateIndicatorsForNewCandle(allCandles, next)
    callbacks.checkCandle(allCandles[next])
    callbacks.updatePnl(allCandles[next].close)
    refs.chartRef.current?.timeScale().scrollToRealTime()
  }

  function handleSpeedChange(s: number) { setSpeed(s) }

  function handleExitReplay() {
    if (!replayMode) return
    setReplayMode(false)
    setIsPlaying(false)
    setCurrentIndex(0)
    displayCandles(allCandles.length - 1)
  }

  return {
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
  }
}
