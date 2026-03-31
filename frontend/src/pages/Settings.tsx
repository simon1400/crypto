import { useState, useEffect } from 'react'
import { getSettings, saveSettings, getBalance, SettingsResponse } from '../api/client'

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
  const [tradingMode, setTradingMode] = useState<'manual' | 'auto'>('manual')
  const [near512Topics, setNear512Topics] = useState<string[]>([])
  const [eveningTraderCategories, setEveningTraderCategories] = useState<string[]>([])
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [balance, setBalance] = useState<string | null>(null)

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
        if (data.hasKeys && data.balance) {
          setBalance(data.balance)
        }
      })
      .catch(() => {
        showToast('Failed to load settings', 'error')
      })
      .finally(() => setLoading(false))
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
      }
      const result = await saveSettings(body)
      setSettings(result)
      setApiKey('')
      setApiSecret('')
      if (result.balance) setBalance(result.balance)
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
