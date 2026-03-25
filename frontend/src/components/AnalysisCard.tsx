import { CoinIndicators, MultiTFIndicators } from '../api/client'
import { useState } from 'react'

interface ParsedSignal {
  ticker: string
  signal: string
  entry: string
  sl: string
  tp1: string
  tp2: string
  rr: string
  reasons: string[]
  risks: string[]
}

function parseSection(text: string): ParsedSignal {
  const get = (emoji: string) => {
    const re = new RegExp(`${emoji}\\s*(.+)`, 'm')
    return re.exec(text)?.[1]?.trim() || ''
  }

  const listAfter = (emoji: string) => {
    const re = new RegExp(`${emoji}[^\\n]*\\n([\\s\\S]*?)(?=\\n[^\\s•]|$)`)
    const match = re.exec(text)
    if (!match) return []
    return match[1]
      .split('\n')
      .map((l) => l.replace(/^\s*•\s*/, '').trim())
      .filter(Boolean)
  }

  // Support both old format (💰 Вход) and new format (📍 Оптимальная точка входа)
  const entry = get('📍') || get('💰')
  const signal = get('🎯')

  return {
    ticker: get('🪙'),
    signal,
    entry,
    sl: get('🛑'),
    tp1: text.match(/✅\s*Take Profit 1:\s*(.+)/m)?.[1]?.trim() || '',
    tp2: text.match(/✅\s*Take Profit 2:\s*(.+)/m)?.[1]?.trim() || '',
    rr: get('⚖️'),
    reasons: listAfter('📝'),
    risks: listAfter('⚠️'),
  }
}

function trendColor(trend: string) {
  if (trend === 'BULLISH') return 'text-long'
  if (trend === 'BEARISH') return 'text-short'
  return 'text-neutral'
}

function signalColor(signal: string) {
  if (signal.includes('LONG')) return 'bg-long/20 text-long border-long'
  if (signal.includes('SHORT')) return 'bg-short/20 text-short border-short'
  return 'bg-neutral/20 text-neutral border-neutral'
}

function rsiColor(rsi: number) {
  if (rsi < 30) return 'bg-long'
  if (rsi > 70) return 'bg-short'
  return 'bg-accent'
}

interface Props {
  ticker: string
  indicators: MultiTFIndicators | CoinIndicators
  sectionText: string
}

function getMainIndicators(indicators: MultiTFIndicators | CoinIndicators): CoinIndicators {
  if ('tf1h' in indicators) return indicators.tf1h
  return indicators
}

export default function AnalysisCard({ ticker, indicators: rawIndicators, sectionText }: Props) {
  const [risksOpen, setRisksOpen] = useState(false)
  const parsed = parseSection(sectionText)
  const indicators = getMainIndicators(rawIndicators)

  return (
    <div className="bg-card rounded-xl p-5 border border-card hover:border-accent/30 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xl font-semibold font-mono">{ticker}</h3>
          <span className="font-mono text-2xl font-bold">${indicators.price.toLocaleString()}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-sm font-medium ${trendColor(indicators.trend)}`}>
            {indicators.trend}
          </span>
          {parsed.signal && (
            <span className={`px-3 py-1 rounded border text-sm font-bold ${signalColor(parsed.signal)}`}>
              {parsed.signal.replace(/^Сигнал:\s*/i, '')}
            </span>
          )}
        </div>
      </div>

      {parsed.entry && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 mb-4 text-xs">
          {[
            ['Вход', parsed.entry],
            ['SL', parsed.sl],
            ['TP1', parsed.tp1],
            ['TP2', parsed.tp2],
            ['R:R', parsed.rr],
          ].map(([label, val]) => (
            <div key={label} className="bg-input rounded-lg p-2 text-center overflow-hidden">
              <div className="text-text-secondary text-[10px]">{label}</div>
              <div className="font-mono font-semibold text-xs mt-0.5 truncate" title={val || '—'}>{val || '—'}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 mb-4 text-sm">
        <div className="flex-1">
          <div className="flex justify-between text-xs text-text-secondary mb-1">
            <span>RSI</span>
            <span className="font-mono">{indicators.rsi}</span>
          </div>
          <div className="h-2 bg-input rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${rsiColor(indicators.rsi)}`}
              style={{ width: `${indicators.rsi}%` }}
            />
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-text-secondary">Vol</div>
          <span className={`font-mono text-sm ${indicators.volRatio < 0.8 ? 'text-short' : 'text-text-primary'}`}>
            {indicators.volRatio}x
          </span>
        </div>
        <div className="text-center">
          <div className="text-xs text-text-secondary">24h</div>
          <span className={`font-mono text-sm ${indicators.change24h >= 0 ? 'text-long' : 'text-short'}`}>
            {indicators.change24h > 0 ? '+' : ''}{indicators.change24h}%
          </span>
        </div>
      </div>

      {parsed.reasons.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-text-secondary mb-1">Причины:</p>
          <ul className="text-sm space-y-0.5">
            {parsed.reasons.map((r, i) => (
              <li key={i} className="text-text-primary">• {r}</li>
            ))}
          </ul>
        </div>
      )}

      {parsed.risks.length > 0 && (
        <div>
          <button
            onClick={() => setRisksOpen(!risksOpen)}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {risksOpen ? '▾' : '▸'} Риски ({parsed.risks.length})
          </button>
          {risksOpen && (
            <ul className="text-sm mt-1 space-y-0.5">
              {parsed.risks.map((r, i) => (
                <li key={i} className="text-short/80">• {r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
