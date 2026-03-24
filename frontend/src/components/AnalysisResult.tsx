import { AnalysisResponse } from '../api/client'
import AnalysisCard from './AnalysisCard'
import MarketBadge from './MarketBadge'

interface Props {
  data: AnalysisResponse
}

function splitByCoin(result: string, coins: string[]): Record<string, string> {
  const sections: Record<string, string> = {}
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i]
    const pattern = new RegExp(`🪙\\s*${coin}`, 'i')
    const start = result.search(pattern)
    if (start === -1) continue

    let end = result.length
    for (let j = i + 1; j < coins.length; j++) {
      const nextPattern = new RegExp(`🪙\\s*${coins[j]}`, 'i')
      const nextStart = result.slice(start + 1).search(nextPattern)
      if (nextStart !== -1) {
        end = start + 1 + nextStart
        break
      }
    }
    sections[coin] = result.slice(start, end).trim()
  }
  return sections
}

export default function AnalysisResult({ data }: Props) {
  const coins = Object.keys(data.coinsData)
  const sections = splitByCoin(data.result, coins)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <MarketBadge data={data.marketData} />
        <span className="text-sm text-text-secondary">
          {new Date(data.createdAt).toLocaleString('ru-RU')}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {coins.map((coin) => (
          <AnalysisCard
            key={coin}
            ticker={coin}
            indicators={data.coinsData[coin]}
            sectionText={sections[coin] || ''}
          />
        ))}
      </div>

      {data.result.includes('📋 ИТОГ') && (
        <div className="bg-card rounded-xl p-4 border border-accent/20">
          <p className="text-sm whitespace-pre-wrap">
            {data.result.slice(data.result.indexOf('📋 ИТОГ'))}
          </p>
        </div>
      )}
    </div>
  )
}
