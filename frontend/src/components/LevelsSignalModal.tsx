import { type LevelsSignal } from '../api/levels'

interface Props {
  signal: LevelsSignal
  onClose: () => void
}

function fmt(n: number, dec = 5): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  return n.toFixed(dec)
}
function dec(symbol: string, market: string): number {
  if (market === 'CRYPTO') return symbol.includes('USDT') ? 2 : 6
  if (/^XAU|^XAG/.test(symbol)) return 2
  if (/JPY/.test(symbol)) return 3
  return 5
}
function pct(from: number, to: number, side: 'BUY' | 'SELL'): string {
  if (!from) return ''
  const v = ((to - from) / from) * 100 * (side === 'BUY' ? 1 : -1)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function rDist(entry: number, sl: number, target: number, side: 'BUY' | 'SELL'): string {
  const risk = Math.abs(entry - sl)
  if (risk === 0) return ''
  const dist = side === 'BUY' ? target - entry : entry - target
  const r = dist / risk
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
}

export default function LevelsSignalModal({ signal, onClose }: Props) {
  const d = dec(signal.symbol, signal.market)
  const sideText = signal.side === 'BUY' ? 'LONG' : 'SHORT'
  const sideColor = signal.side === 'BUY' ? 'text-long' : 'text-short'
  const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴'
  const eventText = signal.event === 'BREAKOUT_RETEST' ? 'Pierce & Retest' : 'Reaction'
  const splits = [50, 30, 20]

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-bg-primary border border-input rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-input p-4 flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">{sideEmoji}</span>
              <h2 className="text-xl font-semibold">{signal.symbol}</h2>
              <span className={`text-lg font-medium ${sideColor}`}>{sideText}</span>
              {signal.isFiboConfluence && (
                <span className="px-2 py-0.5 bg-accent/15 text-accent text-xs rounded">🌀 Fibo</span>
              )}
            </div>
            <p className="text-sm text-text-secondary">
              {eventText} @ {signal.source} {fmt(signal.level, d)} · {new Date(signal.createdAt).toLocaleString('ru-RU')}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl">×</button>
        </div>

        <div className="p-4">
          {/* Reason */}
          <div className="mb-4 text-sm text-text-secondary italic">{signal.reason}</div>

          {/* Geometry */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PriceCard label="Уровень" value={fmt(signal.level, d)} sub={signal.source} />
            <PriceCard label="Вход" value={fmt(signal.entryPrice, d)} sub="" />
            <PriceCard
              label="SL (current)"
              value={fmt(signal.currentStop, d)}
              sub={pct(signal.entryPrice, signal.currentStop, signal.side)}
              tone="short"
            />
            <PriceCard
              label="SL initial"
              value={fmt(signal.initialStop, d)}
              sub={pct(signal.entryPrice, signal.initialStop, signal.side)}
              tone="short"
              dim
            />
          </div>

          {/* TP ladder */}
          <h3 className="font-semibold text-sm mb-2">TP ladder ({signal.tpLadder.length} уровней)</h3>
          <div className="space-y-1.5 mb-4">
            {signal.tpLadder.slice(0, 3).map((tp, i) => {
              const fill = signal.closes.find((c) => c.reason === `TP${i + 1}`)
              const isHit = !!fill
              return (
                <div
                  key={i}
                  className={`p-2.5 rounded border flex items-center justify-between ${
                    isHit ? 'border-long/40 bg-long/10' : 'border-input bg-card'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`font-mono font-semibold w-12 ${isHit ? 'text-long' : ''}`}>TP{i + 1}</span>
                    <span className="font-mono">{fmt(tp, d)}</span>
                    <span className="text-xs text-text-secondary">{pct(signal.entryPrice, tp, signal.side)}</span>
                    <span className="text-xs text-accent">{rDist(signal.entryPrice, signal.initialStop, tp, signal.side)}</span>
                  </div>
                  <div className="text-xs text-text-secondary">
                    {splits[i]}% {isHit && fill ? <span className="text-long ml-2">✓ {fill.pnlR >= 0 ? '+' : ''}{fill.pnlR.toFixed(2)}R</span> : ''}
                  </div>
                </div>
              )
            })}
            {signal.tpLadder.length > 3 && (
              <div className="text-xs text-text-secondary px-2">
                +{signal.tpLadder.length - 3} дальних TP уровней не торгуются (ladder=3)
              </div>
            )}
          </div>

          {/* Status & R */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PriceCard label="Status" value={signal.status} sub="" />
            <PriceCard
              label="Realized R"
              value={`${signal.realizedR >= 0 ? '+' : ''}${signal.realizedR.toFixed(2)}R`}
              sub=""
              tone={signal.realizedR > 0 ? 'long' : signal.realizedR < 0 ? 'short' : 'neutral'}
            />
          </div>

          {/* Closes log */}
          {signal.closes.length > 0 && (
            <>
              <h3 className="font-semibold text-sm mb-2">Закрытия</h3>
              <div className="space-y-1 mb-4 text-sm">
                {signal.closes.map((c, i) => (
                  <div key={i} className="flex justify-between bg-card border border-input rounded p-2">
                    <span className="font-mono">{c.reason} @ {fmt(c.price, d)}</span>
                    <span className="text-text-secondary">{c.percent.toFixed(0)}%</span>
                    <span className={`font-mono ${c.pnlR > 0 ? 'text-long' : c.pnlR < 0 ? 'text-short' : ''}`}>
                      {c.pnlR >= 0 ? '+' : ''}{c.pnlR.toFixed(2)}R
                    </span>
                    <span className="text-xs text-text-secondary">{new Date(c.closedAt).toLocaleTimeString('ru-RU')}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Fibo info */}
          {signal.fiboImpulse && (
            <div className="bg-accent/5 border border-accent/20 rounded p-3 text-sm">
              <div className="font-semibold mb-1">🌀 Fibo Impulse</div>
              <div className="text-text-secondary">
                {signal.fiboImpulse.direction} · {signal.fiboImpulse.sizeAtr.toFixed(1)}×ATR ·
                {' '}{fmt(signal.fiboImpulse.fromPrice, d)} → {fmt(signal.fiboImpulse.toPrice, d)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PriceCard({ label, value, sub, tone, dim }: {
  label: string; value: string; sub?: string;
  tone?: 'long' | 'short' | 'neutral';
  dim?: boolean;
}) {
  const color = tone === 'long' ? 'text-long' : tone === 'short' ? 'text-short' : 'text-text-primary'
  return (
    <div className={`bg-card border border-input rounded p-3 ${dim ? 'opacity-60' : ''}`}>
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-base font-mono font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-text-secondary">{sub}</div>}
    </div>
  )
}
