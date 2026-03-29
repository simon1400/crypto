interface Props {
  status: string
  type: 'LONG' | 'SHORT'
}

export default function SignalBadge({ status, type }: Props) {
  let label = status
  let colorClass = 'bg-neutral/20 text-neutral'

  if (status === 'ENTRY_WAIT') {
    label = 'Ожидание входа'
    colorClass = 'bg-accent/15 text-accent'
  } else if (status === 'ACTIVE') {
    label = 'Активен'
    colorClass = 'bg-blue-500/15 text-blue-400'
  } else if (status === 'SL_HIT') {
    label = 'Stop Loss'
    colorClass = 'bg-short/15 text-short'
  } else if (status.startsWith('TP')) {
    const tpNum = status.replace('_HIT', '').replace('TP', '')
    label = `Take Profit ${tpNum}`
    colorClass = 'bg-long/15 text-long'
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold ${colorClass}`}>
      {type === 'LONG' ? '↑' : '↓'} {label}
    </span>
  )
}
