import { MarketOverview } from '../api/client'

function getFearGreedColor(value: number): string {
  if (value <= 25) return '#f6465d'
  if (value <= 45) return '#ff9900'
  if (value <= 55) return '#848e9c'
  if (value <= 75) return '#00c087'
  return '#0ecb81'
}

interface Props {
  data: MarketOverview | null
  loading?: boolean
}

export default function MarketBadge({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="flex gap-4 animate-pulse">
        <div className="h-8 w-40 bg-card rounded" />
        <div className="h-8 w-32 bg-card rounded" />
      </div>
    )
  }

  if (!data) return null

  const color = getFearGreedColor(data.fearGreed)

  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <div className="flex items-center gap-2 bg-card px-3 py-1.5 rounded-lg">
        <span className="text-text-secondary">Fear & Greed:</span>
        <span className="font-mono font-semibold" style={{ color }}>
          {data.fearGreed}
        </span>
        <span className="text-text-secondary">({data.fearGreedLabel})</span>
      </div>
      <div className="flex items-center gap-2 bg-card px-3 py-1.5 rounded-lg">
        <span className="text-text-secondary">BTC Dominance:</span>
        <span className="font-mono font-semibold text-accent">{data.btcDominance}%</span>
      </div>
    </div>
  )
}
