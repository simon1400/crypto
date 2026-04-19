import { useState, useEffect } from 'react'
import { getSettings, saveSettings, SettingsResponse, VirtualBalanceInfo } from '../api/client'
import ConnectionSection from '../components/settings/ConnectionSection'
import SimulationSection from '../components/settings/SimulationSection'
import TradingParamsSection from '../components/settings/TradingParamsSection'
import ChannelsSection from '../components/settings/ChannelsSection'
import TickerMappingsSection from '../components/settings/TickerMappingsSection'
import TelegramSection from '../components/settings/TelegramSection'
import AutoScannerSection from '../components/settings/AutoScannerSection'

export default function Settings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [useTestnet, setUseTestnet] = useState(true)
  const [balance, setBalance] = useState<string | null>(null)
  const [positionSizePct, setPositionSizePct] = useState(10)
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState(5)
  const [orderTtlMinutes, setOrderTtlMinutes] = useState(60)
  const [tradingMode, setTradingMode] = useState<string>('manual')
  const [near512Topics, setNear512Topics] = useState<string[]>([])
  const [eveningTraderCategories, setEveningTraderCategories] = useState<string[]>([])
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [autoScanEnabled, setAutoScanEnabled] = useState(false)
  const [autoScanIntervalMin, setAutoScanIntervalMin] = useState(12)
  const [autoScanMinScore, setAutoScanMinScore] = useState(80)
  const [virtualBalance, setVirtualBalanceVal] = useState<number>(0)
  const [virtualBalanceStart, setVirtualBalanceStart] = useState<number>(0)
  const [virtualStartedAt, setVirtualStartedAt] = useState<string>('')
  const [takerFeeRate, setTakerFeeRate] = useState<number>(0.00055)
  const [makerFeeRate, setMakerFeeRate] = useState<number>(0.0002)
  const [virtualBalanceInput, setVirtualBalanceInput] = useState<string>('')

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
        setAutoScanEnabled(data.autoScanEnabled ?? false)
        setAutoScanIntervalMin(data.autoScanIntervalMin ?? 12)
        setAutoScanMinScore(data.autoScanMinScore ?? 80)
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
      .catch(() => showToast('Failed to load settings', 'error'))
      .finally(() => setLoading(false))
  }, [])

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  function handleBalanceUpdate(info: VirtualBalanceInfo) {
    setVirtualBalanceVal(info.balance)
    setVirtualBalanceStart(info.start)
    setVirtualStartedAt(info.startedAt)
  }

  async function handleSave() {
    if (positionSizePct < 1 || positionSizePct > 50) { showToast('Position size must be between 1% and 50%', 'error'); return }
    if (dailyLossLimitPct < 1 || dailyLossLimitPct > 30) { showToast('Daily loss limit must be between 1% and 30%', 'error'); return }
    if (orderTtlMinutes < 5 || orderTtlMinutes > 1440) { showToast('Order TTL must be between 5 and 1440 minutes', 'error'); return }
    if (autoScanIntervalMin < 5 || autoScanIntervalMin > 120) { showToast('Интервал автосканера: 5–120 минут', 'error'); return }
    if (autoScanMinScore < 50 || autoScanMinScore > 100) { showToast('Min Score: 50–100', 'error'); return }
    setSaving(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await saveSettings({ apiKey: apiKey || null, apiSecret: apiSecret || null, useTestnet, positionSizePct, dailyLossLimitPct, orderTtlMinutes, tradingMode, near512Topics, eveningTraderCategories, telegramBotToken: telegramBotToken || null, telegramChatId: telegramChatId || null, telegramEnabled, autoScanEnabled, autoScanIntervalMin, autoScanMinScore, takerFeeRate, makerFeeRate } as any)
      setSettings(result)
      setApiKey('')
      setApiSecret('')
      if (result.balance != null) setBalance(String(result.balance))
      showToast('Settings saved', 'success')
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error')
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
        <ConnectionSection
          settings={settings}
          apiKey={apiKey}
          setApiKey={setApiKey}
          apiSecret={apiSecret}
          setApiSecret={setApiSecret}
          useTestnet={useTestnet}
          setUseTestnet={setUseTestnet}
          balance={balance}
        />
        <SimulationSection
          virtualBalance={virtualBalance}
          virtualBalanceStart={virtualBalanceStart}
          virtualStartedAt={virtualStartedAt}
          takerFeeRate={takerFeeRate}
          setTakerFeeRate={setTakerFeeRate}
          makerFeeRate={makerFeeRate}
          setMakerFeeRate={setMakerFeeRate}
          virtualBalanceInput={virtualBalanceInput}
          setVirtualBalanceInput={setVirtualBalanceInput}
          showToast={showToast}
          onBalanceUpdate={handleBalanceUpdate}
        />
        <TradingParamsSection
          positionSizePct={positionSizePct}
          setPositionSizePct={setPositionSizePct}
          dailyLossLimitPct={dailyLossLimitPct}
          setDailyLossLimitPct={setDailyLossLimitPct}
          orderTtlMinutes={orderTtlMinutes}
          setOrderTtlMinutes={setOrderTtlMinutes}
          tradingMode={tradingMode}
          setTradingMode={setTradingMode}
        />
        <ChannelsSection
          near512Topics={near512Topics}
          setNear512Topics={setNear512Topics}
          eveningTraderCategories={eveningTraderCategories}
          setEveningTraderCategories={setEveningTraderCategories}
        />
        <TickerMappingsSection showToast={showToast} />
        <TelegramSection
          telegramBotToken={telegramBotToken}
          setTelegramBotToken={setTelegramBotToken}
          telegramChatId={telegramChatId}
          setTelegramChatId={setTelegramChatId}
          telegramEnabled={telegramEnabled}
          setTelegramEnabled={setTelegramEnabled}
          settings={settings}
          showToast={showToast}
        />
        <AutoScannerSection
          autoScanEnabled={autoScanEnabled}
          setAutoScanEnabled={setAutoScanEnabled}
          autoScanIntervalMin={autoScanIntervalMin}
          setAutoScanIntervalMin={setAutoScanIntervalMin}
          autoScanMinScore={autoScanMinScore}
          setAutoScanMinScore={setAutoScanMinScore}
        />
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
