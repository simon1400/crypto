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

export const VALID_INTERVALS = Object.keys(INTERVAL_MAP)

export async function fetchKlines(symbol: string, interval: string, count: number = 500): Promise<BybitKline[]> {
  if (!INTERVAL_MAP[interval]) {
    throw new Error(`Invalid interval '${interval}'. Valid: ${VALID_INTERVALS.join(', ')}`)
  }

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
