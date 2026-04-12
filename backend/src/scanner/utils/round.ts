/**
 * Адаптивное округление цены с учётом магнитуды.
 * Большие цены → 2 знака после запятой, средние → 4, маленькие (альты) → 6.
 *
 * Используется везде где нужно округлить цену к выводу/сохранению
 * без потери точности для дешёвых монет.
 */
export function round(v: number): number {
  if (v > 100) return Math.round(v * 100) / 100
  if (v > 1) return Math.round(v * 10000) / 10000
  return Math.round(v * 1000000) / 1000000
}

/** Ровно 2 знака после запятой (проценты, USDT суммы). */
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Форматирование цены в строку с сохранением точности для дешёвых альтов. */
export function fmtPrice(v: number): string {
  if (v >= 1000) return v.toFixed(2)
  if (v >= 1) return v.toFixed(4)
  if (v >= 0.01) return v.toFixed(6)
  return v.toFixed(8)
}
