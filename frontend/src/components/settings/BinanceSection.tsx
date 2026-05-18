import { useState } from 'react'
import { SettingsResponse, saveBinanceKeys, deleteBinanceKeys } from '../../api/settings'

interface Props {
  settings: SettingsResponse | null
  onUpdate: (next: SettingsResponse) => void
  showToast: (msg: string, type: 'success' | 'error') => void
}

export default function BinanceSection({ settings, onUpdate, showToast }: Props) {
  return (
    <section className="bg-card rounded-xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">Binance Futures · Variant C live</h2>
      </div>
      <p className="text-sm text-text-secondary">
        Ключи для автоматической торговли C на Binance Futures USDT-M. Testnet — для отладки
        (фейковые деньги на testnet.binancefuture.com). Live — реальная торговля.
        Хранятся в БД зашифрованными (AES-256-GCM).
      </p>

      <KeyPairForm
        title="Testnet"
        net="testnet"
        configured={settings?.binanceTestnetConfigured ?? false}
        keyMasked={settings?.binanceTestnetKeyMasked ?? null}
        secretMasked={settings?.binanceTestnetSecretMasked ?? null}
        onUpdate={onUpdate}
        showToast={showToast}
      />

      <KeyPairForm
        title="Live (PROD — реальные деньги)"
        net="live"
        configured={settings?.binanceLiveConfigured ?? false}
        keyMasked={settings?.binanceLiveKeyMasked ?? null}
        secretMasked={settings?.binanceLiveSecretMasked ?? null}
        onUpdate={onUpdate}
        showToast={showToast}
        danger
      />
    </section>
  )
}

interface KeyPairFormProps {
  title: string
  net: 'testnet' | 'live'
  configured: boolean
  keyMasked: string | null
  secretMasked: string | null
  onUpdate: (next: SettingsResponse) => void
  showToast: (msg: string, type: 'success' | 'error') => void
  danger?: boolean
}

function KeyPairForm({ title, net, configured, keyMasked, secretMasked, onUpdate, showToast, danger }: KeyPairFormProps) {
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!apiKey || !apiSecret) {
      showToast('Введите API key и secret', 'error')
      return
    }
    if (danger && !confirm('Сохранить PROD ключи (реальные деньги)? Будут использованы для real-money торговли.')) {
      return
    }
    setSaving(true)
    try {
      const r = await saveBinanceKeys(net, apiKey.trim(), apiSecret.trim())
      onUpdate(r)
      setApiKey('')
      setApiSecret('')
      const bal = (r as any).binanceBalance
      showToast(`Сохранено. Баланс: ${bal ? Number(bal).toFixed(2) + ' USDT' : '—'}`, 'success')
    } catch (e: any) {
      showToast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Удалить ${title} ключи?`)) return
    try {
      const r = await deleteBinanceKeys(net)
      onUpdate(r)
      showToast('Ключи удалены', 'success')
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  return (
    <div className={`rounded-lg p-4 border ${danger ? 'border-short/30' : 'border-input'}`}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${danger ? 'text-short' : 'text-text-primary'}`}>{title}</span>
          {configured ? (
            <span className="bg-long/10 text-long rounded-full px-2 py-0.5 text-[10px] font-medium">
              Настроено
            </span>
          ) : (
            <span className="bg-neutral/10 text-neutral rounded-full px-2 py-0.5 text-[10px] font-medium">
              Не настроено
            </span>
          )}
        </div>
        {configured && (
          <button
            type="button"
            onClick={handleDelete}
            className="text-xs text-short hover:underline"
          >
            Удалить
          </button>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-secondary mb-1 block">API Key</label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={keyMasked || (configured ? 'уже настроен' : 'Введите API Key')}
            className="bg-input border border-input rounded px-3 py-2 text-sm font-mono w-full focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary mb-1 block">API Secret</label>
          <input
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder={secretMasked || (configured ? 'уже настроен' : 'Введите API Secret')}
            className="bg-input border border-input rounded px-3 py-2 text-sm font-mono w-full focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !apiKey || !apiSecret}
          className={`px-4 py-2 rounded text-sm font-medium transition-opacity ${
            danger ? 'bg-short text-white' : 'bg-accent text-primary'
          } ${saving || !apiKey || !apiSecret ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
        >
          {saving ? 'Проверка ключей...' : 'Сохранить и проверить'}
        </button>
      </div>

      {net === 'live' && (
        <div className="mt-3 text-xs text-text-secondary">
          ⚠️ Ключ должен иметь права <b>Enable Futures</b> + <b>Enable Trading</b>.
          Withdrawals — <b>выключить</b>. Включить IP whitelist.
        </div>
      )}
    </div>
  )
}
