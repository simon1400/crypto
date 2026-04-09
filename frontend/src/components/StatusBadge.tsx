import { SCANNER_STATUS_MAP, STRATEGY_MAP, TRADE_STATUS_MAP } from '../lib/constants'

export function ScoreBadge({ score }: { score: number }) {
  let color = 'text-neutral bg-neutral/10'
  if (score >= 80) color = 'text-long bg-long/10'
  else if (score >= 65) color = 'text-accent bg-accent/10'
  else if (score >= 50) color = 'text-yellow-400 bg-yellow-400/10'

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${color}`}>
      {score}
    </span>
  )
}

export function StrategyBadge({ strategy }: { strategy: string }) {
  const s = STRATEGY_MAP[strategy] || { label: strategy, color: 'text-neutral bg-neutral/10' }
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>
}

export function ScannerStatusBadge({ status }: { status: string }) {
  const s = SCANNER_STATUS_MAP[status] || { label: status, color: 'text-neutral bg-neutral/10' }
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>
}

export function TradeStatusBadge({ status }: { status: string }) {
  const s = TRADE_STATUS_MAP[status] || TRADE_STATUS_MAP.CANCELLED
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>
}
