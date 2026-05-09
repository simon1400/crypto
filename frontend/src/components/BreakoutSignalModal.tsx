import { useState } from 'react'
import type { BreakoutSignal } from '../api/breakoutPaper'
import { forceOpenBreakoutSignal } from '../api/breakoutPaper'
import { formatPrice } from '../lib/formatters'

interface Props {
  signal: BreakoutSignal
  onClose: () => void
  onForceOpened?: () => void
}

function fmtVolume(n: number): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(0)
  return n.toFixed(2)
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU')
}

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  NEW:     { bg: 'bg-accent/15',   text: 'text-accent' },
  ACTIVE:  { bg: 'bg-accent/15',   text: 'text-accent' },
  TP1_HIT: { bg: 'bg-long/10',     text: 'text-long' },
  TP2_HIT: { bg: 'bg-long/15',     text: 'text-long' },
  TP3_HIT: { bg: 'bg-long/20',     text: 'text-long' },
  CLOSED:  { bg: 'bg-long/10',     text: 'text-long' },
  SL_HIT:  { bg: 'bg-short/15',    text: 'text-short' },
  EXPIRED: { bg: 'bg-neutral/15',  text: 'text-neutral' },
}

export default function BreakoutSignalModal({ signal: s, onClose, onForceOpened }: Props) {
  const sideText = s.side === 'BUY' ? 'LONG' : 'SHORT'
  const sideColor = s.side === 'BUY' ? 'text-long' : 'text-short'
  const sideEmoji = s.side === 'BUY' ? '🟢' : '🔴'
  const sb = STATUS_BADGE[s.status] ?? { bg: 'bg-input', text: 'text-text-secondary' }
  const splits = [50, 30, 20]
  const volRatio = s.avgVolume > 0 ? s.volumeAtBreakout / s.avgVolume : 0

  const paperBadge = s.paperStatus === 'OPENED'
    ? { bg: 'bg-long/10',  text: 'text-long',  label: '✓ Открыто в Demo' }
    : s.paperStatus === 'SKIPPED'
    ? { bg: 'bg-short/10', text: 'text-short', label: '✕ Пропущено' }
    : { bg: 'bg-input',    text: 'text-text-secondary', label: '— ожидает' }

  const [forcing, setForcing] = useState(false)
  const [forceErr, setForceErr] = useState<string | null>(null)
  const [forceOk, setForceOk] = useState<string | null>(null)
  const canForceOpen = s.paperStatus === 'SKIPPED' && !forceOk
  async function handleForceOpen() {
    if (!confirm(`Принудительно открыть paper trade для ${s.symbol} ${sideText} на свободную маржу?`)) return
    setForcing(true); setForceErr(null)
    try {
      const r = await forceOpenBreakoutSignal(s.id)
      setForceOk(`Открыто #${r.tradeId} · margin $${r.marginUsd.toFixed(2)} · lev ${r.leverage.toFixed(1)}x`)
      onForceOpened?.()
    } catch (e: any) {
      setForceErr(e.message ?? 'force-open failed')
    } finally {
      setForcing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-primary border border-input rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-input p-4 flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xl">{sideEmoji}</span>
              <h2 className="text-xl font-semibold">{s.symbol}</h2>
              <span className={`text-lg font-medium ${sideColor}`}>{sideText}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${sb.bg} ${sb.text}`}>{s.status}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${paperBadge.bg} ${paperBadge.text}`}>
                {paperBadge.label}
              </span>
            </div>
            <p className="text-sm text-text-secondary">
              Daily Breakout · range UTC {s.rangeDate} · sig #{s.id} · {fmtTime(s.createdAt)}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">×</button>
        </div>

        <div className="p-4">
          <div className="mb-3 text-sm text-text-secondary italic">{s.reason}</div>

          {/* Paper outcome */}
          <div className={`mb-4 p-3 rounded border ${
            s.paperStatus === 'OPENED' ? 'border-long/30 bg-long/5'
            : s.paperStatus === 'SKIPPED' ? 'border-short/30 bg-short/5'
            : 'border-input bg-card'
          }`}>
            <div className="text-xs text-text-secondary mb-1">Paper trader</div>
            <div className={`font-medium ${paperBadge.text}`}>{paperBadge.label}</div>
            {s.paperReason && (
              <div className="text-sm text-text-secondary mt-1 break-words">{s.paperReason}</div>
            )}
            {s.paperUpdatedAt && (
              <div className="text-[11px] text-text-secondary mt-1">обработано {fmtTime(s.paperUpdatedAt)}</div>
            )}
            {canForceOpen && (
              <div className="mt-3">
                <button
                  onClick={handleForceOpen}
                  disabled={forcing}
                  className="px-3 py-1.5 text-sm rounded bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25 disabled:opacity-50"
                >
                  {forcing ? 'Открываю…' : '⚡ Открыть на свободную маржу'}
                </button>
                {forceErr && <div className="text-xs text-short mt-2">{forceErr}</div>}
              </div>
            )}
            {forceOk && <div className="text-xs text-long mt-2">{forceOk}</div>}
          </div>

          {/* Range + entry */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Card label="Range high"  value={formatPrice(s.rangeHigh)} />
            <Card label="Range low"   value={formatPrice(s.rangeLow)} />
            <Card label="Range size"  value={formatPrice(s.rangeSize)} />
            <Card label="Volume"      value={`${fmtVolume(s.volumeAtBreakout)} (×${volRatio.toFixed(2)} avg)`} />
            <Card label="Вход"        value={formatPrice(s.entryPrice)} />
            <Card label="SL initial"  value={formatPrice(s.initialStop)} tone="short" />
            <Card label="SL текущий"  value={formatPrice(s.currentStop)} tone="short" />
            <Card label="Realized R"  value={`${s.realizedR >= 0 ? '+' : ''}${s.realizedR.toFixed(2)}R`}
                  tone={s.realizedR > 0 ? 'long' : s.realizedR < 0 ? 'short' : 'neutral'} />
          </div>

          {/* TP ladder */}
          <h3 className="font-semibold text-sm mb-2">TP ladder</h3>
          <div className="space-y-1.5 mb-4">
            {(s.tpLadder ?? []).slice(0, 3).map((tp, i) => {
              const fill = (s.closes ?? []).find((c) => c.reason === `TP${i + 1}`)
              const isHit = !!fill
              return (
                <div key={i} className={`p-2.5 rounded border flex items-center justify-between ${
                  isHit ? 'border-long/40 bg-long/10' : 'border-input bg-card'
                }`}>
                  <div className="flex items-center gap-3">
                    <span className={`font-mono font-semibold w-12 ${isHit ? 'text-long' : ''}`}>TP{i + 1}</span>
                    <span className="font-mono">{formatPrice(tp)}</span>
                  </div>
                  <div className="text-xs text-text-secondary">
                    {splits[i]}% {isHit && fill ? <span className="text-long ml-2">✓ {fill.pnlR >= 0 ? '+' : ''}{fill.pnlR.toFixed(2)}R</span> : ''}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Closes log */}
          {(s.closes ?? []).length > 0 && (
            <>
              <h3 className="font-semibold text-sm mb-2">Закрытия</h3>
              <div className="space-y-1 mb-4 text-sm">
                {s.closes.map((c, i) => (
                  <div key={i} className="flex justify-between bg-card border border-input rounded p-2">
                    <span className="font-mono">{c.reason} @ {formatPrice(c.price)}</span>
                    <span className="text-text-secondary">{c.percent.toFixed(0)}%</span>
                    <span className={`font-mono ${c.pnlR > 0 ? 'text-long' : c.pnlR < 0 ? 'text-short' : ''}`}>
                      {c.pnlR >= 0 ? '+' : ''}{c.pnlR.toFixed(2)}R
                    </span>
                    <span className="text-xs text-text-secondary">{fmtTime(c.closedAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="text-[11px] text-text-secondary">
            Telegram: {s.notifiedTelegram ? 'отправлено' : '—'}
            {s.expiresAt && <> · истекает {fmtTime(s.expiresAt)}</>}
            {s.lastPriceCheck != null && <> · последняя цена {formatPrice(s.lastPriceCheck)} ({fmtTime(s.lastPriceCheckAt)})</>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({ label, value, tone }: { label: string; value: string; tone?: 'long' | 'short' | 'neutral' }) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-input rounded p-3">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-base font-mono font-semibold ${color}`}>{value}</div>
    </div>
  )
}
