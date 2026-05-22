import { useEffect, useState, useCallback } from 'react'
import { getLiveGuards, type GuardsResponse, type GuardRow } from '../../api/breakoutLiveC'

const STATUS_BADGE: Record<GuardRow['status'], { bg: string; text: string; label: string }> = {
  OK:            { bg: 'bg-long/15',    text: 'text-long',    label: 'OK' },
  TRIPPED:       { bg: 'bg-short/15',   text: 'text-short',   label: 'СРАБОТАЛ' },
  NOT_ENFORCED:  { bg: 'bg-neutral/15', text: 'text-neutral', label: 'НЕ АКТИВЕН' },
  INFO:          { bg: 'bg-accent/10',  text: 'text-accent',  label: 'INFO' },
}

function fmtNum(v: number, digits = 2): string {
  if (!isFinite(v)) return '—'
  return v.toFixed(digits)
}

function fmtRemaining(g: GuardRow): string {
  if (g.status === 'NOT_ENFORCED' || g.status === 'INFO') return '—'
  if (g.unit === '$') return `${fmtNum(g.remaining, 2)} $`
  if (g.unit === '%') return `${fmtNum(g.remaining, 2)} %`
  if (g.unit === 'R') return `${fmtNum(g.remaining, 2)} R`
  return `${fmtNum(g.remaining, 0)} ${g.unit}`
}

function fmtCurrent(g: GuardRow): string {
  if (g.unit === '$') return `${fmtNum(g.current, 2)} $`
  if (g.unit === '%') return `${fmtNum(g.current, 2)} %`
  if (g.unit === 'R') return `${fmtNum(g.current, 2)} R`
  if (g.unit === 'ч') return `${fmtNum(g.current, 1)} ч`
  return `${fmtNum(g.current, 0)} ${g.unit}`
}

function fmtLimit(g: GuardRow): string {
  if (g.status === 'INFO') return '—'
  if (g.unit === '$') return `${fmtNum(g.limit, 2)} $`
  if (g.unit === '%') return `${fmtNum(g.limit, 2)} %`
  if (g.unit === 'R') return `${fmtNum(g.limit, 2)} R`
  return `${fmtNum(g.limit, 0)} ${g.unit}`
}

function ProgressBar({ ratio, status }: { ratio: number; status: GuardRow['status'] }) {
  const clamped = Math.max(0, Math.min(1, ratio))
  const pct = (clamped * 100).toFixed(1)
  // OK colour ramp: ≤50% green → 50-90% yellow → >90% orange. Только TRIPPED
  // даёт чисто-красный. Это важно для счётчиков типа "Позиций на символ" где
  // 1/1 = лимит достигнут, но НЕ превышен.
  const color =
    status === 'TRIPPED' ? 'bg-short' :
    status === 'NOT_ENFORCED' ? 'bg-neutral/50' :
    status === 'INFO' ? 'bg-accent/50' :
    clamped > 0.9 ? 'bg-accent' :
    clamped > 0.5 ? 'bg-accent/70' :
    'bg-long/80'
  return (
    <div className="h-1.5 w-full bg-input rounded overflow-hidden">
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function GuardsPanel() {
  const [data, setData] = useState<GuardsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await getLiveGuards()
      setData(r)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'load error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)  // 10s polling — match /status cadence
    return () => clearInterval(t)
  }, [load])

  const tripped = data?.guards.filter((g) => g.status === 'TRIPPED').length ?? 0

  return (
    <div className="bg-card border border-input rounded overflow-hidden mb-6">
      <div className="flex items-center justify-between px-3 py-2 border-b border-input">
        <div className="text-xs text-text-secondary">
          {loading && !data ? 'Загрузка...' : (
            <>
              UTC день: <span className="text-text-primary font-medium font-mono">{data?.utcDate ?? '—'}</span>
              {' · '}Wallet: <span className="text-text-primary font-mono">{data ? `${data.wallet.total.toFixed(2)}$` : '—'}</span>
              {tripped > 0 && (
                <span className="ml-2 text-short">
                  · Сработало: {tripped}
                </span>
              )}
            </>
          )}
        </div>
        <button
          onClick={load}
          className="px-2 py-1 text-xs bg-input hover:bg-input/70 rounded transition-colors"
        >
          ↻ Обновить
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-short bg-short/5 border-b border-input">
          {error}
        </div>
      )}

      {!data ? null : (
        <div className="divide-y divide-input">
          {data.guards.map((g) => (
            <div key={g.key} className="px-3 py-3 hover:bg-input/20 transition-colors">
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm text-text-primary font-medium">{g.label}</span>
                    <span className={`px-1.5 py-0.5 text-[10px] rounded ${STATUS_BADGE[g.status].bg} ${STATUS_BADGE[g.status].text} font-medium`}>
                      {STATUS_BADGE[g.status].label}
                    </span>
                  </div>
                  <div className="text-[11px] text-text-secondary leading-snug">{g.description}</div>
                </div>
                <div className="text-right shrink-0 font-mono text-xs">
                  <div className="text-text-primary">{fmtCurrent(g)}</div>
                  {g.status !== 'INFO' && (
                    <div className="text-text-secondary">
                      из <span className="font-medium">{fmtLimit(g)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* INFO-карточки без осмысленного fillRatio (например "Риск на сделку"
                  — это просто настройка, не порог) скрывают пустой прогресс-бар. */}
              {!(g.status === 'INFO' && g.fillRatio === 0) && (
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <ProgressBar ratio={g.fillRatio} status={g.status} />
                  </div>
                  <div className="text-[11px] font-mono w-32 text-right shrink-0">
                    {g.status === 'OK' && (
                      <span className="text-text-secondary">
                        Осталось <span className="text-long">{fmtRemaining(g)}</span>
                      </span>
                    )}
                    {g.status === 'TRIPPED' && (
                      <span className="text-short">превышен</span>
                    )}
                    {g.status === 'NOT_ENFORCED' && (
                      <span className="text-neutral">мониторинг</span>
                    )}
                    {g.status === 'INFO' && (
                      <span className="text-accent">{g.unit === 'ч' ? `до EOD ${fmtNum(g.current, 1)}ч` : ''}</span>
                    )}
                  </div>
                </div>
              )}

              {g.note && (
                <div className="mt-1.5 text-[10px] text-text-secondary italic">↳ {g.note}</div>
              )}

              {g.resetsAt && (
                <div className="mt-0.5 text-[10px] text-text-secondary">
                  ⟳ ресет: {g.resetsAt === 'next-utc-day' ? 'следующий UTC день' :
                            g.resetsAt === 'next-monday-utc' ? 'ближайший понедельник UTC' :
                            g.resetsAt}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}