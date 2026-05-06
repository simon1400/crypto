import { useState } from 'react'
import {
  type PaperTrade, type PaperClose,
  editPaperTrade, deletePaperTrade,
  closePaperTradeMarket, closePaperTradeManual,
} from '../api/levelsPaper'

interface Props {
  trade: PaperTrade
  onClose: () => void
  onUpdate?: (updated: PaperTrade) => void
  onDelete?: (id: number) => void
}

function fmt(n: number, dec = 5): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  return n.toFixed(dec)
}
function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : ''}$${Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)}`
}
function dec(symbol: string, market: string): number {
  if (market === 'CRYPTO') return symbol.includes('USDT') ? 2 : 6
  if (/^XAU|^XAG/.test(symbol)) return 2
  if (/JPY/.test(symbol)) return 3
  return 5
}
function pct(from: number, to: number, side: 'BUY' | 'SELL'): string {
  if (!from) return ''
  const v = ((to - from) / from) * 100 * (side === 'BUY' ? 1 : -1)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

const isOpen = (status: string) => ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(status)
const STATUS_OPTIONS = ['OPEN', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'CLOSED', 'SL_HIT', 'EXPIRED']

export default function PaperTradeModal({ trade: initialTrade, onClose, onUpdate, onDelete }: Props) {
  const [trade, setTrade] = useState<PaperTrade>(initialTrade)
  const d = dec(trade.symbol, trade.market)
  const sideText = trade.side === 'BUY' ? 'LONG' : 'SHORT'
  const sideColor = trade.side === 'BUY' ? 'text-long' : 'text-short'
  const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴'
  const splits = [50, 30, 20]

  const [editing, setEditing] = useState(false)
  const [editEntry, setEditEntry] = useState(trade.entryPrice)
  const [editSL, setEditSL] = useState(trade.currentStop)
  const [editInitialSL, setEditInitialSL] = useState(trade.initialStop)
  const [editTPs, setEditTPs] = useState<number[]>(trade.tpLadder.slice(0, 3))
  const [editFees, setEditFees] = useState<string>(trade.feesRoundTripPct?.toString() ?? '')
  const [editAutoTrail, setEditAutoTrail] = useState<boolean | null>(trade.autoTrailingSL)
  const [editStatus, setEditStatus] = useState<string>(trade.status)
  const [editCloses, setEditCloses] = useState<PaperClose[]>(trade.closes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCloseManual, setShowCloseManual] = useState(false)
  const [closePrice, setClosePrice] = useState(trade.lastPriceCheck ?? trade.entryPrice)
  const [closePercent, setClosePercent] = useState(100)

  const enterEdit = () => {
    setEditing(true)
    setEditEntry(trade.entryPrice); setEditSL(trade.currentStop)
    setEditInitialSL(trade.initialStop)
    setEditTPs(trade.tpLadder.slice(0, 3))
    setEditFees(trade.feesRoundTripPct?.toString() ?? '')
    setEditAutoTrail(trade.autoTrailingSL)
    setEditStatus(trade.status)
    setEditCloses(trade.closes)
    setError(null)
  }
  const cancelEdit = () => { setEditing(false); setError(null) }

  const saveEdit = async () => {
    setBusy(true); setError(null)
    try {
      const filledTps = editTPs.filter(p => p > 0)
      const fullLadder = [...filledTps, ...trade.tpLadder.slice(filledTps.length)]
      const feesParsed = editFees === '' ? null : Number(editFees)
      if (feesParsed !== null && (isNaN(feesParsed) || feesParsed < 0)) {
        setError('Комиссия — число или пусто')
        setBusy(false); return
      }
      const updated = await editPaperTrade(trade.id, {
        entryPrice: editEntry,
        stopLoss: editInitialSL !== trade.initialStop ? editInitialSL : undefined,
        initialStop: editInitialSL,
        currentStop: editSL,
        tpLadder: fullLadder,
        feesRoundTripPct: feesParsed,
        autoTrailingSL: editAutoTrail,
        status: editStatus !== trade.status ? editStatus : undefined,
        closes: editCloses,
      })
      setTrade(updated); setEditing(false); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  const deleteTrade = async () => {
    if (!confirm(`Удалить демо-сделку #${trade.id} (${trade.symbol} ${sideText})? Действие необратимо.`)) return
    setBusy(true); setError(null)
    try {
      await deletePaperTrade(trade.id)
      onDelete?.(trade.id)
      onClose()
    } catch (e: any) { setError(e.message); setBusy(false) }
  }

  const closeMarket = async () => {
    if (!confirm('Закрыть оставшуюся часть демо-сделки по текущей рыночной цене?')) return
    setBusy(true); setError(null)
    try {
      const updated = await closePaperTradeMarket(trade.id)
      setTrade(updated); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }
  const closeAtPrice = async () => {
    if (closePrice <= 0) { setError('Укажи цену'); return }
    setBusy(true); setError(null)
    try {
      const updated = await closePaperTradeManual(trade.id, closePrice, closePercent)
      setTrade(updated); setShowCloseManual(false); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  // Helpers for editing closes log
  const updateClose = (idx: number, patch: Partial<PaperClose>) => {
    setEditCloses(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c))
  }
  const removeClose = (idx: number) => {
    setEditCloses(prev => prev.filter((_, i) => i !== idx))
  }
  const addClose = () => {
    setEditCloses(prev => [...prev, {
      price: trade.lastPriceCheck ?? trade.entryPrice,
      percent: 100,
      pnlR: 0,
      pnlUsd: 0,
      closedAt: new Date().toISOString(),
      reason: 'MANUAL',
    }])
  }

  const canEdit = isOpen(trade.status)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-primary border border-input rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-input p-4 flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">{sideEmoji}</span>
              <h2 className="text-xl font-semibold">{trade.symbol}</h2>
              <span className={`text-lg font-medium ${sideColor}`}>{sideText}</span>
              <span className="px-2 py-0.5 bg-accent/15 text-accent text-xs rounded">DEMO</span>
              <span className="text-xs text-text-secondary">#{trade.id}</span>
            </div>
            <p className="text-sm text-text-secondary">
              {trade.market} · открыто {new Date(trade.openedAt).toLocaleString('ru-RU')}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">×</button>
        </div>

        <div className="p-4">
          {error && (
            <div className="bg-short/15 border border-short/30 text-short rounded p-2 text-sm mb-3">{error}</div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {!editing ? (
              <>
                <button onClick={enterEdit} disabled={busy}
                  className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium hover:bg-input">
                  ✏ Редактировать
                </button>
                {canEdit && (
                  <>
                    <button onClick={closeMarket} disabled={busy}
                      className="px-3 py-1.5 bg-short/15 border border-short/40 text-short rounded text-sm font-medium hover:bg-short/25">
                      Закрыть по рынку
                    </button>
                    <button onClick={() => setShowCloseManual(!showCloseManual)} disabled={busy}
                      className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium hover:bg-input">
                      Закрыть по цене
                    </button>
                  </>
                )}
                <button onClick={deleteTrade} disabled={busy}
                  className="px-3 py-1.5 bg-short/10 border border-short/40 text-short rounded text-sm font-medium hover:bg-short/20 ml-auto">
                  🗑 Удалить
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
                  {busy ? 'Закрываю...' : 'Подтвердить'}
                </button>
                <button onClick={() => setShowCloseManual(false)} disabled={busy}
                  className="px-3 py-1.5 bg-card border border-input rounded text-sm font-medium">Отмена</button>
              </div>
            </div>
          )}

          {/* Position info — USD-based */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PriceCard label="Размер позиции" value={`$${trade.positionSizeUsd.toFixed(0)}`}
              sub={`Депо при входе: $${trade.depositAtEntryUsd.toFixed(2)}`} />
            <PriceCard label="Риск" value={`$${trade.riskUsd.toFixed(2)}`}
              sub={`Net P&L: ${fmtUsd(trade.netPnlUsd)}`}
              tone={trade.netPnlUsd > 0 ? 'long' : trade.netPnlUsd < 0 ? 'short' : 'neutral'} />
          </div>

          {/* Geometry */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            {editing ? (
              <EditableCard label="Вход" dec={d} value={editEntry} onChange={setEditEntry} />
            ) : (
              <PriceCard label="Вход" value={fmt(trade.entryPrice, d)} />
            )}
            {editing ? (
              <EditableCard label="SL текущий" dec={d} tone="short" value={editSL} onChange={setEditSL} />
            ) : (
              <PriceCard label="SL" value={fmt(trade.currentStop, d)}
                sub={pct(trade.entryPrice, trade.currentStop, trade.side)} tone="short" />
            )}
          </div>

          {editing && (
            <div className="grid grid-cols-2 gap-3 mb-3">
              <EditableCard label="SL initial" dec={d} tone="short" value={editInitialSL} onChange={setEditInitialSL} />
              <div className="bg-card border border-accent/40 rounded p-3">
                <label className="block text-xs text-text-secondary mb-1">Status <span className="text-accent">✏</span></label>
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full bg-input border border-input rounded px-2 py-1 font-mono text-sm">
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Per-trade overrides */}
          {editing && (
            <div className="bg-card border border-input rounded p-3 mb-3">
              <h4 className="font-semibold text-xs mb-2 text-text-secondary">Параметры сделки</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-secondary mb-1">Комиссия round-trip (%)</label>
                  <input type="number" step={0.01} min={0} value={editFees}
                    placeholder="из настроек"
                    onChange={(e) => setEditFees(e.target.value)}
                    className="w-full bg-input border border-input rounded px-2 py-1 font-mono text-sm" />
                  <div className="text-xs text-text-secondary mt-1">Пусто = из настроек</div>
                </div>
                <div>
                  <label className="block text-xs text-text-secondary mb-1">Авто-перенос SL (TP1→BE...)</label>
                  <select value={editAutoTrail === null ? 'default' : editAutoTrail ? 'on' : 'off'}
                    onChange={(e) => {
                      const v = e.target.value
                      setEditAutoTrail(v === 'default' ? null : v === 'on')
                    }}
                    className="w-full bg-input border border-input rounded px-2 py-1 font-mono text-sm">
                    <option value="default">Из настроек</option>
                    <option value="on">Включён</option>
                    <option value="off">Отключён</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Show effective per-trade settings */}
          {!editing && (trade.feesRoundTripPct !== null || trade.autoTrailingSL !== null) && (
            <div className="bg-card border border-input rounded p-2 mb-4 flex gap-4 text-xs flex-wrap">
              {trade.feesRoundTripPct !== null && (
                <span><span className="text-text-secondary">Комиссия:</span> <span className="font-mono">{trade.feesRoundTripPct}%</span></span>
              )}
              {trade.autoTrailingSL !== null && (
                <span><span className="text-text-secondary">Авто-SL:</span> <span className="font-mono">{trade.autoTrailingSL ? 'ВКЛ' : 'ВЫКЛ'}</span></span>
              )}
            </div>
          )}

          {/* TP ladder */}
          <h3 className="font-semibold text-sm mb-2">TP ladder</h3>
          <div className="space-y-1.5 mb-4">
            {(editing ? editTPs : trade.tpLadder.slice(0, 3)).map((tp, i) => {
              const fill = trade.closes.find((c) => c.reason === `TP${i + 1}`)
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
                <div key={i} className={`p-2.5 rounded border flex items-center justify-between ${
                  isHit ? 'border-long/40 bg-long/10' : 'border-input bg-card'
                }`}>
                  <div className="flex items-center gap-3">
                    <span className={`font-mono font-semibold w-12 ${isHit ? 'text-long' : ''}`}>TP{i + 1}</span>
                    <span className="font-mono">{fmt(tp, d)}</span>
                    <span className="text-xs text-text-secondary">{pct(trade.entryPrice, tp, trade.side)}</span>
                  </div>
                  <div className="text-xs text-text-secondary">
                    {splits[i]}% {isHit && fill ? <span className="text-long ml-2">✓ {fmtUsd(fill.pnlUsd)}</span> : ''}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <PriceCard label="Status" value={trade.status} />
            <PriceCard label="Realized $" value={fmtUsd(trade.realizedPnlUsd)}
              tone={trade.realizedPnlUsd > 0 ? 'long' : trade.realizedPnlUsd < 0 ? 'short' : 'neutral'} />
            <PriceCard label="Fees $" value={`-$${trade.feesPaidUsd.toFixed(2)}`} />
          </div>

          {/* Closes log */}
          {(editing ? editCloses : trade.closes).length > 0 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">Закрытия</h3>
                {editing && (
                  <button onClick={addClose} className="text-xs text-accent hover:underline">+ добавить</button>
                )}
              </div>
              <div className="space-y-1 mb-4 text-sm">
                {(editing ? editCloses : trade.closes).map((c, i) => editing ? (
                  <div key={i} className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto] gap-2 bg-card border border-input rounded p-2 items-center">
                    <select value={c.reason} onChange={(e) => updateClose(i, { reason: e.target.value as PaperClose['reason'] })}
                      className="bg-input border border-input rounded px-1 py-0.5 text-xs font-mono">
                      <option value="TP1">TP1</option>
                      <option value="TP2">TP2</option>
                      <option value="TP3">TP3</option>
                      <option value="SL">SL</option>
                      <option value="EXPIRED">EXP</option>
                      <option value="MANUAL">MAN</option>
                    </select>
                    <input type="number" step={Math.pow(10, -d)} value={c.price} placeholder="цена"
                      onChange={(e) => updateClose(i, { price: parseFloat(e.target.value) || 0 })}
                      className="bg-input border border-input rounded px-2 py-0.5 font-mono text-xs" />
                    <input type="number" min={0} max={100} value={c.percent} placeholder="%"
                      onChange={(e) => updateClose(i, { percent: parseFloat(e.target.value) || 0 })}
                      className="bg-input border border-input rounded px-2 py-0.5 font-mono text-xs" />
                    <input type="number" step={0.01} value={c.pnlR} placeholder="pnlR"
                      onChange={(e) => updateClose(i, { pnlR: parseFloat(e.target.value) || 0 })}
                      className="bg-input border border-input rounded px-2 py-0.5 font-mono text-xs" />
                    <input type="number" step={0.01} value={c.pnlUsd} placeholder="pnlUsd"
                      onChange={(e) => updateClose(i, { pnlUsd: parseFloat(e.target.value) || 0 })}
                      className="bg-input border border-input rounded px-2 py-0.5 font-mono text-xs" />
                    <button onClick={() => removeClose(i)} className="text-short hover:text-short/80 px-1">×</button>
                  </div>
                ) : (
                  <div key={i} className="grid grid-cols-5 gap-2 bg-card border border-input rounded p-2 items-center">
                    <span className="font-mono">{c.reason} @ {fmt(c.price, d)}</span>
                    <span className="text-text-secondary">{c.percent.toFixed(0)}%</span>
                    <span className={`font-mono text-sm ${c.pnlUsd > 0 ? 'text-long' : c.pnlUsd < 0 ? 'text-short' : ''}`}>
                      {fmtUsd(c.pnlUsd)}
                    </span>
                    <span className={`font-mono text-xs ${c.pnlR > 0 ? 'text-long' : c.pnlR < 0 ? 'text-short' : ''}`}>
                      {c.pnlR >= 0 ? '+' : ''}{c.pnlR.toFixed(2)}R
                    </span>
                    <span className="text-xs text-text-secondary text-right">
                      {new Date(c.closedAt).toLocaleTimeString('ru-RU')}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PriceCard({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'long' | 'short' | 'neutral';
}) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-input rounded p-3">
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
