import { useState } from 'react'
import {
  type BreakoutTrade as PaperTrade, type BreakoutClose as PaperClose,
  type BreakoutTradeLive,
  type BreakoutVariant,
  editBreakoutPaperTrade as editPaperTrade, deleteBreakoutPaperTrade as deletePaperTrade,
  closeBreakoutPaperTradeMarket as closePaperTradeMarket, closeBreakoutPaperTradeManual as closePaperTradeManual,
  simulateBreakoutPaperFill,
} from '../api/breakoutPaper'
import { formatPrice } from '../lib/formatters'

interface Props {
  trade: PaperTrade
  /** Live unrealized snapshot from /trades/live poller. Optional — only useful for OPEN trades. */
  live?: BreakoutTradeLive | null
  onClose: () => void
  onUpdate?: (updated: PaperTrade) => void
  onDelete?: (id: number) => void
  /** Which paper-trader variant this modal acts on. Defaults to 'A'. */
  variant?: BreakoutVariant
}

function fmtDuration(fromIso: string, toIso?: string | null): string {
  const from = new Date(fromIso).getTime()
  const to = toIso ? new Date(toIso).getTime() : Date.now()
  const sec = Math.max(0, Math.round((to - from) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}д ${h}ч`
  if (h > 0) return `${h}ч ${m}м`
  return `${m}м`
}

function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : ''}$${Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)}`
}
// Шаг для <input type="number"> от величины цены — соответствует точности formatPrice.
function priceStep(ref: number): number {
  const a = Math.abs(ref)
  if (a >= 1) return 0.01
  if (a >= 0.01) return 0.0001
  return 0.00001
}
function pct(from: number, to: number, side: 'BUY' | 'SELL'): string {
  if (!from) return ''
  const v = ((to - from) / from) * 100 * (side === 'BUY' ? 1 : -1)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

const isOpen = (status: string) => ['OPEN', 'TP1_HIT', 'TP2_HIT'].includes(status)
const STATUS_OPTIONS = ['OPEN', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'CLOSED', 'SL_HIT', 'EXPIRED']

export default function PaperTradeModal({ trade: initialTrade, live = null, onClose, onUpdate, onDelete, variant = 'A' }: Props) {
  const [trade, setTrade] = useState<PaperTrade>(initialTrade)
  const step = priceStep(trade.entryPrice)
  const sideText = trade.side === 'BUY' ? 'LONG' : 'SHORT'
  const sideColor = trade.side === 'BUY' ? 'text-long' : 'text-short'
  const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴'
  const splits = [50, 30, 20]
  const isStillOpen = isOpen(trade.status)
  const tpFillsCount = trade.closes.filter(c => c.reason === 'TP1' || c.reason === 'TP2' || c.reason === 'TP3').length
  const closedFrac = trade.closes.reduce((a, c) => a + c.percent, 0) / 100
  const remainingPositionUsd = trade.positionSizeUsd * Math.max(0, 1 - closedFrac)
  const closedPctNum = Math.round(closedFrac * 100)
  const lev = trade.leverage && trade.leverage > 0
    ? trade.leverage
    : (trade.depositAtEntryUsd > 0 && trade.positionSizeUsd > 0
      ? Math.min(100, Math.max(1, trade.positionSizeUsd / trade.depositAtEntryUsd))
      : 1)
  const marginFull = trade.marginUsd ?? (trade.positionSizeUsd / lev)
  const marginRemaining = marginFull * Math.max(0, 1 - closedFrac)
  const slPct = ((trade.currentStop - trade.entryPrice) / trade.entryPrice) * 100 * (trade.side === 'BUY' ? 1 : -1)
  const slInitialPct = ((trade.initialStop - trade.entryPrice) / trade.entryPrice) * 100 * (trade.side === 'BUY' ? 1 : -1)
  const slMoved = trade.currentStop !== trade.initialStop
  const livePrice = live?.currentPrice ?? trade.lastPriceCheck ?? null
  const remainingPnl = isStillOpen && live ? (live.remainingUnrealizedPnl ?? live.unrealizedPnl) : 0
  const remainingPnlPct = isStillOpen && live ? (live.remainingUnrealizedPnlPct ?? live.unrealizedPnlPct) : 0
  const totalPnl = isStillOpen && live ? trade.realizedPnlUsd - trade.feesPaidUsd + remainingPnl : trade.netPnlUsd

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
      }, variant)
      setTrade(updated); setEditing(false); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  const deleteTrade = async () => {
    if (!confirm(`Удалить демо-сделку #${trade.id} (${trade.symbol} ${sideText})? Действие необратимо.`)) return
    setBusy(true); setError(null)
    try {
      await deletePaperTrade(trade.id, variant)
      onDelete?.(trade.id)
      onClose()
    } catch (e: any) { setError(e.message); setBusy(false) }
  }

  const fillAt = async (reason: 'TP1' | 'TP2' | 'TP3' | 'SL') => {
    const what = reason === 'SL'
      ? `Закрыть остаток по SL @ ${formatPrice(trade.currentStop)}?`
      : `Закрыть ${[50, 30, 20][reason === 'TP1' ? 0 : reason === 'TP2' ? 1 : 2]}% по ${reason} @ ${formatPrice(trade.tpLadder[reason === 'TP1' ? 0 : reason === 'TP2' ? 1 : 2])}?`
    if (!confirm(what)) return
    setBusy(true); setError(null)
    try {
      const updated = await simulateBreakoutPaperFill(trade.id, reason, variant)
      setTrade(updated); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  const closeMarket = async () => {
    if (!confirm('Закрыть оставшуюся часть демо-сделки по текущей рыночной цене?')) return
    setBusy(true); setError(null)
    try {
      const updated = await closePaperTradeMarket(trade.id, variant)
      setTrade(updated); onUpdate?.(updated)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }
  const closeAtPrice = async () => {
    if (closePrice <= 0) { setError('Укажи цену'); return }
    setBusy(true); setError(null)
    try {
      const updated = await closePaperTradeManual(trade.id, closePrice, closePercent, variant)
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
        className="bg-primary border border-input rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
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
              открыто {new Date(trade.openedAt).toLocaleString('ru-RU')}
              <span className="mx-2 text-text-secondary/50">·</span>
              <span title="Длительность сделки">⏱ {fmtDuration(trade.openedAt, trade.closedAt)}</span>
              {trade.closedAt && (
                <>
                  <span className="mx-2 text-text-secondary/50">·</span>
                  закрыто {new Date(trade.closedAt).toLocaleString('ru-RU')}
                </>
              )}
              {isStillOpen && trade.expiresAt && (
                <>
                  <span className="mx-2 text-text-secondary/50">·</span>
                  <span title="Когда EOD-движок закроет/откроет проверки">
                    истекает {new Date(trade.expiresAt).toLocaleString('ru-RU')}
                  </span>
                </>
              )}
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              <span title="ID сигнала-источника (3h breakout setup)">signal #{trade.signalId}</span>
              {trade.lastPriceCheckAt && (
                <>
                  <span className="mx-2 text-text-secondary/50">·</span>
                  <span title="Последняя проверка цены движком">
                    last tick {new Date(trade.lastPriceCheckAt).toLocaleTimeString('ru-RU')}
                  </span>
                </>
              )}
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
                  <input type="number" step={step} value={closePrice}
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

          {/* Симуляция fill TP/SL — повторяет логику движка (TP=maker, SL=taker+slip,
              авто-трейлинг). Доступно только для открытых сделок и не в режиме редактирования. */}
          {!editing && canEdit && (
            <div className="bg-card border border-input rounded p-3 mb-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-sm">Быстрое закрытие</h4>
                <span className="text-[10px] text-text-secondary">по уровню (как движок)</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(['TP1', 'TP2', 'TP3'] as const).map((tp, i) => {
                  const tpHit = tpFillsCount > i
                  const tpExpected = tpFillsCount === i
                  const tpPrice = trade.tpLadder[i]
                  const split = [50, 30, 20][i]
                  return (
                    <button
                      key={tp}
                      onClick={() => fillAt(tp)}
                      disabled={busy || !tpExpected || !tpPrice}
                      title={tpHit ? 'уже закрыт' : !tpExpected ? `сначала закрой TP${tpFillsCount + 1}` : `закрыть по ${tp} @ ${tpPrice ? formatPrice(tpPrice) : '—'}`}
                      className={`px-3 py-2 rounded text-sm font-medium border transition ${
                        tpHit
                          ? 'bg-long/10 border-long/40 text-long/60 cursor-not-allowed'
                          : tpExpected
                          ? 'bg-long/15 border-long/40 text-long hover:bg-long/25'
                          : 'bg-card border-input text-text-secondary cursor-not-allowed opacity-50'
                      }`}
                    >
                      <div className="font-mono font-bold">{tpHit ? '✓ ' : ''}{tp}</div>
                      <div className="text-[10px] opacity-80 font-mono">
                        {tpPrice ? formatPrice(tpPrice) : '—'} · {split}%
                      </div>
                    </button>
                  )
                })}
                <button
                  onClick={() => fillAt('SL')}
                  disabled={busy}
                  title={`закрыть по SL @ ${formatPrice(trade.currentStop)} (${tpFillsCount > 0 ? 'CLOSED' : 'SL_HIT'})`}
                  className="px-3 py-2 rounded text-sm font-medium border bg-short/15 border-short/40 text-short hover:bg-short/25 transition"
                >
                  <div className="font-mono font-bold">SL</div>
                  <div className="text-[10px] opacity-80 font-mono">
                    {formatPrice(trade.currentStop)} · {Math.round((1 - closedFrac) * 100)}%
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Position info — USD-based */}
          <div className="grid grid-cols-4 gap-3 mb-3">
            <PriceCard
              label="Размер позиции"
              value={isStillOpen && closedPctNum > 0 && closedPctNum < 100
                ? `$${remainingPositionUsd.toFixed(0)}`
                : `$${trade.positionSizeUsd.toFixed(0)}`}
              sub={isStillOpen && closedPctNum > 0 && closedPctNum < 100
                ? `было $${trade.positionSizeUsd.toFixed(0)} · закрыто ${closedPctNum}%`
                : `депо при входе $${trade.depositAtEntryUsd.toFixed(2)}`}
            />
            <PriceCard
              label="Маржа"
              value={isStillOpen && closedPctNum > 0 && closedPctNum < 100
                ? `$${marginRemaining.toFixed(2)}`
                : `$${marginFull.toFixed(2)}`}
              sub={isStillOpen && closedPctNum > 0 && closedPctNum < 100
                ? `было $${marginFull.toFixed(2)}`
                : undefined}
            />
            <div className="bg-card border border-input rounded p-3">
              <div className="text-xs text-text-secondary">Плечо</div>
              <div className="mt-1">
                <span className="inline-block px-2 py-0.5 rounded text-sm font-bold font-mono bg-accent/15 text-accent">
                  ×{lev.toFixed(1)}
                </span>
              </div>
              <div className="text-xs text-text-secondary mt-0.5">{trade.positionUnits.toFixed(4)} units</div>
            </div>
            <PriceCard
              label="Риск (initial)"
              value={`$${trade.riskUsd.toFixed(2)}`}
              sub={`R-multiple: ${trade.realizedR >= 0 ? '+' : ''}${trade.realizedR.toFixed(2)}R`}
              tone={trade.realizedR > 0 ? 'long' : trade.realizedR < 0 ? 'short' : 'neutral'}
            />
          </div>

          {/* Geometry — entry / current price / SL initial / SL current */}
          <div className="grid grid-cols-4 gap-3 mb-3">
            {editing ? (
              <EditableCard label="Вход" step={step} value={editEntry} onChange={setEditEntry} />
            ) : (
              <PriceCard label="Вход" value={formatPrice(trade.entryPrice)} />
            )}
            {!editing && (
              isStillOpen && livePrice != null ? (
                <PriceCard
                  label="Текущая цена"
                  value={formatPrice(livePrice)}
                  sub={live ? `unreal: ${fmtUsd(remainingPnl)} (${remainingPnlPct >= 0 ? '+' : ''}${remainingPnlPct.toFixed(2)}%)` : 'нет live'}
                  tone={remainingPnl > 0 ? 'long' : remainingPnl < 0 ? 'short' : 'neutral'}
                />
              ) : (
                <PriceCard
                  label="Последняя цена"
                  value={livePrice != null ? formatPrice(livePrice) : '—'}
                />
              )
            )}
            {editing ? (
              <EditableCard label="SL initial" step={step} tone="short" value={editInitialSL} onChange={setEditInitialSL} />
            ) : (
              <PriceCard
                label="SL initial"
                value={formatPrice(trade.initialStop)}
                sub={`${slInitialPct >= 0 ? '+' : ''}${slInitialPct.toFixed(2)}%`}
                tone="short"
              />
            )}
            {editing ? (
              <EditableCard label="SL текущий" step={step} tone="short" value={editSL} onChange={setEditSL} />
            ) : (
              <PriceCard
                label={slMoved ? 'SL trailed' : 'SL текущий'}
                value={formatPrice(trade.currentStop)}
                sub={`${slPct >= 0 ? '+' : ''}${slPct.toFixed(2)}%${slMoved ? ` · сдвинут с ${formatPrice(trade.initialStop)}` : ''}`}
                tone={slPct >= 0 ? (trade.side === 'BUY' ? 'long' : 'short') : 'short'}
              />
            )}
          </div>

          {/* Big progress tracker — full width, only for open trades */}
          {!editing && isStillOpen && livePrice != null && trade.tpLadder.length > 0 && (
            <ProgressTracker trade={trade} price={livePrice} />
          )}

          {editing && (
            <div className="grid grid-cols-2 gap-3 mb-3">
              <EditableCard label="SL initial" step={step} tone="short" value={editInitialSL} onChange={setEditInitialSL} />
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
          {!editing && (trade.feeTakerPct !== null || trade.feesRoundTripPct !== null || trade.autoTrailingSL !== null) && (
            <div className="bg-card border border-input rounded p-2 mb-4 flex gap-4 text-xs flex-wrap">
              {trade.feeTakerPct !== null ? (
                <>
                  <span><span className="text-text-secondary">Taker:</span> <span className="font-mono">{trade.feeTakerPct}%</span></span>
                  {trade.feeMakerPct !== null && (
                    <span><span className="text-text-secondary">Maker:</span> <span className="font-mono">{trade.feeMakerPct}%</span></span>
                  )}
                  {trade.slipTakerPct !== null && (
                    <span><span className="text-text-secondary">Slip:</span> <span className="font-mono">{trade.slipTakerPct}%</span></span>
                  )}
                  {trade.slipPaidUsd > 0 && (
                    <span><span className="text-text-secondary">Slip paid:</span> <span className="font-mono">-${trade.slipPaidUsd.toFixed(2)}</span></span>
                  )}
                </>
              ) : trade.feesRoundTripPct !== null && (
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
                  <input type="number" step={step} value={tp}
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
                    <span className="font-mono">{formatPrice(tp)}</span>
                    <span className="text-xs text-text-secondary">{pct(trade.entryPrice, tp, trade.side)}</span>
                  </div>
                  <div className="text-xs text-text-secondary">
                    {splits[i]}% {isHit && fill ? <span className="text-long ml-2">✓ {fmtUsd(fill.pnlUsd)}</span> : ''}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Stats — для открытых: Realized + Unrealized = Total. Для закрытых: только Net. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <PriceCard label="Status" value={trade.status} />
            <PriceCard
              label={isStillOpen ? 'Реализовано' : 'Net P&L'}
              value={fmtUsd(isStillOpen ? trade.realizedPnlUsd - trade.feesPaidUsd : trade.netPnlUsd)}
              sub={isStillOpen
                ? `gross ${fmtUsd(trade.realizedPnlUsd)} − fees $${trade.feesPaidUsd.toFixed(2)}`
                : `R: ${trade.realizedR >= 0 ? '+' : ''}${trade.realizedR.toFixed(2)}`}
              tone={(isStillOpen ? trade.realizedPnlUsd - trade.feesPaidUsd : trade.netPnlUsd) > 0 ? 'long'
                : (isStillOpen ? trade.realizedPnlUsd - trade.feesPaidUsd : trade.netPnlUsd) < 0 ? 'short' : 'neutral'}
            />
            {isStillOpen && (
              <PriceCard
                label="Unrealized"
                value={live ? fmtUsd(remainingPnl) : '—'}
                sub={live ? `${remainingPnlPct >= 0 ? '+' : ''}${remainingPnlPct.toFixed(2)}% на остаток` : 'нет live'}
                tone={remainingPnl > 0 ? 'long' : remainingPnl < 0 ? 'short' : 'neutral'}
              />
            )}
            {isStillOpen && (
              <PriceCard
                label="Total (тек.)"
                value={live ? fmtUsd(totalPnl) : fmtUsd(trade.realizedPnlUsd - trade.feesPaidUsd)}
                sub="реализовано + unreal"
                tone={totalPnl > 0 ? 'long' : totalPnl < 0 ? 'short' : 'neutral'}
              />
            )}
            {!isStillOpen && (
              <PriceCard label="Fees $" value={`-$${trade.feesPaidUsd.toFixed(2)}`} />
            )}
            {!isStillOpen && trade.slipPaidUsd > 0 && (
              <PriceCard label="Slip $" value={`-$${trade.slipPaidUsd.toFixed(2)}`} />
            )}
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
                    <input type="number" step={step} value={c.price} placeholder="цена"
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
                    <span className="font-mono">{c.reason} @ {formatPrice(c.price)}</span>
                    <span className="text-text-secondary">{c.percent.toFixed(0)}%</span>
                    <span className={`font-mono text-sm ${c.pnlUsd > 0 ? 'text-long' : c.pnlUsd < 0 ? 'text-short' : ''}`}>
                      {fmtUsd(c.pnlUsd)}
                    </span>
                    <span className={`font-mono text-xs ${c.pnlR > 0 ? 'text-long' : c.pnlR < 0 ? 'text-short' : ''}`}>
                      {c.pnlR >= 0 ? '+' : ''}{c.pnlR.toFixed(2)}R
                    </span>
                    <span className="text-xs text-text-secondary text-right" title={new Date(c.closedAt).toLocaleString('ru-RU')}>
                      {new Date(c.closedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
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

// Большой трекер прогресса — детальная версия мини-бара из таблицы.
// Anchor (середина шкалы) = entry до TP1, TP1 после TP1_HIT, TP2 после TP2_HIT.
// Линейка показывает SL ← anchor → следующий TP с маркером цены.
function ProgressTracker({ trade, price }: { trade: PaperTrade; price: number }) {
  const tps = trade.tpLadder.slice(0, 3)
  const tpIdx = trade.status === 'TP2_HIT' ? 2 : trade.status === 'TP1_HIT' ? 1 : 0
  const nextTp = tps[tpIdx] ?? tps[tps.length - 1]
  const tpLabel = `TP${tpIdx + 1}`
  const sl = trade.currentStop
  const entry = trade.entryPrice
  const isLong = trade.side === 'BUY'
  const prevTp = tpIdx > 0 ? tps[tpIdx - 1] : null
  const anchor = prevTp ?? entry
  const slLocksProfit = isLong ? sl >= entry : sl <= entry
  const slLabel = slLocksProfit ? (sl === entry ? 'BE' : 'lock') : 'SL'
  const distToTp = Math.abs(nextTp - anchor)
  const distToSl = Math.abs(sl - anchor)
  if (distToTp <= 0 && distToSl <= 0) return null
  const favorableMove = isLong ? (price - anchor) : (anchor - price)
  const towardSL = favorableMove < 0 && distToSl > 0
  const halfRatio = favorableMove >= 0
    ? (distToTp > 0 ? Math.min(1, favorableMove / distToTp) : 0)
    : (distToSl > 0 ? Math.min(1, -favorableMove / distToSl) : 0)
  const markerPct = towardSL ? 50 - halfRatio * 50 : 50 + halfRatio * 50
  const labelPct = Math.round(halfRatio * 100)
  const dangerZone = towardSL && !slLocksProfit && labelPct >= 75
  const fillColor = towardSL
    ? (slLocksProfit ? '#848e9c' : '#f6465d')
    : '#0ecb81'
  const labelColorCls = towardSL
    ? (slLocksProfit ? 'text-text-secondary' : 'text-short')
    : 'text-long'
  const anchorLabel = prevTp ? `TP${tpIdx}` : 'entry'
  // Цена в процентах от anchor — для подсказки риск/профит сейчас.
  const priceFromAnchorPct = anchor > 0 ? ((price - anchor) / anchor) * 100 * (isLong ? 1 : -1) : 0
  const distToTpPct = anchor > 0 ? ((nextTp - anchor) / anchor) * 100 * (isLong ? 1 : -1) : 0
  const distToSlPct = anchor > 0 ? ((sl - anchor) / anchor) * 100 * (isLong ? 1 : -1) : 0

  return (
    <div className="bg-card border border-input rounded p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-sm">Прогресс к {tpLabel}</h4>
        <span className={`text-xs font-mono ${labelColorCls}`}>
          {labelPct === 0
            ? (slLocksProfit ? 'в безриске' : `на ${anchorLabel}`)
            : `${labelPct}% ${towardSL ? `к ${slLabel}${dangerZone ? ' ⚠' : ''}` : `к ${tpLabel}`}`}
        </span>
      </div>
      <div className="relative h-3 bg-input rounded overflow-hidden">
        <div className="absolute top-0 bottom-0 w-px bg-text-secondary/60" style={{ left: '50%' }} />
        <div
          className="absolute top-0 h-full"
          style={{
            left: towardSL ? `${markerPct}%` : '50%',
            width: `${Math.abs(markerPct - 50)}%`,
            background: fillColor,
            opacity: 0.85,
          }}
        />
        {/* Маркер цены */}
        <div
          className="absolute top-[-3px] bottom-[-3px] w-[2px] bg-text-primary"
          style={{ left: `calc(${markerPct}% - 1px)` }}
          title={`Цена ${formatPrice(price)}`}
        />
      </div>
      <div className="grid grid-cols-3 mt-1.5 text-[11px] font-mono">
        <div className={`text-left ${slLocksProfit ? 'text-text-secondary' : 'text-short'}`}>
          <div className="font-semibold">{slLabel}</div>
          <div>{formatPrice(sl)}</div>
          <div className="text-[10px] opacity-70">
            {distToSlPct >= 0 ? '+' : ''}{distToSlPct.toFixed(2)}%
          </div>
        </div>
        <div className="text-center text-text-secondary">
          <div className="font-semibold">{anchorLabel}</div>
          <div>{formatPrice(anchor)}</div>
          <div className="text-[10px] opacity-70">
            цена {priceFromAnchorPct >= 0 ? '+' : ''}{priceFromAnchorPct.toFixed(2)}%
          </div>
        </div>
        <div className="text-right text-long">
          <div className="font-semibold">{tpLabel}</div>
          <div>{formatPrice(nextTp)}</div>
          <div className="text-[10px] opacity-70">
            {distToTpPct >= 0 ? '+' : ''}{distToTpPct.toFixed(2)}%
          </div>
        </div>
      </div>
    </div>
  )
}

function EditableCard({ label, value, onChange, step, tone }: {
  label: string; value: number; onChange: (v: number) => void; step: number; tone?: 'long' | 'short';
}) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className="bg-card border border-accent/40 rounded p-3">
      <div className="text-xs text-text-secondary">{label} <span className="text-accent">✏</span></div>
      <input type="number" step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full bg-input border border-input rounded px-2 py-1 font-mono font-semibold ${color}`} />
    </div>
  )
}
