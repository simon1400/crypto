import { buildOutcomeLabel, outcomeBadgeClasses } from './helpers'

export default function PaperStatusBadge({ status, pnl, closes }: {
  status: string
  pnl: number
  closes?: Array<{ reason?: string }>
}) {
  const label = buildOutcomeLabel(status, closes)
  const { bg, text } = outcomeBadgeClasses(status, pnl)
  return <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${bg} ${text}`}>{label}</span>
}
