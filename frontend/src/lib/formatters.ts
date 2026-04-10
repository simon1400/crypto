export function formatDate(d: string): string {
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateShort(d: string): string {
  return new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatPrice(n: number | null): string {
  if (n === null || n === undefined) return '-'
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(2)
  if (n >= 0.01) return n.toFixed(4)
  return n.toFixed(5)
}

export function formatPricePrecise(n: number | null): string {
  if (n === null || n === undefined) return '-'
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

export function formatPnl(value: number): string {
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(value).toFixed(2)}`
}

/**
 * Ровно 2 знака после точки. Для процентов, USDT сумм, P&L.
 * 14.8       → "14.80"
 * 14         → "14.00"
 * -6.21345   → "-6.21"
 */
export function fmt2(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0.00'
  return Number(value).toFixed(2)
}

/** Со знаком +/−, ровно 2 знака: +14.80, -6.21 */
export function fmt2Signed(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0.00'
  const n = Number(value)
  return (n > 0 ? '+' : '') + n.toFixed(2)
}

/**
 * Цена монеты — минимум 2 знака, но сохраняет точность для дешёвых альтов.
 * 50000      → "50000.00"
 * 14.8       → "14.80"
 * 0.003256   → "0.003256"   (не обрезается)
 */
export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0.00'
  const n = Number(value)
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 20,
    useGrouping: false,
  })
}

export function pnlColor(v: number): string {
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : 'text-text-secondary'
}
