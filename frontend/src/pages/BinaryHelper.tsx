import { useEffect, useState, useRef } from 'react'
import {
  getForexState, markForexSignal, ForexSnapshot, ForexSymbolState, ForexSignal, UserOutcome,
} from '../api/client'

const TF_MS = 60_000  // 1 минута

// ============================================================================
// Utils
// ============================================================================

function fmtPrice(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return '—'
  if (p >= 50) return p.toFixed(3)   // JPY pairs
  return p.toFixed(5)
}

function fmtTimer(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function relPosition(price: number | null, lower: number | null, upper: number | null): number | null {
  if (price == null || lower == null || upper == null) return null
  if (upper <= lower) return null
  return ((price - lower) / (upper - lower)) * 100
}

function tfTimerMs(lastCandleTs: number | null, now: number): number {
  if (!lastCandleTs) return 0
  let ms = lastCandleTs + TF_MS - now
  while (ms < 0) ms += TF_MS
  return ms
}

// ============================================================================
// Big signal banner — visible from across the room
// ============================================================================

interface SignalBannerProps {
  active: ForexSignal[]
  now: number
  onMark: (id: string, outcome: UserOutcome) => void
  currentLossStreak: number
}

function SignalBanner({ active, now, onMark, currentLossStreak }: SignalBannerProps) {
  if (active.length === 0) {
    return (
      <div className="bg-card rounded-xl p-6 sm:p-10 text-center border-2 border-card">
        <div className="text-text-secondary text-base sm:text-lg">Ожидание сигнала…</div>
        <div className="text-text-secondary text-xs sm:text-sm mt-2">
          Сигнал появится когда закрытие 1m свечи окажется на границе BB(20,2). Звук + всплывашка.
        </div>
      </div>
    )
  }

  const sorted = [...active].sort((a, b) => b.signalAt - a.signalAt)

  return (
    <div className="space-y-3">
      {sorted.map((sig) => {
        const remain = sig.expiresAt - now
        const entryWindowEndsAt = sig.signalAt + 30_000
        const entryRemain = Math.max(0, entryWindowEndsAt - now)
        const tooLate = entryRemain === 0

        const isCall = sig.direction === 'CALL'
        const bgClass = isCall ? 'bg-long/15 border-long' : 'bg-short/15 border-short'
        const textClass = isCall ? 'text-long' : 'text-short'
        const arrow = isCall ? '▲' : '▼'
        const action = isCall ? 'BUY' : 'SELL'
        const subtitle = isCall ? 'CALL (вверх)' : 'PUT (вниз)'

        return (
          <div
            key={sig.id}
            className={`rounded-xl p-4 sm:p-6 border-2 ${bgClass}`}
          >
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-text-primary text-2xl sm:text-3xl font-mono font-bold">{sig.symbol}</div>
              <div className="text-text-secondary text-xs sm:text-sm uppercase tracking-wide">
                {tooLate ? 'Окно входа закрыто' : 'Войти СЕЙЧАС'}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <div className="text-center sm:text-left">
                <div className="text-text-secondary text-xs uppercase mb-1">Направление</div>
                <div className={`font-bold text-3xl sm:text-4xl font-mono leading-none ${textClass}`}>
                  {arrow} {action}
                </div>
                <div className={`text-xs sm:text-sm font-mono mt-1 ${textClass} opacity-75`}>{subtitle}</div>
              </div>

              <div className="text-center">
                <div className="text-text-secondary text-xs uppercase mb-1">Экспирация на PO</div>
                <div className="font-bold text-3xl sm:text-4xl font-mono leading-none text-text-primary">
                  1 мин
                </div>
                <div className="text-xs font-mono text-text-secondary mt-1">
                  Вход @ {fmtPrice(sig.entryPrice)}
                </div>
              </div>

              <div className="text-center sm:text-right">
                <div className="text-text-secondary text-xs uppercase mb-1">Осталось войти</div>
                <div className={`font-bold text-3xl sm:text-4xl font-mono leading-none ${tooLate ? 'text-neutral' : textClass}`}>
                  {fmtTimer(entryRemain)}
                </div>
                <div className="text-xs font-mono text-text-secondary mt-1">
                  Резолв через {fmtTimer(remain)}
                </div>
              </div>
            </div>

            {/* 4 кнопки результата. Баннер не пропадает сам — только после нажатия любой кнопки.
                Доступны сразу (юзер может пометить SKIPPED до экспирации если знает что не успел зайти). */}
            <div className="mt-4 pt-4 border-t border-card/40">
              <div className="flex flex-col gap-2">
                <div className="text-text-secondary text-xs text-center">
                  Зафиксируй результат — после клика баннер закроется:
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    onClick={() => onMark(sig.id, 'WIN')}
                    className="bg-long/20 hover:bg-long/30 border border-long text-long font-semibold py-2 px-3 rounded-lg transition-colors"
                  >
                    <div className="text-lg leading-none">+</div>
                    <div className="text-xs mt-1">Выиграл</div>
                  </button>
                  <button
                    onClick={() => onMark(sig.id, 'LOSS')}
                    className="bg-short/20 hover:bg-short/30 border border-short text-short font-semibold py-2 px-3 rounded-lg transition-colors"
                  >
                    <div className="text-lg leading-none">−</div>
                    <div className="text-xs mt-1">Проиграл</div>
                  </button>
                  <button
                    onClick={() => onMark(sig.id, 'RECOVERY')}
                    disabled={currentLossStreak === 0}
                    className="bg-accent/20 hover:bg-accent/30 border border-accent text-accent font-semibold py-2 px-3 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={currentLossStreak === 0 ? 'Нет открытой серии убытков' : `Перекрыть последние ${currentLossStreak} минусов`}
                  >
                    <div className="text-lg leading-none">🔄</div>
                    <div className="text-xs mt-1">Перекрыл {currentLossStreak > 0 ? `(${currentLossStreak})` : ''}</div>
                  </button>
                  <button
                    onClick={() => onMark(sig.id, 'SKIPPED')}
                    className="bg-card hover:bg-input border border-card text-text-secondary font-semibold py-2 px-3 rounded-lg transition-colors"
                  >
                    <div className="text-lg leading-none">⊘</div>
                    <div className="text-xs mt-1">Не вошёл</div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ============================================================================
// Per-symbol mini-card
// ============================================================================

function SymbolCard({ s }: { s: ForexSymbolState }) {
  const sig = s.activeSignal
  const isActive = sig && sig.outcome === 'PENDING'
  const pos = relPosition(s.lastPrice, s.bbLower, s.bbUpper)

  let borderClass = 'border-card'
  let signalText = '—'
  let signalClass = 'text-neutral'
  if (isActive && sig) {
    if (sig.direction === 'CALL') { borderClass = 'border-long'; signalText = '▲ CALL'; signalClass = 'text-long' }
    else { borderClass = 'border-short'; signalText = '▼ PUT'; signalClass = 'text-short' }
  } else if (pos != null) {
    if (pos <= 5) { borderClass = 'border-long/40'; signalText = '≈ нижняя BB'; signalClass = 'text-long/70' }
    else if (pos >= 95) { borderClass = 'border-short/40'; signalText = '≈ верхняя BB'; signalClass = 'text-short/70' }
    else { signalText = 'IDLE'; signalClass = 'text-neutral' }
  }

  return (
    <div className={`bg-card rounded-lg border-2 ${borderClass} p-3 flex flex-col gap-2 transition-colors`}>
      <div className="flex items-baseline justify-between">
        <div className="font-mono font-semibold text-text-primary text-base">{s.symbol}</div>
        <div className={`font-semibold text-sm font-mono ${signalClass}`}>{signalText}</div>
      </div>

      <div className="font-mono text-xl text-accent">{fmtPrice(s.lastPrice)}</div>

      <div className="w-full h-1.5 bg-input rounded-full relative overflow-hidden">
        {pos != null && (
          <div
            className="absolute top-0 h-full w-1 bg-accent rounded-full"
            style={{ left: `calc(${Math.max(0, Math.min(100, pos))}% - 2px)` }}
          />
        )}
        <div className="absolute top-0 left-0 h-full w-px bg-long/60" />
        <div className="absolute top-0 right-0 h-full w-px bg-short/60" />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-text-secondary">
        <span>{fmtPrice(s.bbLower)}</span>
        <span>{fmtPrice(s.bbUpper)}</span>
      </div>

      {s.lastError && (
        <div className="text-[10px] text-short">⚠ {s.lastError}</div>
      )}
    </div>
  )
}

// ============================================================================
// Global "next 1m candle" countdown — single timer for the whole page.
// All 6 forex pairs close on the same UTC minute boundary so per-card timers
// duplicated the same value 6 times. This shows it once.
// ============================================================================

function GlobalCandleTimer({ now }: { now: number }) {
  // 1m candle boundary in UTC: next round-minute timestamp
  const nextBoundary = Math.ceil(now / TF_MS) * TF_MS
  const remain = nextBoundary - now
  const progress = 1 - remain / TF_MS
  return (
    <div className="bg-card rounded-lg p-2 sm:p-3 flex items-center gap-3">
      <span className="text-xs text-text-secondary whitespace-nowrap">След. 1m свеча через</span>
      <div className="flex-1 h-1.5 bg-input rounded-full relative overflow-hidden">
        <div
          className="h-full bg-accent/60 transition-all"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <span className="font-mono text-sm text-accent tabular-nums">{fmtTimer(remain)}</span>
    </div>
  )
}

// ============================================================================
// History row
// ============================================================================

function HistoryRow({ h }: { h: ForexSignal }) {
  const dirIcon = h.direction === 'CALL' ? '▲' : '▼'
  const time = new Date(h.signalAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const u = h.userOutcome
  let resultText: string
  let resultClass: string
  if (u === 'WIN') { resultText = '+ Выиграл'; resultClass = 'text-long' }
  else if (u === 'LOSS') { resultText = '− Проиграл'; resultClass = 'text-short' }
  else if (u === 'RECOVERY') { resultText = '🔄 Перекрыл'; resultClass = 'text-accent' }
  else if (u === 'SKIPPED') { resultText = '⊘ Не вошёл'; resultClass = 'text-text-secondary' }
  else { resultText = '—'; resultClass = 'text-text-secondary' }
  return (
    <tr className="border-b border-card/40">
      <td className="py-1.5 pr-2 text-text-secondary font-mono text-xs">{time}</td>
      <td className="py-1.5 pr-2 font-mono">{h.symbol}</td>
      <td className="py-1.5 pr-2 font-mono">{dirIcon} {h.direction}</td>
      <td className="py-1.5 pr-2 font-mono text-text-secondary">{fmtPrice(h.entryPrice)}</td>
      <td className={`py-1.5 font-semibold ${resultClass}`}>{resultText}</td>
    </tr>
  )
}

// ============================================================================
// Page
// ============================================================================

export default function BinaryHelper() {
  const [snap, setSnap] = useState<ForexSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const lastFreshIds = useRef<Set<string>>(new Set())
  const audioCtx = useRef<AudioContext | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)  // быстрее тикаем для плавного таймера
    return () => clearInterval(t)
  }, [])

  // Request browser notification permission once (user gesture not strictly required for Chrome but
  // it's better to ask on mount — user will click the prompt then)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const s = await getForexState()
        if (cancelled) return
        setNow(s.serverTime)
        const curIds = new Set(s.active.map((x) => x.id))
        for (const id of curIds) {
          if (!lastFreshIds.current.has(id)) {
            const sig = s.active.find((x) => x.id === id)
            if (sig) notifySignal(sig)
            break
          }
        }
        lastFreshIds.current = curIds
        setSnap(s)
        setError(null)
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? String(e))
      }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  async function handleMark(id: string, outcome: UserOutcome) {
    // Optimistic update: убираем сигнал из active СРАЗУ, не ждём ответ сервера.
    // Иначе юзер видит "залипание" 200-500мс пока http+repoll отрабатывают.
    setSnap((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        active: prev.active.filter((s) => s.id !== id),
        history: prev.history.map((h) => h.id === id ? { ...h, userOutcome: outcome ?? undefined } : h),
      }
    })
    try {
      await markForexSignal(id, outcome)
    } catch (e: any) {
      console.error('markForexSignal failed:', e)
      // On failure — refresh from server to recover correct state
      try {
        const s = await getForexState()
        setSnap(s)
      } catch { /* ignore */ }
    }
  }

  function playBeep() {
    try {
      if (!audioCtx.current) audioCtx.current = new (window.AudioContext || (window as any).webkitAudioContext)()
      const ctx = audioCtx.current
      // Three short beeps so it's impossible to miss
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = 1000
        const t0 = ctx.currentTime + i * 0.18
        gain.gain.setValueAtTime(0.001, t0)
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15)
        osc.start(t0)
        osc.stop(t0 + 0.17)
      }
    } catch { /* ignore */ }
  }

  function notifySignal(sig: ForexSignal) {
    playBeep()
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const word = sig.direction === 'CALL' ? 'BUY ▲' : 'SELL ▼'
        new Notification(`${sig.symbol}: ${word}`, {
          body: `Войти СЕЙЧАС. Экспирация через 1 минуту. Цена ${fmtPrice(sig.entryPrice)}`,
          icon: '/favicon.ico',
          tag: sig.id,
        })
      }
    } catch { /* ignore */ }
  }

  const symbols = snap?.symbols ?? []
  const stats = snap?.stats
  const userStats = snap?.userStats
  const history = snap?.history ?? []
  const active = snap?.active ?? []

  const isForexClosed = symbols.length > 0 && symbols.every((s) => !s.lastCandleTs || (now - s.lastCandleTs) > 10 * 60_000)

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-text-primary">Forex Binary Helper</h1>
          <p className="text-xs sm:text-sm text-text-secondary">
            BB(20,2) touch на 1m → вход 1 минута. EUR/USD · GBP/USD · AUD/USD · USD/JPY · USD/CAD · EUR/CAD.
            Backtest: WR 60%, EV +0.08.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs sm:text-sm font-mono">
          {userStats && userStats.totalMarked > 0 && (
            <>
              <div className="bg-card rounded px-2 py-1" title="Реальная статистика — твои отметки на PO">
                <span className="text-text-secondary">Реал </span>
                <span className="text-long">+{userStats.wins}</span>
                <span className="text-text-secondary"> / </span>
                <span className="text-short">−{userStats.losses}</span>
                {userStats.recoveries > 0 && (
                  <>
                    <span className="text-text-secondary"> / </span>
                    <span className="text-accent">🔄{userStats.recoveries}</span>
                  </>
                )}
              </div>
              <div className="bg-card rounded px-2 py-1">
                <span className="text-text-secondary">WR </span>
                <span className={userStats.winRate >= 0.556 ? 'text-long' : 'text-short'}>
                  {(userStats.winRate * 100).toFixed(1)}%
                </span>
              </div>
              {userStats.currentLossStreak > 0 && (
                <div className="bg-short/10 border border-short/30 rounded px-2 py-1">
                  <span className="text-short">Серия минусов: {userStats.currentLossStreak}</span>
                </div>
              )}
            </>
          )}
          {stats && (
            <div className="bg-card/40 rounded px-2 py-1" title="Автоматическая статистика по ценам TwelveData — для справки">
              <span className="text-text-secondary">Авто WR </span>
              <span className={stats.winRate >= 0.556 ? 'text-long/70' : 'text-short/70'}>
                {(stats.winRate * 100).toFixed(1)}%
              </span>
              <span className="text-text-secondary"> ({stats.wins}/{stats.wins + stats.losses})</span>
            </div>
          )}
        </div>
      </div>

      {/* Market closed banner */}
      {isForexClosed && (
        <div className="bg-short/10 border border-short/30 text-short rounded p-3 text-sm">
          ⚠ Рынок forex закрыт (выходные или нет свежих данных). Сигналы не появятся пока рынок не откроется.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-short/10 border border-short/30 text-short rounded p-3 text-sm">{error}</div>
      )}

      {/* THE BANNER — главное на странице */}
      <SignalBanner
        active={active}
        now={now}
        onMark={handleMark}
        currentLossStreak={userStats?.currentLossStreak ?? 0}
      />

      {/* Global candle timer — one for all 6 pairs (1m UTC boundary is shared) */}
      <GlobalCandleTimer now={now} />

      {/* 6 cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
        {symbols.length === 0 && !error && (
          <div className="col-span-full text-text-secondary text-sm p-4 bg-card rounded">
            Загрузка котировок (TwelveData)…
          </div>
        )}
        {symbols.map((s) => <SymbolCard key={s.symbol} s={s} />)}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="bg-card rounded-lg p-3 sm:p-4">
          <h2 className="text-sm font-semibold text-text-primary mb-2">История ({history.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-text-secondary text-xs border-b border-card/40">
                  <th className="text-left py-1 pr-2 font-normal">Время</th>
                  <th className="text-left py-1 pr-2 font-normal">Пара</th>
                  <th className="text-left py-1 pr-2 font-normal">Направление</th>
                  <th className="text-left py-1 pr-2 font-normal">Цена входа</th>
                  <th className="text-left py-1 font-normal">Результат</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => <HistoryRow key={h.id} h={h} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
