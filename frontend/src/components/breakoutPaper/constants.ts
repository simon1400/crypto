// 'SIGNALS' — таб для A/B со списком сигналов сканера.
// 'PENDING' — таб для C: висящие limit-ордера на rangeEdge до пробоя.
export type StatusFilter = 'OPEN' | 'CLOSED' | 'SIGNALS' | 'PENDING' | 'ATTEMPTS' | 'CANCELLED'

export const PAPER_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  NEW:       { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Новый' },
  ACTIVE:    { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Активен' },
  OPEN:      { bg: 'bg-accent/15',     text: 'text-accent',     label: 'Открыта' },
  TP1_HIT:   { bg: 'bg-long/10',       text: 'text-long',       label: 'TP1 ✓' },
  TP2_HIT:   { bg: 'bg-long/15',       text: 'text-long',       label: 'TP2 ✓' },
  TP3_HIT:   { bg: 'bg-long/20',       text: 'text-long',       label: 'TP3 ✓' },
  CLOSED:    { bg: 'bg-long/10',       text: 'text-long',       label: 'Закрыта' },
  SL_HIT:    { bg: 'bg-short/15',      text: 'text-short',      label: 'SL' },
  EXPIRED:   { bg: 'bg-neutral/15',    text: 'text-neutral',    label: 'Истёк' },
  PENDING:       { bg: 'bg-accent/10', text: 'text-accent/80',  label: '⏳ Лимит ждёт' },
  PENDING_LIMIT: { bg: 'bg-accent/10', text: 'text-accent/80',  label: '⏳ Лимит ждёт' },
  CANCELLED:     { bg: 'bg-neutral/15', text: 'text-neutral',   label: 'Лимит отменён' },
  CANCELLED_EOD: { bg: 'bg-neutral/15', text: 'text-neutral',   label: 'Лимит отменён EOD' },
}

export const ACTIVE_STATUSES = ['OPEN', 'TP1_HIT', 'TP2_HIT'] as const
export const CLOSED_STATUSES = ['CLOSED', 'SL_HIT', 'EXPIRED', 'TP3_HIT'] as const

export const CLOSED_PAGE_SIZE = 20
export const SIGNALS_PAGE_SIZE = 20

export function isOpenStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status)
}

export function isFinishedStatus(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status)
}
