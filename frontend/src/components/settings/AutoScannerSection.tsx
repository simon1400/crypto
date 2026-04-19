interface AutoScannerSectionProps {
  autoScanEnabled: boolean
  setAutoScanEnabled: (v: boolean) => void
  autoScanIntervalMin: number
  setAutoScanIntervalMin: (v: number) => void
  autoScanMinScore: number
  setAutoScanMinScore: (v: number) => void
}

export default function AutoScannerSection({
  autoScanEnabled,
  setAutoScanEnabled,
  autoScanIntervalMin,
  setAutoScanIntervalMin,
  autoScanMinScore,
  setAutoScanMinScore,
}: AutoScannerSectionProps) {
  return (
    <section className="bg-card rounded-xl p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-6">Автосканер</h2>

      <p className="text-sm text-text-secondary mb-4">
        Запускает сканирование выбранных монет по интервалу. При появлении сигнала со Score ≥ порога
        шлёт оповещение в Telegram (использует тот же бот из настроек выше).
      </p>

      <div className="space-y-4">
        {/* Enable toggle */}
        <div>
          <label className="text-sm font-medium text-text-primary mb-1.5 block">
            Автосканирование
          </label>
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-secondary">Off</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoScanEnabled}
              onClick={() => setAutoScanEnabled(!autoScanEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                autoScanEnabled ? 'bg-accent' : 'bg-input'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  autoScanEnabled ? 'translate-x-5' : ''
                }`}
              />
            </button>
            <span className="text-sm text-text-secondary">On</span>
          </div>
        </div>

        {/* Interval */}
        <div>
          <label htmlFor="autoScanIntervalMin" className="text-sm font-medium text-text-primary mb-1.5 block">
            Интервал (минут)
          </label>
          <input
            id="autoScanIntervalMin"
            type="number"
            min={5}
            max={120}
            value={autoScanIntervalMin}
            onChange={(e) => setAutoScanIntervalMin(Number(e.target.value))}
            className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          />
          <p className="text-xs text-text-secondary mt-1">От 5 до 120 минут</p>
        </div>

        {/* Min Score */}
        <div>
          <label htmlFor="autoScanMinScore" className="text-sm font-medium text-text-primary mb-1.5 block">
            Min Score для оповещения
          </label>
          <input
            id="autoScanMinScore"
            type="number"
            min={50}
            max={100}
            value={autoScanMinScore}
            onChange={(e) => setAutoScanMinScore(Number(e.target.value))}
            className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          />
          <p className="text-xs text-text-secondary mt-1">
            Сигналы ниже этого порога не будут присылаться в Telegram (и не будут сохраняться как сигнал)
          </p>
        </div>
      </div>
    </section>
  )
}
