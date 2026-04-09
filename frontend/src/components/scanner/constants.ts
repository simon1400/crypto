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

export const LOADING_MESSAGES = [
  'Сканирую монеты...',
  'Получаю данные с MEXC...',
  'Считаю индикаторы (15m, 1h, 4h)...',
  'Проверяю Funding Rate и Open Interest...',
  'Читаю новости...',
  'Определяю режим рынка...',
  'Запускаю стратегии...',
  'Считаю скоринг...',
  'GPT-5.4 проверяет сигналы...',
  'Формирую торговый план...',
]

export const ENTRY_MESSAGES = [
  'Загружаю данные по 3 таймфреймам...',
  'Собираю уровни поддержки/сопротивления...',
  'Кластеризую уровни...',
  'Считаю точки входа...',
  'GPT-5.4 анализирует уровни...',
]
