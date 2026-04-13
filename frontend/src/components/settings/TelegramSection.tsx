import { useState } from 'react'
import { testNotification, SettingsResponse } from '../../api/client'

interface TelegramSectionProps {
  telegramBotToken: string
  setTelegramBotToken: (v: string) => void
  telegramChatId: string
  setTelegramChatId: (v: string) => void
  telegramEnabled: boolean
  setTelegramEnabled: (v: boolean) => void
  settings: SettingsResponse | null
  showToast: (message: string, type: 'success' | 'error') => void
}

export default function TelegramSection({
  telegramBotToken,
  setTelegramBotToken,
  telegramChatId,
  setTelegramChatId,
  telegramEnabled,
  setTelegramEnabled,
  settings,
  showToast,
}: TelegramSectionProps) {
  const [testingNotif, setTestingNotif] = useState(false)

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

  return (
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
  )
}
