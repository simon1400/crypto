// Legacy categories (backward compat with old signals in DB)
export const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  READY: { bg: 'bg-long/15', text: 'text-long', label: 'Ready' },
  READY_AGGRESSIVE: { bg: 'bg-long/10', text: 'text-long', label: 'Ready (Aggr)' },
  WATCHLIST: { bg: 'bg-neutral/15', text: 'text-neutral', label: 'Watchlist' },
  WAIT_CONFIRMATION: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Wait Trigger' },
  PULLBACK_WATCH: { bg: 'bg-accent/15', text: 'text-accent', label: 'Wait Pullback' },
  LATE_ENTRY: { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'Late Entry' },
  CONFLICTED: { bg: 'bg-short/15', text: 'text-short', label: 'Conflicted' },
  REJECTED: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Rejected' },
}

// New setup categories (3-layer scoring)
export const SETUP_CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  A_PLUS_READY: { bg: 'bg-long/20', text: 'text-long', label: 'A+ Ready' },
  READY: { bg: 'bg-long/15', text: 'text-long', label: 'Ready' },
  WATCHLIST: { bg: 'bg-neutral/15', text: 'text-neutral', label: 'Watchlist' },
  IGNORE: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Ignore' },
}

// Execution type styles
export const EXECUTION_TYPE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  ENTER_NOW_LONG: { bg: 'bg-long/20', text: 'text-long', label: 'Вход LONG' },
  ENTER_NOW_SHORT: { bg: 'bg-short/20', text: 'text-short', label: 'Вход SHORT' },
  LIMIT_LONG: { bg: 'bg-accent/15', text: 'text-accent', label: 'Лимит LONG' },
  LIMIT_SHORT: { bg: 'bg-accent/15', text: 'text-accent', label: 'Лимит SHORT' },
  WAIT_FOR_PULLBACK_LONG: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Откат LONG' },
  WAIT_FOR_PULLBACK_SHORT: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Откат SHORT' },
  WAIT_CONFIRMATION: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Ждать' },
  IGNORE: { bg: 'bg-neutral/10', text: 'text-neutral', label: 'Игнор' },
}

export const BAND_STYLES: Record<string, { text: string; label: string }> = {
  STRONG: { text: 'text-long', label: 'Strong' },
  ACTIONABLE: { text: 'text-accent', label: 'Actionable' },
  CONDITIONAL: { text: 'text-text-secondary', label: 'Conditional' },
  OBSERVATIONAL: { text: 'text-neutral', label: 'Observational' },
  LOW_QUALITY: { text: 'text-short', label: 'Low' },
}

export const ENTRY_Q_STYLES: Record<string, { text: string; label: string }> = {
  GOOD: { text: 'text-long', label: 'Entry: Good' },
  FAIR: { text: 'text-accent', label: 'Entry: Fair' },
  POOR: { text: 'text-orange-400', label: 'Entry: Poor' },
  CHASING: { text: 'text-short', label: 'Entry: Chasing' },
}

export const MODEL_LABELS: Record<string, string> = {
  aggressive: 'Агрессивный',
  confirmation: 'Подтверждение',
  pullback: 'Откат',
}

// Exit reason labels
export const EXIT_REASON_LABELS: Record<string, string> = {
  INITIAL_STOP: 'Стоп-лосс',
  BE_STOP: 'Стоп на BE',
  TRAILING_STOP: 'Trailing стоп',
  TIME_STOP: 'Time-стоп',
  MANUAL_EXIT: 'Ручной выход',
  TP1_PARTIAL: 'TP1 (частичное)',
  TP2_PARTIAL: 'TP2 (частичное)',
  TP3_FINAL: 'TP3 (финал)',
}

export const LOADING_MESSAGES = [
  'Сканирую монеты...',
  'Получаю данные с Bybit...',
  'Считаю индикаторы (5m, 15m, 1h, 4h)...',
  'Проверяю Funding Rate и Open Interest...',
  'Читаю новости...',
  'Определяю режим рынка...',
  'Запускаю стратегии...',
  'Hard filters + Setup Score...',
  'Entry trigger анализ...',
  'GPT-5.4 проверяет сигналы...',
  'Формирую торговый план...',
]

export const ENTRY_MESSAGES = [
  'Загружаю данные по 4 таймфреймам...',
  'Собираю уровни поддержки/сопротивления...',
  'Кластеризую уровни...',
  'Считаю точки входа...',
  'GPT-5.4 анализирует уровни...',
]
