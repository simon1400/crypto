// === Trade status mappings ===
export const TRADE_STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  PENDING_ENTRY: { bg: 'bg-purple-500/10', text: 'text-purple-400', label: 'Ожидание входа' },
  OPEN: { bg: 'bg-accent/10', text: 'text-accent', label: 'Открыта' },
  PARTIALLY_CLOSED: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Частично' },
  CLOSED: { bg: 'bg-long/10', text: 'text-long', label: 'Закрыта' },
  SL_HIT: { bg: 'bg-short/10', text: 'text-short', label: 'Стоп-лосс' },
  CANCELLED: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Отменена' },
}

// === Scanner signal status mappings ===
export const SCANNER_STATUS_MAP: Record<string, { label: string; color: string }> = {
  NEW: { label: 'Новый', color: 'text-accent bg-accent/10' },
  TAKEN: { label: 'Открыт', color: 'text-blue-400 bg-blue-400/10' },
  PARTIALLY_CLOSED: { label: 'Частично', color: 'text-purple-400 bg-purple-400/10' },
  CLOSED: { label: 'Закрыт', color: 'text-long bg-long/10' },
  SL_HIT: { label: 'Стоп-лосс', color: 'text-short bg-short/10' },
  EXPIRED: { label: 'Пропущен', color: 'text-neutral bg-neutral/10' },
  INVALIDATED: { label: 'Невалидный', color: 'text-orange-400 bg-orange-400/10' },
}

// === Strategy mappings ===
export const STRATEGY_MAP: Record<string, { label: string; color: string }> = {
  trend_follow: { label: 'Тренд', color: 'text-blue-400 bg-blue-400/10' },
  mean_revert: { label: 'Реверс', color: 'text-purple-400 bg-purple-400/10' },
  breakout: { label: 'Пробой', color: 'text-orange-400 bg-orange-400/10' },
}

