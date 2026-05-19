import type { BreakoutPaperConfig as PaperConfig, BreakoutVariant } from '../../api/breakoutPaper'
import { pragueRangeLabel } from './helpers'

interface Props {
  variant: BreakoutVariant
  isLive: boolean
  config: PaperConfig
  enabledCoins: number
  showAbout: boolean
  setShowAbout: (v: boolean | ((v: boolean) => boolean)) => void
  showSettings: boolean
  setShowSettings: (v: boolean | ((v: boolean) => boolean)) => void
  openTradesCount: number
  onTogglePaperEnabled: () => void
  onCloseAllMarket: () => void
  onWipeAll: () => void
}

export default function HeaderActions({
  variant, isLive, config, enabledCoins,
  showAbout, setShowAbout, setShowSettings,
  openTradesCount,
  onTogglePaperEnabled, onCloseAllMarket, onWipeAll,
}: Props) {
  const pragueRange = pragueRangeLabel()
  const coinsWord = enabledCoins === 1 ? 'монета' : enabledCoins >= 2 && enabledCoins <= 4 ? 'монеты' : 'монет'

  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <h1 className="text-2xl font-semibold">
          Daily Breakout
          {variant === 'B' && <span className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-accent/15 text-accent align-middle">B · 20 conc · 5% margin</span>}
          {variant === 'C' && <span className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-accent/15 text-accent align-middle">C · limit on rangeEdge</span>}
          {isLive && <span className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-short/15 text-short align-middle">LIVE · Binance Futures</span>}
        </h1>
        <p className="text-sm text-text-secondary">
          Стратегия пробоя 3h-диапазона (00:00–03:00 UTC · {pragueRange}). {enabledCoins} {coinsWord} ·
          {isLive
            ? <span> реальная торговля на Binance Futures + Telegram</span>
            : <span> виртуальная торговля + Telegram</span>}
          {variant === 'B' && <span className="ml-1">· копия B (тот же поток сигналов, увеличенная concurrency, уменьшенная маржа)</span>}
          {variant === 'C' && <span className="ml-1">· копия C (тот же поток сигналов, вход limit-ордером на rangeEdge — maker fee, без slip)</span>}
          {isLive && <span className="ml-1">· копия C, исполняется ордерами на бирже</span>}
        </p>
        <button
          type="button"
          onClick={() => setShowAbout(v => !v)}
          className="mt-1 text-xs text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
        >
          <span>{showAbout ? '▼' : '▶'}</span>
          <span>{showAbout ? 'Скрыть описание стратегии' : 'Как работает стратегия и результаты бэктеста'}</span>
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={onTogglePaperEnabled}
          className={`px-4 py-2 rounded font-medium ${config.enabled ? 'bg-long/15 text-long border border-long/30' : 'bg-card border border-input text-text-secondary'}`}>
          {isLive
            ? (config.enabled ? '● Стратегия вкл.' : '○ Стратегия выкл.')
            : (config.enabled ? '● Демо вкл.' : '○ Демо выкл.')}
        </button>
        <button onClick={() => setShowSettings(s => !s)}
          className="px-4 py-2 bg-card border border-input rounded font-medium hover:bg-input">
          ⚙ Настройки
        </button>
        <button onClick={onCloseAllMarket}
          disabled={openTradesCount === 0}
          className="px-4 py-2 bg-card border border-accent/40 text-accent rounded font-medium hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed">
          ⊗ Закрыть все по рынку
        </button>
        {!isLive && (
          <button onClick={onWipeAll}
            className="px-4 py-2 bg-card border border-short/40 text-short rounded font-medium hover:bg-short/10">
            🗑 Очистить всё
          </button>
        )}
      </div>
    </div>
  )
}
