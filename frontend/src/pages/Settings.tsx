import { useState, useEffect } from 'react'
import { getSettings, saveSettings, SettingsResponse } from '../api/client'
import ConnectionSection from '../components/settings/ConnectionSection'
import SimulationSection from '../components/settings/SimulationSection'
import TelegramSection from '../components/settings/TelegramSection'

export default function Settings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [useTestnet, setUseTestnet] = useState(true)
  const [balance, setBalance] = useState<string | null>(null)
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [takerFeeRate, setTakerFeeRate] = useState<number>(0.00055)
  const [makerFeeRate, setMakerFeeRate] = useState<number>(0.0002)

  useEffect(() => {
    getSettings()
      .then((data) => {
        setSettings(data)
        setUseTestnet(data.useTestnet)
        setTelegramEnabled(data.telegramEnabled ?? false)
        setTelegramChatId(data.telegramChatId ?? '')
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

  async function handleSave() {
    setSaving(true)
    try {
      const result = await saveSettings({
        apiKey: apiKey || null,
        apiSecret: apiSecret || null,
        useTestnet,
        telegramBotToken: telegramBotToken || null,
        telegramChatId: telegramChatId || null,
        telegramEnabled,
        takerFeeRate,
        makerFeeRate,
      })
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
          takerFeeRate={takerFeeRate}
          setTakerFeeRate={setTakerFeeRate}
          makerFeeRate={makerFeeRate}
          setMakerFeeRate={setMakerFeeRate}
        />
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
