interface IndicatorToolbarProps {
  emaEnabled: boolean
  rsiEnabled: boolean
  macdEnabled: boolean
  onToggleEma: () => void
  onToggleRsi: () => void
  onToggleMacd: () => void
}

export default function IndicatorToolbar({
  emaEnabled,
  rsiEnabled,
  macdEnabled,
  onToggleEma,
  onToggleRsi,
  onToggleMacd,
}: IndicatorToolbarProps) {
  const activeClass = 'bg-accent/20 text-accent border-accent'
  const inactiveClass = 'bg-input text-text-secondary border-transparent hover:text-text-primary'

  return (
    <div className="flex items-center gap-1 mb-2">
      <span className="text-xs text-text-secondary mr-2">Индикаторы</span>
      <button
        onClick={onToggleEma}
        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${emaEnabled ? activeClass : inactiveClass}`}
      >
        EMA 20/50
      </button>
      <button
        onClick={onToggleRsi}
        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${rsiEnabled ? activeClass : inactiveClass}`}
      >
        RSI
      </button>
      <button
        onClick={onToggleMacd}
        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${macdEnabled ? activeClass : inactiveClass}`}
      >
        MACD
      </button>
    </div>
  )
}
