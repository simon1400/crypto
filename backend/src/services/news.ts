// CryptoPanic API - free tier: 200 requests/hour
// No API key needed for basic public endpoint

export interface NewsItem {
  title: string
  publishedAt: string
  sentiment: 'positive' | 'negative' | 'neutral'
  source: string
  url: string
}

export interface NewsSentiment {
  coin: string
  positive: number
  negative: number
  neutral: number
  total: number
  score: number // -100 to +100
  headlines: string[]
}

export async function fetchCoinNews(coin: string): Promise<NewsSentiment> {
  const empty: NewsSentiment = {
    coin,
    positive: 0,
    negative: 0,
    neutral: 0,
    total: 0,
    score: 0,
    headlines: [],
  }

  try {
    // CryptoPanic free API - public posts with sentiment
    const url = `https://cryptopanic.com/api/free/v1/posts/?currencies=${coin}&kind=news&public=true`
    const res = await fetch(url)
    if (!res.ok) return empty
    const json = await res.json() as any
    if (!json.results || !Array.isArray(json.results)) return empty

    let positive = 0
    let negative = 0
    let neutral = 0
    const headlines: string[] = []

    for (const item of json.results.slice(0, 20)) {
      headlines.push(item.title)
      const votes = item.votes || {}
      if ((votes.positive || 0) > (votes.negative || 0)) {
        positive++
      } else if ((votes.negative || 0) > (votes.positive || 0)) {
        negative++
      } else {
        neutral++
      }
    }

    const total = positive + negative + neutral
    const score = total === 0 ? 0 : Math.round(((positive - negative) / total) * 100)

    return { coin, positive, negative, neutral, total, score, headlines: headlines.slice(0, 5) }
  } catch {
    return empty
  }
}

// Batch fetch news for multiple coins
export async function fetchAllCoinNews(coins: string[]): Promise<Record<string, NewsSentiment>> {
  const results: Record<string, NewsSentiment> = {}
  // Sequential to respect rate limits
  for (const coin of coins) {
    results[coin] = await fetchCoinNews(coin)
    // Small delay between requests
    await new Promise(r => setTimeout(r, 300))
  }
  return results
}
