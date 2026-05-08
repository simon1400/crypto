import { fetchBingxKlines } from './bingxMarket'

export interface BybitKline {
  time: number    // Unix timestamp in seconds (for lightweight-charts)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1D': 'D',
  'M': 'M',
}

// BingX интервалы — для fallback на 403 от Bybit. 'M' (monthly) у BingX нет.
const BINGX_INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
}

export const VALID_INTERVALS = Object.keys(INTERVAL_MAP)

async function fetchFromBybit(symbol: string, interval: string, count: number): Promise<BybitKline[]> {
  const bybitInterval = INTERVAL_MAP[interval]
  const batchSize = 1000
  const allCandles: BybitKline[] = []
  let endTime: number | undefined = undefined

  while (allCandles.length < count) {
    const limit = Math.min(batchSize, count - allCandles.length)
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`
    if (endTime !== undefined) {
      url += `&end=${endTime}`
    }

    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Bybit API error: ${res.status} ${res.statusText}`)
    }

    const json = await res.json() as any
    if (json.retCode !== 0) {
      throw new Error(`Bybit error: ${json.retMsg}`)
    }

    const list: string[][] = json.result?.list || []
    if (list.length === 0) break

    const batch: BybitKline[] = list.map((item) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    }))

    allCandles.push(...batch)

    // Bybit returns newest-first; the last item in list is the oldest
    // Use oldest candle's startTime - 1ms as end for next request
    const oldestTime = Number(list[list.length - 1][0])
    endTime = oldestTime - 1

    if (list.length < limit) break
  }

  // Deduplicate by time
  const seen = new Set<number>()
  const unique = allCandles.filter((c) => {
    if (seen.has(c.time)) return false
    seen.add(c.time)
    return true
  })

  // Sort ascending (oldest first)
  unique.sort((a, b) => a.time - b.time)

  return unique.slice(-count)
}

async function fetchFromBingx(symbol: string, interval: string, count: number): Promise<BybitKline[]> {
  const bingxInterval = BINGX_INTERVAL_MAP[interval]
  if (!bingxInterval) {
    throw new Error(`BingX fallback не поддерживает interval '${interval}'`)
  }
  // BingX limit per request is 1000; loop pagination is не нужна для type Daily ≤ 500
  const candles = await fetchBingxKlines(symbol, bingxInterval, Math.min(count, 1000))
  // BingX time уже в ms, конвертируем в seconds для lightweight-charts
  return candles.map(c => ({
    time: Math.floor(c.time / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  })).slice(-count)
}

export async function fetchKlines(symbol: string, interval: string, count: number = 500): Promise<BybitKline[]> {
  if (!INTERVAL_MAP[interval]) {
    throw new Error(`Invalid interval '${interval}'. Valid: ${VALID_INTERVALS.join(', ')}`)
  }

  // Bybit primary, BingX fallback. Bybit на VPS иногда возвращает 403 (geo / rate
  // limit / temp ban). Без fallback график у пользователя ломается совсем.
  try {
    return await fetchFromBybit(symbol, interval, count)
  } catch (e: any) {
    const isBlocked = /403|Forbidden|429|ECONN|fetch failed/i.test(e?.message ?? '')
    if (!isBlocked) throw e
    console.warn(`[klines] Bybit failed for ${symbol} (${e.message}), falling back to BingX`)
    try {
      return await fetchFromBingx(symbol, interval, count)
    } catch (e2: any) {
      // Возвращаем оригинальную ошибку Bybit — она информативнее для пользователя.
      throw new Error(`Bybit ${e.message}; BingX fallback also failed: ${e2.message}`)
    }
  }
}
