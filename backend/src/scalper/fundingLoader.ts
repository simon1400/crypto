/**
 * Bybit funding rate loader с локальным кэшем (file-based JSON).
 *
 * Bybit API: GET /v5/market/funding/history
 *   - max 200 records per request
 *   - paginate backward через `endTime`
 *   - 8h intervals on most perpetuals
 *
 * Каждое значение fundingRate is decimal (e.g. 0.0001 = 0.01%).
 * Положительный rate = longs платят shorts. Отрицательный = shorts платят longs.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface FundingPoint {
  time: number          // unix ms (start of funding period)
  rate: number          // decimal: 0.0001 = 0.01%
}

const CACHE_DIR = path.resolve(__dirname, '../../.cache/funding')
const BYBIT_API = 'https://api.bybit.com/v5/market/funding/history'
const PAGE_LIMIT = 200

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}

function cacheFile(symbol: string): string {
  return path.join(CACHE_DIR, `${symbol}.json`)
}

function loadCache(symbol: string): FundingPoint[] {
  const f = cacheFile(symbol)
  if (!fs.existsSync(f)) return []
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'))
  } catch { return [] }
}

function saveCache(symbol: string, points: FundingPoint[]): void {
  ensureCacheDir()
  fs.writeFileSync(cacheFile(symbol), JSON.stringify(points))
}

async function fetchPage(symbol: string, endTimeMs?: number): Promise<FundingPoint[]> {
  const params = new URLSearchParams({
    category: 'linear',
    symbol,
    limit: PAGE_LIMIT.toString(),
  })
  if (endTimeMs) params.set('endTime', endTimeMs.toString())
  const url = `${BYBIT_API}?${params}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Bybit funding API ${resp.status}`)
  const json = await resp.json() as any
  if (json.retCode !== 0) throw new Error(`Bybit error: ${json.retMsg}`)
  const list: any[] = json.result?.list ?? []
  return list.map(it => ({
    time: parseInt(it.fundingRateTimestamp, 10),
    rate: parseFloat(it.fundingRate),
  }))
}

/**
 * Загружает funding для symbol за последние `daysBack` дней. Использует кэш.
 * Возвращает массив, отсортированный по времени ASC.
 */
export async function loadFundingHistory(symbol: string, daysBack: number): Promise<FundingPoint[]> {
  const cached = loadCache(symbol)
  const cachedByTime = new Map<number, FundingPoint>()
  for (const p of cached) cachedByTime.set(p.time, p)

  const now = Date.now()
  const cutoff = now - daysBack * 24 * 60 * 60_000

  // Если кэш покрывает нужный период — просто фильтруем
  const cachedOldest = cached.length > 0 ? Math.min(...cached.map(p => p.time)) : Infinity
  const cachedNewest = cached.length > 0 ? Math.max(...cached.map(p => p.time)) : 0

  // Грузим только то, чего не хватает в кэше: walk backward от now до cachedNewest (если кэш есть),
  // или до cutoff (если кэша нет).
  // Для простоты: грузим всё начиная с now назад, пока last point <= cutoff. Дубликаты пропускаются.
  let endTime: number | undefined = undefined
  let safety = 100  // max 100 страниц = 20000 точек
  while (safety-- > 0) {
    const page = await fetchPage(symbol, endTime)
    if (page.length === 0) break
    const oldestInPage = Math.min(...page.map(p => p.time))
    let allInCache = true
    for (const p of page) {
      if (!cachedByTime.has(p.time)) {
        cachedByTime.set(p.time, p)
        allInCache = false
      }
    }
    // Stop if we've gone past cutoff OR all points already in cache
    if (oldestInPage <= cutoff || allInCache) break
    endTime = oldestInPage  // go further back
    // small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 100))
  }

  const all = [...cachedByTime.values()].sort((a, b) => a.time - b.time)
  saveCache(symbol, all)
  return all.filter(p => p.time >= cutoff)
}

/**
 * Поиск funding rate на момент unixMs (последняя funding period которая была <= unixMs)
 */
export function fundingAt(history: FundingPoint[], unixMs: number): number | null {
  let lo = 0, hi = history.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (history[mid].time <= unixMs) { idx = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return idx >= 0 ? history[idx].rate : null
}
