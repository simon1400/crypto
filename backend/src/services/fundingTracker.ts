import { prisma } from '../db/prisma'
import { adjustVirtualBalance } from './virtualBalance'

/**
 * Funding rate каждые 8 часов на perpetual фьючерсах Bybit (00:00, 08:00, 16:00 UTC).
 *
 * Логика:
 * 1. Каждые 5 минут проверяем не пересекли ли мы funding boundary с момента lastFundingAt сделки.
 * 2. Для всех OPEN/PARTIALLY_CLOSED сделок фетчим текущий fundingRate с Bybit ticker API.
 * 3. Считаем funding на текущую долю позиции:
 *    fundingAmount = notional × fundingRate × direction
 *    LONG  + положительный rate → платим (минус)
 *    LONG  + отрицательный      → получаем (плюс)
 *    SHORT + положительный      → получаем
 *    SHORT + отрицательный      → платим
 * 4. Списываем/начисляем virtualBalance, обновляем trade.fundingPaid и lastFundingAt.
 */

const FUNDING_HOURS_UTC = [0, 8, 16]

interface BybitTicker {
  symbol: string
  fundingRate: string
  nextFundingTime: string
}

const tickerCache = new Map<string, { rate: number; at: number }>()
const TICKER_TTL = 60 * 1000 // 1 минута

async function fetchFundingRate(symbol: string): Promise<number | null> {
  const cached = tickerCache.get(symbol)
  if (cached && Date.now() - cached.at < TICKER_TTL) return cached.rate

  try {
    const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { result?: { list?: BybitTicker[] } }
    const ticker = data.result?.list?.[0]
    if (!ticker?.fundingRate) return null
    const rate = parseFloat(ticker.fundingRate)
    if (Number.isNaN(rate)) return null
    tickerCache.set(symbol, { rate, at: Date.now() })
    return rate
  } catch (err: any) {
    console.warn(`[FundingTracker] Failed to fetch funding for ${symbol}:`, err.message)
    return null
  }
}

/**
 * Возвращает массив timestamp'ов funding boundaries (UTC),
 * которые произошли между from и to (исключая from, включая to).
 */
function fundingBoundariesBetween(from: Date, to: Date): Date[] {
  const result: Date[] = []
  const cursor = new Date(from)
  cursor.setUTCMinutes(0, 0, 0)
  // Шагаем по часам — функция вызывается раз в 5 мин, окна маленькие
  while (cursor <= to) {
    if (cursor > from && FUNDING_HOURS_UTC.includes(cursor.getUTCHours())) {
      result.push(new Date(cursor))
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1)
  }
  return result
}

export async function processFunding(): Promise<void> {
  const now = new Date()

  const trades = await prisma.trade.findMany({
    where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
  })

  if (!trades.length) return

  for (const trade of trades) {
    try {
      // Дата от которой считаем funding boundaries
      const since = trade.lastFundingAt ?? trade.openedAt
      const boundaries = fundingBoundariesBetween(since, now)

      if (boundaries.length === 0) continue

      const remainingPct = 100 - trade.closedPct
      if (remainingPct <= 0) continue

      const remainingMargin = trade.amount * (remainingPct / 100)
      const notional = remainingMargin * trade.leverage

      const rate = await fetchFundingRate(trade.coin)
      if (rate == null) continue

      // direction: +1 если platим, -1 если получаем
      // LONG + положительный rate → платим
      const direction = trade.type === 'LONG' ? 1 : -1
      const sign = rate >= 0 ? 1 : -1
      const isPaying = direction === sign

      // Применяем за каждое пройденное окно (обычно одно)
      const totalFunding = notional * Math.abs(rate) * boundaries.length * (isPaying ? 1 : -1)

      // Списываем из баланса (положительный = платим = минус из баланса)
      await adjustVirtualBalance(
        -totalFunding,
        `funding ${trade.coin} #${trade.id} (${boundaries.length}× rate ${(rate * 100).toFixed(4)}%)`,
      )

      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          fundingPaid: { increment: totalFunding },
          lastFundingAt: boundaries[boundaries.length - 1],
        },
      })
    } catch (err: any) {
      console.error(`[FundingTracker] Trade #${trade.id} error:`, err.message)
    }
  }
}

let started = false
export function startFundingTracker(): void {
  if (started) return
  started = true

  // Запускаем сразу при старте, потом каждые 5 минут
  processFunding().catch(err => console.error('[FundingTracker] Initial run error:', err.message))

  setInterval(() => {
    processFunding().catch(err => console.error('[FundingTracker] Interval error:', err.message))
  }, 5 * 60 * 1000)

  console.log('[FundingTracker] Started — checking every 5 minutes')
}
