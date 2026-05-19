/** Single stat card. `sub` splits on ` · ` into separate lines for readability. */
export default function Stat({ label, value, sub, tone = 'neutral' }: {
  label: string
  value: string
  sub?: string
  tone?: 'long' | 'short' | 'neutral'
}) {
  const toneCls = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  const subLines = sub ? sub.split(' · ') : []
  return (
    <div className="bg-card border border-input rounded p-3">
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      <div className={`text-xl font-semibold ${toneCls}`}>{value}</div>
      {subLines.length > 0 && (
        <div className="text-xs text-text-secondary mt-1 leading-tight space-y-0.5">
          {subLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
