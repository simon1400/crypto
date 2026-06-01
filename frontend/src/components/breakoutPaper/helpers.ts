import type { BreakoutTrade as PaperTrade } from '../../api/breakoutPaper'
import { PositionChartPosition } from '../PositionChartModal'
import { PAPER_STATUS_BADGE, isOpenStatus } from './constants'

/** Mapper: paper trade row → position chart payload. */
export function paperTradeToPosition(
  t: PaperTrade,
  currentPrice: number | null,
  isLive: boolean = false,
): PositionChartPosition {
  const closes = t.closes || []
  const effectivePrice = currentPrice != null
    ? currentPrice
    : (closes.length > 0 ? closes[closes.length - 1].price : null)
  return {
    coin: t.symbol,
    type: t.side === 'BUY' ? 'LONG' : 'SHORT',
    entry: t.entryPrice,
    stopLoss: t.currentStop,
    takeProfits: (t.tpLadder || []).slice(0, 3),
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    currentPrice: effectivePrice,
    partialCloses: closes.map(c => ({
      price: c.price,
      percent: c.percent,
      closedAt: c.closedAt,
      isSL: c.reason === 'SL',
    })),
    title: `${t.symbol} ${t.side === 'BUY' ? 'LONG' : 'SHORT'} (DEMO #${t.id})`,
    source: isLive ? 'binance-futures' : 'bybit',
  }
}

/**
 * Сжатый текст исхода: смотрит на массив closes и собирает «TP1 → TP2 → SL@TP1»,
 * «TP1 → EXP», «SL» и т.д. Это полезнее чем generic «Закрыта», потому что одной
 * меткой видно куда дошла сделка перед финальным выходом.
 */
export function buildOutcomeLabel(
  status: string,
  closes?: Array<{ reason?: string; reasonNote?: string }>,
): string {
  const arr = closes ?? []
  const reasons = arr.map(c => c.reason).filter(Boolean) as string[]
  // Collapse consecutive duplicate TP rungs. Legacy reconciled rows (before the
  // finalizeOrphanRow rung-aware fix) stored a runner's trailing-stop exit as a
  // second identical TP → closes=[TP1, TP1] rendered "TP1 → TP1". A genuine
  // ladder is strictly ascending (TP1→TP2→TP3) so a repeat is always an
  // artefact; TP1→TP2→TP1 (SL trailed to TP1) isn't consecutive, so it survives.
  const tpsRaw = reasons.filter(r => r === 'TP1' || r === 'TP2' || r === 'TP3')
  const tps = tpsRaw.filter((r, i) => i === 0 || r !== tpsRaw[i - 1])
  const finalReason = reasons[reasons.length - 1]
  const finalNote = arr[arr.length - 1]?.reasonNote

  // LIVE-C flatten paths (EOD-FLAT, manual, kill-switch) write the final close
  // row with reason='SL' for cid routing, but reasonNote holds the human label.
  // Detect and override the SL-trailing chain so it doesn't display "TP1 → SL@BE"
  // when the market-close was actually an EOD flatten.
  const FLATTEN_NOTES: Record<string, string> = {
    'EOD-FLAT': 'EOD',
    'manual': 'Manual',
    'kill-switch': 'Kill',
  }
  if (finalReason === 'SL' && finalNote && FLATTEN_NOTES[finalNote]) {
    const label = FLATTEN_NOTES[finalNote]
    return tps.length > 0 ? `${tps.join(' → ')} → ${label}` : label
  }

  if (isOpenStatus(status)) {
    return PAPER_STATUS_BADGE[status]?.label ?? status
  }

  // Финальный TP3
  if (status === 'TP3_HIT' || (status === 'CLOSED' && finalReason === 'TP3')) {
    return tps.length > 1 ? `${tps.slice(0, -1).join(' → ')} → TP3 ✓` : 'TP3 ✓'
  }

  // SL после частичных TP — это и есть «SL@BE» или «SL@TP1» case
  if (status === 'SL_HIT' || (status === 'CLOSED' && finalReason === 'SL')) {
    if (tps.length === 0) return 'SL'
    if (tps.length === 1) return `${tps[0]} → SL@BE`            // SL переехал в BE
    return `${tps.join(' → ')} → SL@${tps[tps.length - 2]}`     // полный трейлинг
  }

  // Истёк (EOD UTC)
  if (status === 'EXPIRED') {
    return tps.length > 0 ? `${tps.join(' → ')} → EXP` : 'Истёк'
  }

  // Ручное закрытие / margin / fallback
  if (status === 'CLOSED') {
    if (finalReason === 'MANUAL') return tps.length > 0 ? `${tps.join(' → ')} → Manual` : 'Manual'
    if (finalReason === 'MARGIN') return tps.length > 0 ? `${tps.join(' → ')} → Margin` : 'Margin'
    return tps.length > 0 ? tps.join(' → ') : 'Закрыта'
  }

  return PAPER_STATUS_BADGE[status]?.label ?? status
}

export function outcomeBadgeClasses(
  status: string,
  pnl: number,
  closes?: Array<{ reason?: string; reasonNote?: string }>,
): { bg: string; text: string } {
  if (isOpenStatus(status)) {
    return { bg: PAPER_STATUS_BADGE[status].bg, text: PAPER_STATUS_BADGE[status].text }
  }
  // EOD-FLAT / manual / kill-switch на LIVE C доходят как SL_HIT с reasonNote.
  // Цвет — по знаку P&L (не «всегда красный»), плюс заметный outline чтобы
  // визуально отличать market-close от честного TP/SL.
  const finalNote = closes && closes.length > 0 ? closes[closes.length - 1]?.reasonNote : undefined
  const isFlattenOverride = finalNote === 'EOD-FLAT' || finalNote === 'manual' || finalNote === 'kill-switch'
  if (status === 'SL_HIT' && !isFlattenOverride) return { bg: 'bg-short/15', text: 'text-short' }
  if (isFlattenOverride) {
    if (pnl > 0) return { bg: 'bg-long/5 ring-1 ring-inset ring-long/40', text: 'text-long' }
    if (pnl < 0) return { bg: 'bg-short/5 ring-1 ring-inset ring-short/40', text: 'text-short' }
    return { bg: 'bg-neutral/5 ring-1 ring-inset ring-neutral/40', text: 'text-neutral' }
  }
  // CLOSED / TP3_HIT / EXPIRED → цвет по знаку P&L
  if (pnl > 0) return { bg: 'bg-long/15', text: 'text-long' }
  if (pnl < 0) return { bg: 'bg-short/10', text: 'text-short' }
  return { bg: 'bg-neutral/15', text: 'text-neutral' }
}

export function formatElapsed(openedAt: string, closedAt?: string | null): string {
  const endMs = closedAt ? new Date(closedAt).getTime() : Date.now()
  const ms = endMs - new Date(openedAt).getTime()
  if (ms < 0) return '0м'
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}д ${hours % 24}ч`
  if (hours > 0) return `${hours}ч ${mins % 60}м`
  return `${mins}м`
}

/**
 * Compute display-side trade metrics (closed fraction, remaining position,
 * leverage, margins, isOpen/isFinished flags) — shared by mobile cards and
 * desktop table rows so both stay consistent.
 */
export function computeTradeMath(t: PaperTrade) {
  const isOpen = isOpenStatus(t.status)
  const closes = t.closes ?? []
  const closedFrac = closes.reduce((a, c) => a + c.percent, 0) / 100
  const closedPctNum = Math.round(closedFrac * 100)
  const remainingPositionUsd = t.positionSizeUsd * Math.max(0, 1 - closedFrac)
  const isFinished = ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'].includes(t.status)
  const lev = t.leverage && t.leverage > 0
    ? t.leverage
    : (t.depositAtEntryUsd > 0 && t.positionSizeUsd > 0
      ? Math.min(100, Math.max(1, t.positionSizeUsd / t.depositAtEntryUsd))
      : 1)
  const marginFull = t.marginUsd ?? (t.positionSizeUsd / lev)
  const marginRemaining = remainingPositionUsd / lev
  return { isOpen, isFinished, closedFrac, closedPctNum, remainingPositionUsd, lev, marginFull, marginRemaining }
}

/** Прага сегодня: 00:00–03:00 UTC. DST-aware через Intl. */
export function pragueRangeLabel(): string {
  const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false })
  const today = new Date()
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0))
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 3, 0, 0))
  return `${fmt.format(start)}–${fmt.format(end)} Прага`
}
