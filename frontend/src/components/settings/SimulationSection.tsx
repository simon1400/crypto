interface FeeSectionProps {
  takerFeeRate: number
  setTakerFeeRate: (v: number) => void
  makerFeeRate: number
  setMakerFeeRate: (v: number) => void
}

export default function SimulationSection({
  takerFeeRate,
  setTakerFeeRate,
  makerFeeRate,
  setMakerFeeRate,
}: FeeSectionProps) {
  return (
    <section className="bg-card rounded-xl p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-1">Fees</h2>
      <p className="text-xs text-text-secondary mb-6">
        Ставки комиссии Bybit, применяемые во всех расчётах P&L paper trader и калькулятора.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-text-secondary">Taker (%)</label>
          <input
            type="number"
            value={(takerFeeRate * 100).toFixed(4)}
            onChange={(e) => setTakerFeeRate(Number(e.target.value) / 100)}
            step="0.001"
            min="0"
            max="1"
            className="w-full bg-input border border-input rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary">Maker (%)</label>
          <input
            type="number"
            value={(makerFeeRate * 100).toFixed(4)}
            onChange={(e) => setMakerFeeRate(Number(e.target.value) / 100)}
            step="0.001"
            min="0"
            max="1"
            className="w-full bg-input border border-input rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary mt-1.5">
        По умолчанию VIP 0: Taker 0.055%, Maker 0.02%. Сохранится после нажатия "Save Settings".
      </p>
    </section>
  )
}
