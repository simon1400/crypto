import { useState } from 'react'
import type { BreakoutPaperConfig as PaperConfig } from '../../api/breakoutPaper'
import type { BreakoutLiveStatus } from '../../api/breakoutLiveC'
import { switchNetwork } from '../../api/breakoutLiveC'

interface Props {
  config: PaperConfig
  liveStatus: BreakoutLiveStatus | null
  onKillSwitch: () => void
  onReleaseKillSwitch: () => void
  onWipeAll: () => void
  onConfigChanged?: () => void
}

/** Binance connectivity + kill-switch panel (LIVE only). */
export default function LiveStatusPanel({
  config, liveStatus, onKillSwitch, onReleaseKillSwitch, onWipeAll, onConfigChanged,
}: Props) {
  const [switchModal, setSwitchModal] = useState<null | 'to-real' | 'to-testnet'>(null)
  const isTestnet = liveStatus?.net === 'testnet'
  const canSwitch = !config.enabled
    && (liveStatus?.openPositions ?? 0) === 0
    && !liveStatus?.killSwitchActive
  return (
    <div className="bg-card border border-input rounded p-3 mb-4 flex flex-wrap items-center gap-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={`relative flex h-2 w-2`} title={liveStatus?.connected ? 'Подключено к Binance' : 'Нет подключения'}>
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${liveStatus?.connected ? 'animate-ping bg-long' : 'bg-short'}`} />
          <span className={`relative inline-flex h-2 w-2 rounded-full ${liveStatus?.connected ? 'bg-long' : 'bg-short'}`} />
        </span>
        <span className="font-mono text-xs">
          {liveStatus?.connected
            ? <>Binance <span className={liveStatus.net === 'prod' ? 'text-short font-semibold' : 'text-accent'}>{liveStatus.net?.toUpperCase()}</span></>
            : <span className="text-short">offline{liveStatus?.reason ? ` · ${liveStatus.reason}` : ''}</span>}
        </span>
      </div>
      {liveStatus?.connected && (
        <span className="text-xs text-text-secondary font-mono">
          баланс <span className="text-text-primary">${liveStatus.balanceUsdt?.toFixed(2)}</span>
          · позиций <span className="text-text-primary">{liveStatus.openPositions}</span>
          · ордеров <span className="text-text-primary">{liveStatus.openOrders}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {liveStatus?.killSwitchActive ? (
          <>
            <span className="px-2 py-1 rounded text-xs font-mono bg-short/15 text-short border border-short/30">
              🛑 KILL · {liveStatus.killSwitchReason ?? 'manual'}
            </span>
            <button onClick={onReleaseKillSwitch}
              className="px-3 py-1 bg-card border border-input rounded text-xs font-medium hover:bg-input">
              Снять
            </button>
          </>
        ) : (
          <button onClick={onKillSwitch}
            className="px-3 py-1 bg-short/10 border border-short/40 text-short rounded text-xs font-medium hover:bg-short/20">
            🛑 Kill switch
          </button>
        )}
        {/* Network switch — only when strategy is OFF, no open positions, no kill.
            testnet → real demands typed confirmation; real → testnet is a soft confirm. */}
        {canSwitch && isTestnet && (
          <button
            onClick={() => setSwitchModal('to-real')}
            title="Переключиться на реальный счёт Binance. Удалит всю testnet-статистику."
            className="px-3 py-1 bg-short/10 border border-short/40 text-short rounded text-xs font-semibold hover:bg-short/20"
          >
            ⚡ На РЕАЛ
          </button>
        )}
        {canSwitch && !isTestnet && (
          <button
            onClick={() => setSwitchModal('to-testnet')}
            title="Вернуться на Binance testnet (фейковые деньги). Удалит всю real-статистику."
            className="px-3 py-1 bg-card border border-accent/40 text-accent rounded text-xs font-medium hover:bg-accent/10"
          >
            ↩ На testnet
          </button>
        )}
        {/* Wipe — only when strategy is OFF and no open positions on exchange.
            Refuses anyway on backend if positions != 0, but hiding the button
            keeps the UI honest. */}
        {!config.enabled && (liveStatus?.openPositions ?? 0) === 0 && (
          <button onClick={onWipeAll}
            title="Удалить все live-записи (сделки/funding/attempts) и сбросить baseline. Позиции на бирже не трогаются."
            className="px-3 py-1 bg-card border border-input rounded text-xs font-medium hover:bg-input text-text-secondary hover:text-text-primary">
            🗑 Очистить
          </button>
        )}
      </div>

      {switchModal && (
        <SwitchNetworkModal
          mode={switchModal}
          balanceHint={liveStatus?.walletBalanceUsdt}
          onClose={() => setSwitchModal(null)}
          onDone={() => {
            setSwitchModal(null)
            onConfigChanged?.()
          }}
        />
      )}
    </div>
  )
}

interface SwitchModalProps {
  mode: 'to-real' | 'to-testnet'
  balanceHint?: number
  onClose: () => void
  onDone: () => void
}

function SwitchNetworkModal({ mode, balanceHint, onClose, onDone }: SwitchModalProps) {
  const [confirmInput, setConfirmInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toReal = mode === 'to-real'
  const canSubmit = toReal ? confirmInput === 'SWITCH_TO_REAL' : true

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      const target = toReal ? 'real' : 'testnet'
      await switchNetwork(target, toReal ? 'SWITCH_TO_REAL_ACK' : undefined)
      onDone()
    } catch (e: any) {
      setErr(e.message || 'Не удалось переключиться')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="bg-card border border-input rounded-lg shadow-2xl max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className={`text-lg font-semibold ${toReal ? 'text-short' : 'text-accent'}`}>
          {toReal ? '⚡ Переход на РЕАЛЬНЫЙ счёт' : '↩ Возврат на testnet'}
        </h3>
        <div className="text-sm text-text-secondary space-y-2">
          {toReal ? (
            <>
              <p>Стратегия переключится на твой <span className="text-short font-semibold">реальный</span> Binance Futures аккаунт. Это будет торговать <span className="text-short font-semibold">настоящими деньгами</span>.</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Удалятся все testnet-сделки, funding, отклонённые попытки</li>
                <li>Статистика обнулится: TotalPnL, MaxDD, win-rate</li>
                <li>Baseline возьмётся с <b>walletBalance</b> реального аккаунта при следующем запуске</li>
                <li>Стратегия <b>не запустится автоматически</b> — нажми «Запустить» вручную после проверки</li>
              </ul>
              {balanceHint != null && (
                <p className="text-xs text-text-primary">
                  Текущий wallet на бирже: <span className="font-mono">${balanceHint.toFixed(2)}</span>
                </p>
              )}
              <div className="pt-2">
                <label className="block text-xs mb-1">Введи <span className="font-mono text-text-primary">SWITCH_TO_REAL</span> для подтверждения:</label>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  className="bg-input border border-input rounded px-3 py-2 text-sm font-mono w-full focus:border-short focus:outline-none"
                  autoFocus
                />
              </div>
            </>
          ) : (
            <>
              <p>Вернуть стратегию на Binance <span className="text-accent">testnet</span> (фейковые деньги).</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Удалятся все real-сделки и статистика</li>
                <li>Baseline возьмётся с walletBalance testnet при следующем запуске</li>
              </ul>
            </>
          )}
        </div>

        {err && <div className="text-xs text-short bg-short/10 border border-short/30 rounded p-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-input rounded text-sm hover:bg-input/70 disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            onClick={submit}
            disabled={busy || !canSubmit}
            className={`px-4 py-2 rounded text-sm font-medium ${
              toReal ? 'bg-short text-white' : 'bg-accent text-primary'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {busy ? 'Переключаем...' : (toReal ? 'Перейти на РЕАЛ' : 'Вернуться на testnet')}
          </button>
        </div>
      </div>
    </div>
  )
}
