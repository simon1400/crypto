import { useState, useEffect } from 'react'
import { getSettings, saveSettings, getBalance, testNotification, SettingsResponse, getTickerMappings, createTickerMapping, deleteTickerMapping, TickerMapping, setVirtualBalance, resetSimulation } from '../api/client'
import { fmt2, fmt2Signed } from '../lib/formatters'

const NEAR512_TOPICS = [
  { key: 'Near512-LowCap', label: 'Low Cap' },
  { key: 'Near512-MidHigh', label: 'Mid/High Cap' },
  { key: 'Near512-Spot', label: 'Spot' },
]

const EVENING_TRADER_CATEGORIES = [
  { key: 'scalp', label: 'Scalp' },
  { key: 'risk-scalp', label: 'Risk Scalp' },
  { key: 'swing', label: 'Swing' },
]

export default function Settings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [useTestnet, setUseTestnet] = useState(true)
  const [positionSizePct, setPositionSizePct] = useState(10)
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState(5)
  const [orderTtlMinutes, setOrderTtlMinutes] = useState(60)
  const [tradingMode, setTradingMode] = useState<string>('manual')
  const [near512Topics, setNear512Topics] = useState<string[]>([])
  const [eveningTraderCategories, setEveningTraderCategories] = useState<string[]>([])
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [mappings, setMappings] = useState<TickerMapping[]>([])
  const [mappingsLoading, setMappingsLoading] = useState(true)
  const [newMapping, setNewMapping] = useState({ fromTicker: '', toSymbol: '', priceMultiplier: 1, notes: '' })
  const [showAddMapping, setShowAddMapping] = useState(false)
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [testingNotif, setTestingNotif] = useState(false)

  // Simulation state
  const [virtualBalance, setVirtualBalanceVal] = useState<number>(0)
  const [virtualBalanceStart, setVirtualBalanceStart] = useState<number>(0)
  const [virtualStartedAt, setVirtualStartedAt] = useState<string>('')
  const [takerFeeRate, setTakerFeeRate] = useState<number>(0.00055)
  const [makerFeeRate, setMakerFeeRate] = useState<number>(0.0002)
  const [virtualBalanceInput, setVirtualBalanceInput] = useState<string>('')
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    getSettings()
      .then((data) => {
        setSettings(data)
        setUseTestnet(data.useTestnet)
        setPositionSizePct(data.positionSizePct)
        setDailyLossLimitPct(data.dailyLossLimitPct)
        setOrderTtlMinutes(data.orderTtlMinutes)
        setTradingMode(data.tradingMode)
        setNear512Topics(data.near512Topics)
        setEveningTraderCategories(data.eveningTraderCategories)
        setTelegramEnabled(data.telegramEnabled ?? false)
        setTelegramChatId(data.telegramChatId ?? '')
        setVirtualBalanceVal(data.virtualBalance ?? 0)
        setVirtualBalanceStart(data.virtualBalanceStart ?? 0)
        setVirtualStartedAt(data.virtualStartedAt ?? '')
        setVirtualBalanceInput(String(data.virtualBalance ?? ''))
        setTakerFeeRate(data.takerFeeRate ?? 0.00055)
        setMakerFeeRate(data.makerFeeRate ?? 0.0002)
        if (data.hasKeys && data.balance) {
          setBalance(data.balance != null ? String(data.balance) : null)
        }
      })
      .catch(() => {
        showToast('Failed to load settings', 'error')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    getTickerMappings()
      .then(setMappings)
      .catch(() => {})
      .finally(() => setMappingsLoading(false))
  }, [])

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  function toggleTopic(key: string) {
    setNear512Topics((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  function toggleCategory(key: string) {
    setEveningTraderCategories((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  async function handleAddMapping() {
    if (!newMapping.fromTicker || !newMapping.toSymbol) {
      showToast('From and To fields are required', 'error')
      return
    }
    try {
      const created = await createTickerMapping(newMapping)
      setMappings(prev => [...prev, created])
      setNewMapping({ fromTicker: '', toSymbol: '', priceMultiplier: 1, notes: '' })
      setShowAddMapping(false)
      showToast('Mapping added', 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  async function handleDeleteMapping(id: number) {
    try {
      await deleteTickerMapping(id)
      setMappings(prev => prev.filter(m => m.id !== id))
      showToast('Mapping deleted', 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  async function handleTestNotification() {
    setTestingNotif(true)
    try {
      await testNotification({
        telegramBotToken: telegramBotToken || undefined,
        telegramChatId: telegramChatId || undefined,
      })
      showToast('Test notification sent!', 'success')
    } catch (err: any) {
      showToast(err.message || 'Failed to send test', 'error')
    } finally {
      setTestingNotif(false)
    }
  }

  async function handleSetVirtualBalance() {
    const v = Number(virtualBalanceInput)
    if (Number.isNaN(v) || v < 0) {
      showToast('Введите корректное число', 'error')
      return
    }
    try {
      const info = await setVirtualBalance(v, true)
      setVirtualBalanceVal(info.balance)
      setVirtualBalanceStart(info.start)
      setVirtualStartedAt(info.startedAt)
      showToast(`Виртуальный баланс установлен: $${info.balance}`, 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    }
  }

  async function handleResetSimulation() {
    const v = Number(virtualBalanceInput)
    if (Number.isNaN(v) || v < 0) {
      showToast('Введите корректное число для нового баланса', 'error')
      return
    }
    setResetting(true)
    try {
      const result = await resetSimulation(v)
      setVirtualBalanceVal(result.balance)
      setVirtualBalanceStart(result.start)
      setVirtualStartedAt(result.startedAt)
      setConfirmReset(false)
      showToast(`Симуляция сброшена: удалено ${result.deletedTrades} сделок`, 'success')
    } catch (err: any) {
      showToast(err.message, 'error')
    } finally {
      setResetting(false)
    }
  }

  async function handleSave() {
    // Client-side validation
    if (positionSizePct < 1 || positionSizePct > 50) {
      showToast('Position size must be between 1% and 50%', 'error')
      return
    }
    if (dailyLossLimitPct < 1 || dailyLossLimitPct > 30) {
      showToast('Daily loss limit must be between 1% and 30%', 'error')
      return
    }
    if (orderTtlMinutes < 5 || orderTtlMinutes > 1440) {
      showToast('Order TTL must be between 5 and 1440 minutes', 'error')
      return
    }

    setSaving(true)
    try {
      const body = {
        apiKey: apiKey || null,
        apiSecret: apiSecret || null,
        useTestnet,
        positionSizePct,
        dailyLossLimitPct,
        orderTtlMinutes,
        tradingMode,
        near512Topics,
        eveningTraderCategories,
        telegramBotToken: telegramBotToken || null,
        telegramChatId: telegramChatId || null,
        telegramEnabled,
        takerFeeRate,
        makerFeeRate,
      }
      const result = await saveSettings(body)
      setSettings(result)
      setApiKey('')
      setApiSecret('')
      if (result.balance != null) setBalance(String(result.balance))
      showToast('Settings saved', 'success')
    } catch (err: any) {
      const msg = err.message || 'Save failed'
      if (msg.startsWith('Invalid API keys')) {
        showToast(msg, 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-2xl font-semibold text-text-primary mb-8">Settings</div>
        <div className="space-y-8">
          <div className="bg-input animate-pulse rounded-xl h-48" />
          <div className="bg-input animate-pulse rounded-xl h-48" />
          <div className="bg-input animate-pulse rounded-xl h-48" />
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-4 right-4 z-50 rounded-lg px-4 py-3 text-sm border ${
            toast.type === 'success'
              ? 'bg-long/20 text-long border-long/30'
              : 'bg-short/20 text-short border-short/30'
          }`}
        >
          {toast.message}
        </div>
      )}

      <h1 className="text-2xl font-semibold text-text-primary mb-8">Settings</h1>

      <div className="space-y-8">
        {/* Section 1: Connection */}
        <section className="bg-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-text-primary">Connection</h2>
            {settings?.hasKeys ? (
              <span className="bg-long/10 text-long rounded-full px-3 py-1 text-xs font-medium">
                Connected
              </span>
            ) : (
              <span className="bg-neutral/10 text-neutral rounded-full px-3 py-1 text-xs font-medium">
                Not configured
              </span>
            )}
          </div>

          {!settings?.hasKeys && !apiKey && !apiSecret ? (
            <div className="text-center py-6">
              <p className="text-text-primary font-medium mb-2">Bybit not connected</p>
              <p className="text-text-secondary text-sm">
                Enter your API key and secret to connect. Use Testnet keys for safe testing.
              </p>
            </div>
          ) : null}

          {/* Balance */}
          {settings?.hasKeys && balance && (
            <div className="mb-6">
              <label className="text-sm font-medium text-text-primary mb-1.5 block">Balance</label>
              <span className="font-mono text-xl font-semibold text-long">
                ${Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
              </span>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="apiKey" className="text-sm font-medium text-text-primary mb-1.5 block">
                API Key
              </label>
              <input
                id="apiKey"
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings?.apiKeyMasked || 'Enter API Key'}
                className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
            </div>

            <div>
              <label htmlFor="apiSecret" className="text-sm font-medium text-text-primary mb-1.5 block">
                API Secret
              </label>
              <input
                id="apiSecret"
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={settings?.apiSecretMasked || 'Enter API Secret'}
                className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary mb-1.5 block">Network</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setUseTestnet(true)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    useTestnet
                      ? 'bg-accent/10 text-accent border-accent'
                      : 'bg-input text-text-secondary border-input'
                  }`}
                >
                  Testnet
                </button>
                <button
                  type="button"
                  onClick={() => setUseTestnet(false)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    !useTestnet
                      ? 'bg-accent/10 text-accent border-accent'
                      : 'bg-input text-text-secondary border-input'
                  }`}
                >
                  Mainnet
                </button>
              </div>
              <p className={`text-sm mt-2 ${useTestnet ? 'text-text-secondary' : 'text-accent'}`}>
                {useTestnet
                  ? 'Keys will be validated against Bybit Testnet'
                  : 'Keys will be validated against Bybit Mainnet'}
              </p>
            </div>
          </div>
        </section>

        {/* Section: Simulation (Virtual Balance + Fees) */}
        <section className="bg-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-1">Simulation</h2>
          <p className="text-xs text-text-secondary mb-6">
            Виртуальный депозит, на котором живут все сделки. Реальный Bybit аккаунт не трогается.
            Комиссии и funding списываются автоматически по реальным ставкам Bybit.
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
                Сбрасывает стартовый депозит — ROI пересчитывается с нуля. Сделки не удаляются.
              </p>
            </div>

            {/* Reset simulation */}
            <div className="border-t border-input pt-4">
              {confirmReset ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-short flex-1">
                    Удалить ВСЕ сделки и установить баланс ${virtualBalanceInput || '0'}?
                  </span>
                  <button
                    type="button"
                    onClick={handleResetSimulation}
                    disabled={resetting}
                    className="px-3 py-1.5 bg-short text-white rounded text-xs font-medium disabled:opacity-50"
                  >
                    {resetting ? '...' : 'Да, сбросить'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="px-3 py-1.5 bg-input text-text-secondary rounded text-xs"
                  >
                    Отмена
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="px-3 py-1.5 bg-short/10 text-short rounded-lg text-xs font-medium hover:bg-short/20 transition border border-short/30"
                >
                  Reset simulation (удалит сделки)
                </button>
              )}
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

        {/* Section 2: Trading Parameters */}
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

        {/* Section 3: Channels */}
        <section className="bg-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-6">Channels</h2>

          <div className="space-y-6">
            {/* Near512 Topics */}
            <div>
              <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wide mb-3">
                Near512 Topics
              </h3>
              <div className="space-y-3">
                {NEAR512_TOPICS.map((topic) => (
                  <label key={topic.key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={near512Topics.includes(topic.key)}
                      onChange={() => toggleTopic(topic.key)}
                      className="w-[18px] h-[18px] rounded border-2 border-neutral bg-transparent checked:bg-accent checked:border-accent accent-accent cursor-pointer"
                    />
                    <span className="text-sm text-text-primary">{topic.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* EveningTrader Categories */}
            <div>
              <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wide mb-3">
                EveningTrader Categories
              </h3>
              <div className="space-y-3">
                {EVENING_TRADER_CATEGORIES.map((cat) => (
                  <label key={cat.key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={eveningTraderCategories.includes(cat.key)}
                      onChange={() => toggleCategory(cat.key)}
                      className="w-[18px] h-[18px] rounded border-2 border-neutral bg-transparent checked:bg-accent checked:border-accent accent-accent cursor-pointer"
                    />
                    <span className="text-sm text-text-primary">{cat.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Section 4: Ticker Mappings */}
        <section className="bg-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-text-primary">Ticker Mappings</h2>
            <button
              type="button"
              onClick={() => setShowAddMapping(!showAddMapping)}
              className="text-sm font-medium text-accent hover:opacity-80"
            >
              {showAddMapping ? 'Cancel' : '+ Add Mapping'}
            </button>
          </div>

          <p className="text-sm text-text-secondary mb-4">
            Map signal tickers to Bybit symbols. For 1000x tickers (e.g. PEPE to 1000PEPEUSDT), set multiplier to 1000.
          </p>

          {/* Add form */}
          {showAddMapping && (
            <div className="bg-input rounded-lg p-4 mb-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">From Ticker</label>
                  <input
                    type="text"
                    value={newMapping.fromTicker}
                    onChange={e => setNewMapping(prev => ({ ...prev, fromTicker: e.target.value.toUpperCase() }))}
                    placeholder="PEPE"
                    className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">To Symbol (Bybit)</label>
                  <input
                    type="text"
                    value={newMapping.toSymbol}
                    onChange={e => setNewMapping(prev => ({ ...prev, toSymbol: e.target.value.toUpperCase() }))}
                    placeholder="1000PEPEUSDT"
                    className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Price Multiplier</label>
                  <input
                    type="number"
                    value={newMapping.priceMultiplier}
                    onChange={e => setNewMapping(prev => ({ ...prev, priceMultiplier: Number(e.target.value) }))}
                    className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Notes</label>
                  <input
                    type="text"
                    value={newMapping.notes}
                    onChange={e => setNewMapping(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="1000x bundle"
                    className="bg-primary border border-input rounded-lg px-3 py-2 text-sm text-text-primary w-full focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={handleAddMapping}
                className="bg-accent text-primary px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
              >
                Add Mapping
              </button>
            </div>
          )}

          {/* Mappings table */}
          {mappingsLoading ? (
            <div className="bg-input animate-pulse rounded-lg h-24" />
          ) : mappings.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-4">No mappings configured</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-secondary text-xs uppercase border-b border-input">
                    <th className="py-2 text-left">From</th>
                    <th className="py-2 text-left">To (Bybit)</th>
                    <th className="py-2 text-right">Multiplier</th>
                    <th className="py-2 text-left">Notes</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map(m => (
                    <tr key={m.id} className="border-b border-input/50">
                      <td className="py-2 font-mono text-text-primary">{m.fromTicker}</td>
                      <td className="py-2 font-mono text-text-primary">{m.toSymbol}</td>
                      <td className="py-2 font-mono text-text-primary text-right">{m.priceMultiplier}x</td>
                      <td className="py-2 text-text-secondary">{m.notes || '-'}</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteMapping(m.id)}
                          className="text-short hover:opacity-80 text-xs"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Section 5: Telegram Notifications */}
        <section className="bg-card rounded-xl p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-6">Telegram Notifications</h2>

          <p className="text-sm text-text-secondary mb-4">
            Get notified about trades, TP/SL hits, and system events via Telegram bot.
            Create a bot via @BotFather, get your chat ID from @userinfobot.
          </p>

          <div className="space-y-4">
            {/* Enable toggle */}
            <div>
              <label className="text-sm font-medium text-text-primary mb-1.5 block">
                Notifications
              </label>
              <div className="flex items-center gap-3">
                <span className="text-sm text-text-secondary">Off</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={telegramEnabled}
                  onClick={() => setTelegramEnabled(!telegramEnabled)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    telegramEnabled ? 'bg-accent' : 'bg-input'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      telegramEnabled ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
                <span className="text-sm text-text-secondary">On</span>
              </div>
            </div>

            {/* Bot Token */}
            <div>
              <label htmlFor="telegramBotToken" className="text-sm font-medium text-text-primary mb-1.5 block">
                Bot Token
              </label>
              <input
                id="telegramBotToken"
                type="text"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                placeholder={settings?.telegramBotToken || 'Enter Bot Token from @BotFather'}
                className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
            </div>

            {/* Chat ID */}
            <div>
              <label htmlFor="telegramChatId" className="text-sm font-medium text-text-primary mb-1.5 block">
                Chat ID
              </label>
              <input
                id="telegramChatId"
                type="text"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder={settings?.telegramChatId || 'Enter Chat ID from @userinfobot'}
                className="bg-input border border-input rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary w-full focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
            </div>

            {/* Test button */}
            <button
              type="button"
              onClick={handleTestNotification}
              disabled={testingNotif}
              className={`bg-input border border-accent text-accent px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent/10 transition-colors ${
                testingNotif ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {testingNotif ? 'Sending...' : 'Send Test Notification'}
            </button>
          </div>
        </section>

        {/* Save Button */}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={`w-full bg-accent text-primary py-3 rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity ${
            saving ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
