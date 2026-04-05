import { useState } from 'react'

interface ReplayControlsProps {
  replayMode: boolean
  isPlaying: boolean
  speed: number
  currentIndex: number
  totalCandles: number
  onStartReplay: (dateStr: string) => void
  onPlay: () => void
  onPause: () => void
  onStep: () => void
  onSpeedChange: (speed: number) => void
  onExit: () => void
}

const SPEEDS = [1, 2, 5, 10]

const today = new Date().toISOString().split('T')[0]

export default function ReplayControls({
  replayMode,
  isPlaying,
  speed,
  currentIndex,
  totalCandles,
  onStartReplay,
  onPlay,
  onPause,
  onStep,
  onSpeedChange,
  onExit,
}: ReplayControlsProps) {
  const [dateValue, setDateValue] = useState('')

  if (!replayMode) {
    return (
      <div className="flex items-center gap-2 bg-card rounded-lg px-2 py-1 mb-2">
        <span className="text-xs text-text-secondary font-medium mr-1">Реплей:</span>
        <input
          type="date"
          value={dateValue}
          max={today}
          onChange={e => setDateValue(e.target.value)}
          className="bg-input text-text-primary border border-card rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-accent transition-colors"
        />
        <button
          onClick={() => onStartReplay(dateValue)}
          disabled={!dateValue}
          className="px-3 py-1.5 rounded text-xs font-medium transition-colors bg-accent text-primary hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Replay
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 bg-card rounded-lg px-2 py-1 mb-2 flex-wrap">
      {/* Play/Pause buttons */}
      {!isPlaying && (
        <button
          onClick={onPlay}
          className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-long hover:bg-long/10"
        >
          &#9654; Play
        </button>
      )}
      {isPlaying && (
        <button
          onClick={onPause}
          className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-accent hover:bg-accent/10"
        >
          &#9646;&#9646; Pause
        </button>
      )}

      {/* Step button */}
      <button
        onClick={onStep}
        disabled={isPlaying}
        className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        &gt;| Step
      </button>

      <div className="border-r border-card h-5 mx-1" />

      {/* Speed selector */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-text-secondary mr-1">Скорость:</span>
        {SPEEDS.map(s => (
          <button
            key={s}
            onClick={() => onSpeedChange(s)}
            className={`px-2 py-1.5 rounded text-xs font-medium border transition-colors ${
              speed === s
                ? 'bg-accent/20 text-accent border-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-input'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>

      <div className="border-r border-card h-5 mx-1" />

      {/* Progress */}
      <span className="text-xs text-text-secondary font-mono">
        {currentIndex + 1} / {totalCandles}
      </span>

      <div className="ml-auto" />

      {/* Exit button */}
      <button
        onClick={onExit}
        className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-short hover:bg-short/10"
      >
        Выход
      </button>
    </div>
  )
}
