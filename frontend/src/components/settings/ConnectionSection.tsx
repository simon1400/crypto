import { SettingsResponse } from '../../api/client'

interface ConnectionSectionProps {
  settings: SettingsResponse | null
  apiKey: string
  setApiKey: (v: string) => void
  apiSecret: string
  setApiSecret: (v: string) => void
  useTestnet: boolean
  setUseTestnet: (v: boolean) => void
  balance: string | null
}

export default function ConnectionSection({
  settings,
  apiKey,
  setApiKey,
  apiSecret,
  setApiSecret,
  useTestnet,
  setUseTestnet,
  balance,
}: ConnectionSectionProps) {
  return (
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
  )
}
