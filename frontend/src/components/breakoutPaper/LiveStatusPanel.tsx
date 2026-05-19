import type { BreakoutPaperConfig as PaperConfig } from '../../api/breakoutPaper'
import type { BreakoutLiveStatus } from '../../api/breakoutLiveC'

interface Props {
  config: PaperConfig
  liveStatus: BreakoutLiveStatus | null
  onKillSwitch: () => void
  onReleaseKillSwitch: () => void
  onWipeAll: () => void
}

/** Binance connectivity + kill-switch panel (LIVE only). */
export default function LiveStatusPanel({
  config, liveStatus, onKillSwitch, onReleaseKillSwitch, onWipeAll,
}: Props) {
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
    </div>
  )
}
