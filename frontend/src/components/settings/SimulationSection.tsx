import { setVirtualBalance, VirtualBalanceInfo } from '../../api/client'
import { fmt2, fmt2Signed } from '../../lib/formatters'

interface SimulationSectionProps {
  virtualBalance: number
  virtualBalanceStart: number
  virtualStartedAt: string
  takerFeeRate: number
  setTakerFeeRate: (v: number) => void
  makerFeeRate: number
  setMakerFeeRate: (v: number) => void
  virtualBalanceInput: string
  setVirtualBalanceInput: (v: string) => void
  showToast: (message: string, type: 'success' | 'error') => void
  onBalanceUpdate: (info: VirtualBalanceInfo) => void
}

export default function SimulationSection({
  virtualBalance,
  virtualBalanceStart,
  virtualStartedAt,
  takerFeeRate,
  setTakerFeeRate,
  makerFeeRate,
  setMakerFeeRate,
  virtualBalanceInput,
  setVirtualBalanceInput,
  showToast,
  onBalanceUpdate,
}: SimulationSectionProps) {
  async function handleSetVirtualBalance() {
    const v = Number(virtualBalanceInput)
    if (Number.isNaN(v) || v < 0) {
      showToast('Введите корректное число', 'error')
      return
    }
    try {
      const info = await setVirtualBalance(v, true)
      onBalanceUpdate(info)
      showToast(`Виртуальный баланс установлен: $${info.balance}`, 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  return (
    <section className="bg-card rounded-xl p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-1">Simulation</h2>
      <p className="text-xs text-text-secondary mb-6">
        Виртуальный депозит для Daily Breakout paper trading. Реальный Bybit аккаунт не трогается.
      </p>

      {/* Текущий баланс — отображение */}
      <div className="bg-input rounded-lg p-4 mb-6">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-xs text-text-secondary">Текущий</div>
            <div className="font-mono text-lg font-bold text-accent">${fmt2(virtualBalance)}</div>
          </div>
          <div>
            <div className="text-xs text-text-secondary">Стартовый</div>
            <div className="font-mono text-lg font-bold text-text-primary">${fmt2(virtualBalanceStart)}</div>
          </div>
          <div>
            <div className="text-xs text-text-secondary">P&L / ROI</div>
            <div className={`font-mono text-lg font-bold ${virtualBalance >= virtualBalanceStart ? 'text-long' : 'text-short'}`}>
              {fmt2Signed(virtualBalance - virtualBalanceStart)}$
            </div>
            <div className={`text-xs font-mono ${virtualBalance >= virtualBalanceStart ? 'text-long' : 'text-short'}`}>
              {virtualBalanceStart > 0 ? fmt2Signed(((virtualBalance / virtualBalanceStart) - 1) * 100) : '0.00'}%
            </div>
          </div>
        </div>
        {virtualStartedAt && (
          <div className="text-xs text-text-secondary text-center mt-3">
            Симуляция запущена {new Date(virtualStartedAt).toLocaleString('ru-RU')}
          </div>
        )}
      </div>

      {/* Установить новый баланс */}
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium text-text-primary mb-1.5 block">
            Установить виртуальный баланс
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={virtualBalanceInput}
              onChange={(e) => setVirtualBalanceInput(e.target.value)}
              step="0.01"
              min="0"
              placeholder="1000"
              className="flex-1 bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
            <button
              type="button"
              onClick={handleSetVirtualBalance}
              className="px-4 py-2 bg-accent/10 text-accent rounded-lg text-sm font-medium hover:bg-accent/20 transition border border-accent/30"
            >
              Установить
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-1.5">
            Сбрасывает стартовый депозит — ROI пересчитывается с нуля.
          </p>
        </div>

        {/* Fee rates */}
        <div className="border-t border-input pt-4">
          <label className="text-sm font-medium text-text-primary mb-2 block">
            Bybit Fee Rates
          </label>
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
            По умолчанию VIP 0: Taker 0.055%, Maker 0.02%. Сохранится после нажатия "Save settings".
          </p>
        </div>
      </div>
    </section>
  )
}
