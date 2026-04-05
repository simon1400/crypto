interface DrawingToolbarProps {
  activeTool: string | null
  onSelectTool: (tool: string | null) => void
  onClearAll: () => void
  onDeleteSelected: () => void
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

const FIBONACCI_TOOLS: ToolDef[] = [
  { type: 'fib-retracement', label: 'Фиб' },
  { type: 'fib-extension', label: 'Фиб расш' },
]

const SHAPE_TOOLS: ToolDef[] = [
  { type: 'rectangle', label: 'Прямоуг' },
  { type: 'parallel-channel', label: 'Канал' },
  { type: 'triangle', label: 'Треуг' },
]

export default function DrawingToolbar({
  activeTool,
  onSelectTool,
  onClearAll,
  onDeleteSelected,
}: DrawingToolbarProps) {
  function handleToolClick(type: string) {
    // Toggle: clicking active tool deselects it
    onSelectTool(activeTool === type ? null : type)
  }

  function toolClass(type: string) {
    const base = 'px-2 py-1.5 rounded text-xs font-medium transition-colors'
    if (activeTool === type) {
      return `${base} bg-accent/20 text-accent border border-accent`
    }
    return `${base} border border-transparent text-text-secondary hover:text-text-primary hover:bg-input`
  }

  return (
    <div className="flex items-center gap-1 bg-card rounded-lg px-2 py-1 mb-2 flex-wrap">
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

      <div className="border-r border-card h-5 mx-1" />

      {/* Fibonacci group */}
      <div className="flex items-center gap-1">
        {FIBONACCI_TOOLS.map(tool => (
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

      <div className="border-r border-card h-5 mx-1" />

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

      <div className="border-r border-card h-5 mx-1" />

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
