import { useState, useRef, useEffect } from 'react'

interface DrawingToolbarProps {
  activeTool: string | null
  onSelectTool: (tool: string | null) => void
  onClearAll: () => void
  onDeleteSelected: () => void
  fibLevels: number[]
  onFibLevelsChange: (levels: number[]) => void
}

interface ToolDef {
  type: string
  label: string
}

const LINE_TOOLS: ToolDef[] = [
  { type: 'trend-line', label: 'Тренд' },
  { type: 'horizontal-line', label: 'Горизонт' },
  { type: 'horizontal-ray', label: 'Луч H' },
  { type: 'ray', label: 'Луч' },
]

const SHAPE_TOOLS: ToolDef[] = [
  { type: 'rectangle', label: 'Прямоуг' },
  { type: 'parallel-channel', label: 'Канал' },
  { type: 'triangle', label: 'Треуг' },
]

const ALL_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618]

export default function DrawingToolbar({
  activeTool,
  onSelectTool,
  onClearAll,
  onDeleteSelected,
  fibLevels,
  onFibLevelsChange,
}: DrawingToolbarProps) {
  const [showFibSettings, setShowFibSettings] = useState(false)
  const fibRef = useRef<HTMLDivElement>(null)

  // Close fib settings on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (fibRef.current && !fibRef.current.contains(e.target as Node)) {
        setShowFibSettings(false)
      }
    }
    if (showFibSettings) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [showFibSettings])

  function handleToolClick(type: string) {
    onSelectTool(activeTool === type ? null : type)
  }

  function toolClass(type: string) {
    const base = 'px-2 py-1.5 rounded text-xs font-medium transition-colors'
    if (activeTool === type) {
      return `${base} bg-accent/20 text-accent border border-accent`
    }
    return `${base} border border-transparent text-text-secondary hover:text-text-primary hover:bg-input`
  }

  function toggleFibLevel(level: number) {
    if (fibLevels.includes(level)) {
      onFibLevelsChange(fibLevels.filter(l => l !== level))
    } else {
      onFibLevelsChange([...fibLevels, level].sort((a, b) => a - b))
    }
  }

  return (
    <div className="flex items-center gap-1 bg-card rounded-lg px-2 py-1 flex-shrink-0 flex-wrap">
      {/* Lines group */}
      <div className="flex items-center gap-1">
        {LINE_TOOLS.map(tool => (
          <button
            key={tool.type}
            onClick={() => handleToolClick(tool.type)}
            className={toolClass(tool.type)}
            title={tool.label}
          >
            {tool.label}
          </button>
        ))}
      </div>

      <div className="border-r border-input h-5 mx-1" />

      {/* Fibonacci with settings */}
      <div className="relative flex items-center gap-0.5" ref={fibRef}>
        <button
          onClick={() => handleToolClick('fib-retracement')}
          className={toolClass('fib-retracement')}
          title="Фибоначчи"
        >
          Фиб
        </button>
        <button
          onClick={() => setShowFibSettings(!showFibSettings)}
          className="px-1 py-1.5 rounded text-xs text-text-secondary hover:text-accent transition-colors"
          title="Настройки уровней"
        >
          ⚙
        </button>

        {/* Fibonacci levels popup */}
        {showFibSettings && (
          <div className="absolute top-full left-0 mt-1 bg-primary border border-card rounded-lg shadow-2xl p-3 z-50 min-w-[180px]">
            <div className="text-xs text-text-primary font-medium mb-2">Уровни Фибоначчи</div>
            {ALL_FIB_LEVELS.map(level => (
              <label key={level} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fibLevels.includes(level)}
                  onChange={() => toggleFibLevel(level)}
                  className="accent-accent"
                />
                <span className="text-xs text-text-secondary font-mono">
                  {(level * 100).toFixed(2)}%
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="border-r border-input h-5 mx-1" />

      {/* Shapes group */}
      <div className="flex items-center gap-1">
        {SHAPE_TOOLS.map(tool => (
          <button
            key={tool.type}
            onClick={() => handleToolClick(tool.type)}
            className={toolClass(tool.type)}
            title={tool.label}
          >
            {tool.label}
          </button>
        ))}
      </div>

      <div className="border-r border-input h-5 mx-1" />

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={onDeleteSelected}
          className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-short hover:bg-short/10"
        >
          Удалить
        </button>
        <button
          onClick={onClearAll}
          className="px-2 py-1.5 rounded text-xs font-medium border border-transparent transition-colors text-short hover:bg-short/10"
        >
          Очистить
        </button>
      </div>
    </div>
  )
}
