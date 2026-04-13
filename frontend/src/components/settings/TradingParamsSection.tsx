interface TradingParamsSectionProps {
  positionSizePct: number
  setPositionSizePct: (v: number) => void
  dailyLossLimitPct: number
  setDailyLossLimitPct: (v: number) => void
  orderTtlMinutes: number
  setOrderTtlMinutes: (v: number) => void
  tradingMode: string
  setTradingMode: (v: string) => void
}

export default function TradingParamsSection({
  positionSizePct,
  setPositionSizePct,
  dailyLossLimitPct,
  setDailyLossLimitPct,
  orderTtlMinutes,
  setOrderTtlMinutes,
  tradingMode,
  setTradingMode,
}: TradingParamsSectionProps) {
  return (
    <section className="bg-card rounded-xl p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-6">Trading Parameters</h2>

      <div className="space-y-6">
        {/* Position Size */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="positionSize" className="text-sm font-medium text-text-primary">
              Position Size
            </label>
            <span className="font-mono text-sm text-text-primary">{positionSizePct}%</span>
          </div>
          <input
            id="positionSize"
            type="range"
            min={1}
            max={50}
            value={positionSizePct}
            onChange={(e) => setPositionSizePct(Number(e.target.value))}
            className="w-full h-1 bg-input rounded-lg appearance-none cursor-pointer accent-accent"
          />
          <div className="flex justify-between text-xs text-text-secondary mt-1">
            <span>1%</span>
            <span>50%</span>
          </div>
        </div>

        {/* Daily Loss Limit */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="dailyLoss" className="text-sm font-medium text-text-primary">
              Daily Loss Limit
            </label>
            <span className="font-mono text-sm text-text-primary">{dailyLossLimitPct}%</span>
          </div>
          <input
            id="dailyLoss"
            type="range"
            min={1}
            max={30}
            value={dailyLossLimitPct}
            onChange={(e) => setDailyLossLimitPct(Number(e.target.value))}
            className="w-full h-1 bg-input rounded-lg appearance-none cursor-pointer accent-accent"
          />
          <div className="flex justify-between text-xs text-text-secondary mt-1">
            <span>1%</span>
            <span>30%</span>
          </div>
        </div>

        {/* Order TTL */}
        <div>
          <label htmlFor="orderTtl" className="text-sm font-medium text-text-primary mb-1.5 block">
            Order TTL
          </label>
          <div className="flex items-center gap-2">
            <input
              id="orderTtl"
              type="number"
              min={5}
              max={1440}
              value={orderTtlMinutes}
              onChange={(e) => setOrderTtlMinutes(Number(e.target.value))}
              className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary w-28 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
            <span className="text-sm text-text-secondary">min</span>
          </div>
        </div>

        {/* Trading Mode */}
        <div>
          <label className="text-sm font-medium text-text-primary mb-1.5 block">
            Trading Mode
          </label>
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-secondary">Manual</span>
            <button
              type="button"
              role="switch"
              aria-checked={tradingMode === 'auto'}
              onClick={() => setTradingMode(tradingMode === 'manual' ? 'auto' : 'manual')}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                tradingMode === 'auto' ? 'bg-accent' : 'bg-input'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  tradingMode === 'auto' ? 'translate-x-5' : ''
                }`}
              />
            </button>
            <span className="text-sm text-text-secondary">Auto</span>
          </div>
        </div>
      </div>
    </section>
  )
}
