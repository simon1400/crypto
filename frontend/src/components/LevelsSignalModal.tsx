import { useState } from 'react'
import {
  type LevelsSignal,
  editLevelsSignal, closeLevelsSignalMarket, closeLevelsSignalManual,
  cancelPendingLevelsSignal,
} from '../api/levels'
import { fmtPrice } from '../lib/formatters'

interface Props {
  signal: LevelsSignal
  onClose: () => void
  onUpdate?: (updated: LevelsSignal) => void
}

function fmt(n: number): string {
  if (n == null || isNaN(n)) return '—'
  return fmtPrice(n)
}
function pct(from: number, to: number, side: 'BUY' | 'SELL'): string {
  if (!from) return ''
  const v = ((to - from) / from) * 100 * (side === 'BUY' ? 1 : -1)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function rDist(entry: number, sl: number, target: number, side: 'BUY' | 'SELL'): string {
  const risk = Math.abs(entry - sl)
  if (risk === 0) return ''
  const dist = side === 'BUY' ? target - entry : entry - target
  const r = dist / risk
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
}

const isOpen = (status: string) => ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(status)
const isPending = (status: string) => ['PENDING', 'AWAITING_CONFIRM'].includes(status)

export default function LevelsSignalModal({ signal: initialSignal, onClose, onUpdate }: Props) {
  const [signal, setSignal] = useState<LevelsSignal>(initialSignal)
  // Decimals for number inputs — based on price magnitude
  const sample = signal.entryPrice || signal.level
  const d = sample >= 100 ? 2 : sample >= 1 ? 4 : sample >= 0.01 ? 5 : 8
  const sideText = signal.side === 'BUY' ? 'LONG' : 'SHORT'
  const sideColor = signal.side === 'BUY' ? 'text-long' : 'text-short'
  const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴'
  const eventText = signal.event === 'BREAKOUT_RETEST' ? 'Pierce & Retest' : 'Reaction'
  const splits = [50, 30, 20]

  // Edit state
  const [editing, setEditing] = useState(false)
  const [editEntry, setEditEntry] = useState(signal.entryPrice)
  const [editSL, setEditSL] = useState(signal.currentStop)
  const [editTPs, setEditTPs] = useState<number[]>(signal.tpLadder.slice(0, 3))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Close UI state
  const [showCloseManual, setShowCloseManual] = useState(false)
  const [closePrice, setClosePrice] = useState(signal.lastPriceCheck ?? signal.entryPrice)
  const [closePercent, setClosePercent] = useState(100)

  const enterEdit = () => {
    setEditing(true)
    setEditEntry(signal.entryPrice)
    setEditSL(signal.currentStop)
    setEditTPs(signal.tpLadder.slice(0, 3))
    setError(null)
  }
  const cancelEdit = () => { setEditing(false); setError(null) }
  const saveEdit = async () => {
    setBusy(true); setError(null)
    try {
      const filledTps = editTPs.filter(p => p > 0)
      const fullLadder = [...filledTps, ...signal.tpLadder.slice(filledTps.length)]
      const updated = await editLevelsSignal(signal.id, {
        entryPrice: editEntry,
        stopLoss: editSL,
        tpLadder: fullLadder,
      })
      setSignal(updated)
      setEditing(false)
      onUpdate?.(updated)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const closeMarket = async () => {
    if (!confirm('Закрыть оставшуюся часть позиции по текущей рыночной цене?')) return
    setBusy(true); setError(null)
    try {
      const updated = await closeLevelsSignalMarket(signal.id)
      setSignal(updated)
      onUpdate?.(updated)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const closeAtPrice = async () => {
    if (closePrice <= 0) { setError('Укажи цену'); return }
    setBusy(true); setError(null)
    try {
      const updated = await closeLevelsSignalManual(signal.id, closePrice, closePercent)
      setSignal(updated)
      setShowCloseManual(false)
      onUpdate?.(updated)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const canEdit = isOpen(signal.status)
  const canCancelPending = isPending(signal.status)
  const cancelPending = async () => {
    if (!confirm('Отменить ожидающий лимит-ордер?')) return
    setBusy(true); setError(null)
    try {
      const updated = await cancelPendingLevelsSignal(signal.id)
      setSignal(updated)
      onUpdate?.(updated)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-primary border border-input rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-input p-4 flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">{sideEmoji}</span>
              <h2 className="text-xl font-semibold">{signal.symbol}</h2>
              <span className={`text-lg font-medium ${sideColor}`}>{sideText}</span>
              {signal.isFiboConfluence && (
                <span className="px-2 py-0.5 bg-accent/15 text-accent text-xs rounded">🌀 Fibo</span>
              )}
            </div>
            <p className="text-sm text-text-secondary">
              {eventText} @ {signal.source} {fmt(signal.level)} · {new Date(signal.createdAt).toLocaleString('ru-RU')}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">×</button>
        </div>

        <div className="p-4">
          <div className="mb-4 text-sm text-text-secondary italic">{signal.reason}</div>

          {error && (
            <div className="bg-short/15 border border-short/30 text-short rounded p-2 text-sm mb-3">{error}</div>
          )}

          {/* Cancel pending limit (PENDING / AWAITING_CONFIRM only) */}
          {canCancelPending && (
            <div className="flex gap-2 mb-4 flex-wrap">
              <button onClick={cancelPending} disabled={busy}
                className="px-3 py-1.5 bg-short/15 border border-short/40 text-short rounded text-sm font-medium hover:bg-short/25">
                ❎ Отменить лимит
              </button>
              {signal.entryMode === 'LIMIT' && signal.pendingExpiresAt && signal.status === 'PENDING' && (
                <span className="px-3 py-1.5 bg-card border border-input rounded text-xs text-text-secondary">
                  ⏰ Истекает: {new Date(signal.pendingExpiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {signal.status === 'AWAITING_CONFIRM' && signal.entryFilledAt && (
                <span className="px-3 py-1.5 bg-purple-500/15 border border-purple-500/40 text-purple-300 rounded text-xs">
                  Лимит исполнен в {new Date(signal.entryFilledAt).toLocaleTimeString('ru-RU')}, жду подтверждения
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          {canEdit && (
            <div className="flex gap-2 mb-4 flex-wrap">
              {!editing ? (
                <>
                  <button onClick={enterEdit} disabled={busy}
                    className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium hover:bg-input">
                    ✏ Редактировать
                  </button>
                  <button onClick={closeMarket} disabled={busy}
                    className="px-3 py-1.5 bg-short/15 border border-short/40 text-short rounded text-sm font-medium hover:bg-short/25">
                    Закрыть по рынку
                  </button>
                  <button onClick={() => setShowCloseManual(!showCloseManual)} disabled={busy}
                    className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium hover:bg-input">
                    Закрыть по цене
                  </button>
                </>
              ) : (
                <>
                  <button onClick={saveEdit} disabled={busy}
                    className="px-3 py-1.5 bg-accent text-primary rounded text-sm font-medium hover:bg-accent/90">
                    {busy ? 'Сохраняю...' : 'Сохранить'}
                  </button>
                  <button onClick={cancelEdit} disabled={busy}
                    className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium hover:bg-input">
                    Отмена
                  </button>
                </>
              )}
            </div>
          )}

          {/* Manual close form */}
          {showCloseManual && canEdit && !editing && (
            <div className="bg-card border border-input rounded p-3 mb-4">
              <h4 className="font-semibold text-sm mb-2">Закрытие по конкретной цене</h4>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-text-secondary mb-1">Цена</label>
                  <input type="number" step={Math.pow(10, -d)} value={closePrice}
                    onChange={(e) => setClosePrice(parseFloat(e.target.value) || 0)}
                    className="w-full bg-input border border-input rounded px-2 py-1 font-mono text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-text-secondary mb-1">Процент закрытия</label>
                  <input type="number" min={1} max={100} value={closePercent}
                    onChange={(e) => setClosePercent(parseInt(e.target.value) || 100)}
                    className="w-full bg-input border border-input rounded px-2 py-1 font-mono text-sm" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={closeAtPrice} disabled={busy}
                  className="px-3 py-1.5 bg-accent text-primary rounded text-sm font-medium">
                  {busy ? 'Закрываю...' : 'Подтвердить закрытие'}
                </button>
                <button onClick={() => setShowCloseManual(false)} disabled={busy}
                  className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium">Отмена</button>
              </div>
            </div>
          )}

          {/* Geometry — view or edit */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PriceCard label="Уровень" value={fmt(signal.level)} sub={signal.source} />
            {editing ? (
              <EditableCard label="Вход" dec={d}
                value={editEntry} onChange={setEditEntry} />
            ) : (
              <PriceCard label="Вход" value={fmt(signal.entryPrice)} sub="" />
            )}
            {editing ? (
              <EditableCard label="SL" dec={d} tone="short"
                value={editSL} onChange={setEditSL} />
            ) : (
              <PriceCard
                label="SL (current)"
                value={fmt(signal.currentStop)}
                sub={pct(signal.entryPrice, signal.currentStop, signal.side)}
                tone="short"
              />
            )}
            {!editing && (
              <PriceCard
                label="SL initial"
                value={fmt(signal.initialStop)}
                sub={pct(signal.entryPrice, signal.initialStop, signal.side)}
                tone="short"
                dim
              />
            )}
          </div>

          {/* TP ladder */}
          <h3 className="font-semibold text-sm mb-2">TP ladder</h3>
          <div className="space-y-1.5 mb-4">
            {(editing ? editTPs : signal.tpLadder.slice(0, 3)).map((tp, i) => {
              const fill = signal.closes.find((c) => c.reason === `TP${i + 1}`)
              const isHit = !!fill
              return editing ? (
                <div key={i} className="p-2.5 rounded border border-input bg-card flex items-center gap-3">
                  <span className="font-mono font-semibold w-12">TP{i + 1}</span>
                  <input type="number" step={Math.pow(10, -d)} value={tp}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value) || 0
                      setEditTPs(prev => prev.map((p, j) => j === i ? v : p))
                    }}
                    className="flex-1 bg-input border border-input rounded px-2 py-1 font-mono text-sm" />
                  <span className="text-xs text-text-secondary">{splits[i]}%</span>
                </div>
              ) : (
                <div
                  key={i}
                  className={`p-2.5 rounded border flex items-center justify-between ${
                    isHit ? 'border-long/40 bg-long/10' : 'border-input bg-card'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`font-mono font-semibold w-12 ${isHit ? 'text-long' : ''}`}>TP{i + 1}</span>
                    <span className="font-mono">{fmt(tp)}</span>
                    <span className="text-xs text-text-secondary">{pct(signal.entryPrice, tp, signal.side)}</span>
                    <span className="text-xs text-accent">{rDist(signal.entryPrice, signal.initialStop, tp, signal.side)}</span>
                  </div>
                  <div className="text-xs text-text-secondary">
                    {splits[i]}% {isHit && fill ? <span className="text-long ml-2">✓ {fill.pnlR >= 0 ? '+' : ''}{fill.pnlR.toFixed(2)}R</span> : ''}
                  </div>
                </div>
              )
            })}
            {!editing && signal.tpLadder.length > 3 && (
              <div className="text-xs text-text-secondary px-2">
                +{signal.tpLadder.length - 3} дальних TP не торгуются (ladder=3)
              </div>
            )}
          </div>

          {/* Status & R */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PriceCard label="Status" value={signal.status} sub="" />
            <PriceCard
              label="Realized R"
              value={`${signal.realizedR >= 0 ? '+' : ''}${signal.realizedR.toFixed(2)}R`}
              sub=""
              tone={signal.realizedR > 0 ? 'long' : signal.realizedR < 0 ? 'short' : 'neutral'}
            />
          </div>

          {/* Closes log */}
          {signal.closes.length > 0 && (
            <>
              <h3 className="font-semibold text-sm mb-2">Закрытия</h3>
              <div className="space-y-1 mb-4 text-sm">
                {signal.closes.map((c, i) => (
                  <div key={i} className="flex justify-between bg-card border border-input rounded p-2">
                    <span className="font-mono">{c.reason} @ {fmt(c.price)}</span>
                    <span className="text-text-secondary">{c.percent.toFixed(0)}%</span>
                    <span className={`font-mono ${c.pnlR > 0 ? 'text-long' : c.pnlR < 0 ? 'text-short' : ''}`}>
                      {c.pnlR >= 0 ? '+' : ''}{c.pnlR.toFixed(2)}R
                    </span>
                    <span className="text-xs text-text-secondary">{new Date(c.closedAt).toLocaleTimeString('ru-RU')}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {signal.fiboImpulse && (
            <div className="bg-accent/5 border border-accent/20 rounded p-3 text-sm">
              <div className="font-semibold mb-1">🌀 Fibo Impulse</div>
              <div className="text-text-secondary">
                {signal.fiboImpulse.direction} · {signal.fiboImpulse.sizeAtr.toFixed(1)}×ATR ·
                {' '}{fmt(signal.fiboImpulse.fromPrice)} → {fmt(signal.fiboImpulse.toPrice)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PriceCard({ label, value, sub, tone, dim }: {
  label: string; value: string; sub?: string;
  tone?: 'long' | 'short' | 'neutral'; dim?: boolean;
}) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className={`bg-card border border-input rounded p-3 ${dim ? 'opacity-60' : ''}`}>
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-base font-mono font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-text-secondary">{sub}</div>}
    </div>
  )
}

function EditableCard({ label, value, onChange, dec, tone }: {
  label: string; value: number; onChange: (v: number) => void; dec: number; tone?: 'long' | 'short';
}) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-accent/40 rounded p-3">
      <div className="text-xs text-text-secondary">{label} <span className="text-accent">✏</span></div>
      <input type="number" step={Math.pow(10, -dec)} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full bg-input border border-input rounded px-2 py-1 font-mono font-semibold ${color}`} />
    </div>
  )
}
