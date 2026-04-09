import { QUALITY_COLORS } from '../../lib/constants'

const AI_MARKERS = [
  { prefix: 'Конфликты:', color: 'text-orange-400', key: 'conflicts' },
  { prefix: 'Риски:', color: 'text-short', key: 'risks' },
  { prefix: 'Уровни:', color: 'text-blue-400', key: 'levels' },
  { prefix: '⏳ Ждать:', color: 'text-blue-400', key: 'wait' },
]

export default function AiAnalysisBlock({ text }: { text: string }) {
  const qualityMatch = text.match(/^\[([A-F])\]\s*/)
  const quality = qualityMatch?.[1] || ''
  const body = qualityMatch ? text.slice(qualityMatch[0].length) : text

  const found = AI_MARKERS
    .map(m => ({ ...m, idx: body.indexOf(m.prefix) }))
    .filter(m => m.idx !== -1)
    .sort((a, b) => a.idx - b.idx)

  const commentaryEnd = found.length > 0 ? found[0].idx : body.length
  const commentary = body.slice(0, commentaryEnd).replace(/\n+$/, '').trim()

  const sections = found.map((m, i) => {
    const start = m.idx + m.prefix.length
    const end = i < found.length - 1 ? found[i + 1].idx : body.length
    return { key: m.key, label: m.prefix, color: m.color, content: body.slice(start, end).trim() }
  }).filter(s => s.content)

  return (
    <div className="bg-input rounded-lg p-3 mb-3 text-sm">
      {quality && (
        <div className={`text-xs font-medium mb-1 ${QUALITY_COLORS[quality] || 'text-neutral'}`}>
          AI Annotation [{quality}]:
        </div>
      )}
      {commentary && (
        <div className="text-text-secondary mb-2">{commentary}</div>
      )}
      {sections.map(s => (
        <div key={s.key} className={`${s.color} text-xs mt-1`}>
          <span className="font-medium">{s.label}</span> {s.content}
        </div>
      ))}
    </div>
  )
}
