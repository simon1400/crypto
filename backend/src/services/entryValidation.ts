/**
 * Validate entry/SL/TP geometry for a trade about to be opened.
 *
 * Поводом стал баг 02.05.26 (signal #888 / trade #239 ATUSDT):
 * пользователь взял лимитный сигнал по market через 1ч 45м, цена ушла
 * на +8.6%, и TP1 ($0.171906) оказался НИЖЕ фактической entry ($0.18114).
 * scannerTracker мгновенно "сработал" TP1 как закрытие 40% с убытком,
 * затем сдвинул SL в BE и закрыл оставшиеся 60%. Сделка длилась 3 секунды
 * с итогом −2.71$.
 *
 * Эта функция блокирует открытие, если геометрия уже сломана.
 */

const MAX_SLIPPAGE_PCT = 1.5

export interface ValidatedTp {
  price: number
  percent: number
}

export interface EntryValidationParams {
  type: 'LONG' | 'SHORT'
  plannedEntry: number
  actualEntry: number
  stopLoss: number
  takeProfits: { price: number; percent: number }[]
  /** market-ордера допускают slippage; для limit slippage не существует. */
  isMarket: boolean
}

export class EntryGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EntryGeometryError'
  }
}

/**
 * Бросает EntryGeometryError, если по фактической entry цена уже не имеет смысла:
 * - LONG: SL >= entry или хотя бы один TP <= entry
 * - SHORT: SL <= entry или хотя бы один TP >= entry
 * - market-ордер ушёл больше чем на MAX_SLIPPAGE_PCT от плановой entry
 */
export function validateEntryGeometry(p: EntryValidationParams): void {
  const { type, plannedEntry, actualEntry, stopLoss, takeProfits, isMarket } = p
  const isLong = type === 'LONG'

  if (!Number.isFinite(actualEntry) || actualEntry <= 0) {
    throw new EntryGeometryError('Не удалось получить корректную цену входа')
  }

  if (isMarket && plannedEntry > 0) {
    const slipPct = Math.abs(actualEntry - plannedEntry) / plannedEntry * 100
    if (slipPct > MAX_SLIPPAGE_PCT) {
      throw new EntryGeometryError(
        `Цена ушла на ${slipPct.toFixed(2)}% от плановой ($${plannedEntry} → $${actualEntry}). ` +
        `Лимит: ${MAX_SLIPPAGE_PCT}%. Возьмите по limit или дождитесь нового сигнала.`
      )
    }
  }

  if (isLong) {
    if (stopLoss >= actualEntry) {
      throw new EntryGeometryError(
        `LONG: SL ($${stopLoss}) выше или равен entry ($${actualEntry}) — открытие невозможно`
      )
    }
    const badTps = takeProfits.filter(tp => tp.price <= actualEntry)
    if (badTps.length) {
      const list = badTps.map(tp => `$${tp.price}`).join(', ')
      throw new EntryGeometryError(
        `LONG: TP уровни ниже entry ($${actualEntry}): ${list}. Цена ушла за TP — сигнал устарел.`
      )
    }
  } else {
    if (stopLoss <= actualEntry) {
      throw new EntryGeometryError(
        `SHORT: SL ($${stopLoss}) ниже или равен entry ($${actualEntry}) — открытие невозможно`
      )
    }
    const badTps = takeProfits.filter(tp => tp.price >= actualEntry)
    if (badTps.length) {
      const list = badTps.map(tp => `$${tp.price}`).join(', ')
      throw new EntryGeometryError(
        `SHORT: TP уровни выше entry ($${actualEntry}): ${list}. Цена ушла за TP — сигнал устарел.`
      )
    }
  }
}
