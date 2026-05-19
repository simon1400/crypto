import {
  updateBreakoutPaperConfig,
  type BreakoutPaperConfig as PaperConfig,
  type BreakoutVariant,
} from '../../api/breakoutPaper'

interface Props {
  variant: BreakoutVariant
  isLive: boolean
  config: PaperConfig
  setConfig: (c: PaperConfig) => void
  setups: string[]
  resetAmount: number
  setResetAmount: (n: number) => void
  onReset: () => void
}

export default function SettingsPanel({
  variant, isLive, config, setConfig, setups,
  resetAmount, setResetAmount, onReset,
}: Props) {
  return (
    <div className="bg-card border border-input rounded p-4 mb-4">
      <h3 className="font-semibold mb-3">
        {isLive ? 'Настройки LIVE-счёта' : 'Настройки демо-счёта'}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Риск на сделку (%)</label>
          <input type="number" step="0.1" min="0.1" max="10" defaultValue={config.riskPctPerTrade}
            onBlur={async e => {
              const v = parseFloat(e.target.value)
              if (v > 0 && v <= 10) setConfig(await updateBreakoutPaperConfig({ riskPctPerTrade: v }, variant))
            }}
            className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
        </div>
        {/* Fee/slippage inputs are only meaningful for paper variants — they
            feed the simulator's P&L formula. In LIVE the exchange charges real
            fees on every fill, so these knobs are hidden to avoid confusion. */}
        {!isLive && (
          <>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Taker fee (%) <span className="text-text-secondary/60">— market open + SL</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.feeTakerPct ?? 0.05}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ feeTakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Maker fee (%) <span className="text-text-secondary/60">— TP limit</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.feeMakerPct ?? 0.02}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ feeMakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                Slippage taker (%/side) <span className="text-text-secondary/60">— market fills</span>
              </label>
              <input type="number" step="0.001" min="0" defaultValue={config.slipTakerPct ?? 0.03}
                onBlur={async e => {
                  const v = parseFloat(e.target.value)
                  if (v >= 0) setConfig(await updateBreakoutPaperConfig({ slipTakerPct: v }, variant))
                }}
                className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
            </div>
          </>
        )}
        <div>
          <label className="text-xs text-text-secondary block mb-1">Max одновременных позиций</label>
          <input type="number" step="1" min="1" max="50" defaultValue={config.maxConcurrentPositions}
            onBlur={async e => {
              const v = parseInt(e.target.value, 10)
              if (v > 0 && v <= 50) setConfig(await updateBreakoutPaperConfig({ maxConcurrentPositions: v }, variant))
            }}
            className="w-full bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="autoTrailing" checked={config.autoTrailingSL}
            onChange={async e => setConfig(await updateBreakoutPaperConfig({ autoTrailingSL: e.target.checked }, variant))} />
          <label htmlFor="autoTrailing" className="text-sm">Авто-трейлинг SL (TP1→BE, TP2→TP1)</label>
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-input flex items-center gap-3">
        {!isLive && (
          <input type="number" value={resetAmount}
            onChange={e => setResetAmount(parseFloat(e.target.value) || 500)}
            className="w-32 bg-input border border-input rounded px-3 py-2 text-sm font-mono" />
        )}
        <button onClick={onReset}
          className="px-4 py-2 bg-card border border-accent/40 text-accent rounded font-medium hover:bg-accent/10"
          title={isLive ? 'Сбрасывает baseline P&L до текущего баланса Binance' : undefined}>
          {isLive ? 'Сбросить baseline (= баланс с Binance)' : 'Сбросить депо'}
        </button>
      </div>
      {setups.length > 0 && (
        <div className="mt-4 pt-4 border-t border-input">
          <div className="text-xs text-text-secondary mb-2">Активные инструменты ({setups.length}):</div>
          <div className="flex flex-wrap gap-2">
            {setups.map(s => (
              <span key={s} className="px-2 py-1 rounded bg-input text-xs font-mono text-text-primary">{s.replace('USDT', '')}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
