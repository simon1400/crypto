import { useState } from 'react'
import { takeSignalAsTrade, skipSignal, ScannerSignal, SignalClose } from '../../api/client'
import { formatDate, fmt2, fmt2Signed } from '../../lib/formatters'
import { ScoreBadge, StrategyBadge, ScannerStatusBadge as StatusBadge } from '../StatusBadge'
import AiAnalysisBlock from './AiAnalysisBlock'
import { MODEL_LABELS, SETUP_CATEGORY_STYLES, EXECUTION_TYPE_STYLES } from './constants'

export default function SignalCard({ signal, onStatusChange, onDelete, balance, riskPct, onShowChart }: {
  signal: ScannerSignal
  onStatusChange: () => void
  onDelete: (id: number) => void
  balance: number
  riskPct: number
  onShowChart?: (signal: ScannerSignal) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showTakeForm, setShowTakeForm] = useState(false)
  const [selectedModel, setSelectedModel] = useState(0)
  const [amount, setAmount] = useState('')
  const [customLeverage, setCustomLeverage] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [loading, setLoading] = useState(false)
  const isLong = signal.type === 'LONG'
  const mc = signal.marketContext as any
  const models = (mc?.entryModels as { type: string; entry: number; stopLoss: number; takeProfits: { price: number; rr: number }[]; leverage: number; positionPct: number; slPercent: number; riskReward: number; viable: boolean }[] || []).filter(m => m.viable)
  const active = models[selectedModel] || models[0]
  const tps = active?.takeProfits || (signal.takeProfits as { price: number; rr: number }[]) || []
  const closes = (signal.closes as SignalClose[]) || []
  const hasPnl = signal.closedPct > 0

  function calcSignalRiskAmount(lev?: number) {
    if (!balance || !riskPct) return ''
    const sl = active?.slPercent || (Math.abs((signal.stopLoss - signal.entry) / signal.entry) * 100)
    const leverage = lev || active?.leverage || signal.leverage
    if (!sl || !leverage) return ''
    return String(Math.floor((balance * riskPct / 100) / (sl / 100 * leverage)))
  }

  function openSignalTakeForm() {
    setAmount(calcSignalRiskAmount())
    setCustomLeverage('')
    setShowTakeForm(true)
  }

  async function handleTake() {
    if (!amount) return
    setLoading(true)
    try {
      const lev = customLeverage ? Number(customLeverage) : undefined
      await takeSignalAsTrade(signal.id, Number(amount), active?.type, lev, orderType)
      setShowTakeForm(false)
      onStatusChange()
    } catch (err: any) {
      alert(err.message || 'Failed to take signal')
    } finally { setLoading(false) }
  }

  async function handleSkip() {
    try {
      await skipSignal(signal.id)
      onStatusChange()
    } catch {}
  }

  return (
    <div className="bg-card rounded-xl p-4 border border-card hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-lg text-text-primary">{signal.coin}</span>
          <span className={`px-2 py-0.5 rounded text-sm font-bold ${isLong ? 'bg-long/10 text-long' : 'bg-short/10 text-short'}`}>
            {signal.type}
          </span>
          <StrategyBadge strategy={signal.strategy} />
          <StatusBadge status={signal.status} />
          {/* Setup category badge */}
          {(() => {
            const cat = signal.setupCategory ?? mc?.setup_category
            if (!cat) return null
            const sc = SETUP_CATEGORY_STYLES[cat] || SETUP_CATEGORY_STYLES.IGNORE
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${sc.bg} ${sc.text}`}>{sc.label}</span>
          })()}
          {/* Execution type badge */}
          {(() => {
            const et = signal.executionType ?? mc?.execution_type
            if (!et) return null
            const style = EXECUTION_TYPE_STYLES[et] || EXECUTION_TYPE_STYLES.IGNORE
            return <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.bg} ${style.text}`}>{style.label}</span>
          })()}
          {onShowChart && (
            <button
              onClick={() => onShowChart(signal)}
              className="text-text-secondary hover:text-accent transition-colors ml-1"
              title="График позиции"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasPnl && (
            <span className={`font-mono font-bold text-sm ${signal.realizedPnl > 0 ? 'text-long' : signal.realizedPnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
              {fmt2Signed(signal.realizedPnl)}$
            </span>
          )}
          <ScoreBadge score={signal.setupScore ?? signal.score} />
        </div>
      </div>

      {/* Entry model selector */}
      {models.length > 1 && (
        <div className="flex gap-1 mb-3">
          {models.map((model, idx) => (
            <button
              key={model.type}
              onClick={() => setSelectedModel(idx)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                selectedModel === idx
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-input text-text-secondary border border-transparent hover:text-text-primary'
              }`}
            >
              {MODEL_LABELS[model.type] || model.type}
              {idx === 0 && ' ★'}
            </button>
          ))}
        </div>
      )}

      {/* Key levels grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Вход{active ? ` (${MODEL_LABELS[active.type] || active.type})` : ''}</div>
          <div className="font-mono font-bold text-accent">${active?.entry ?? signal.entry}</div>
        </div>
        <div className="bg-input rounded-lg p-2">
          <div className="text-xs text-text-secondary">Stop Loss{active ? ` (${active.slPercent}%)` : ''}</div>
          <div className="font-mono font-bold text-short">${active?.stopLoss ?? signal.stopLoss}</div>
        </div>
        {tps.map((tp, i) => (
          <div key={i} className="bg-input rounded-lg p-2">
            <div className="text-xs text-text-secondary">TP{i + 1} (R:R {tp.rr})</div>
            <div className="font-mono font-bold text-long">${tp.price}</div>
          </div>
        ))}
      </div>

      {/* Setup score breakdown (new 6-component) */}
      {mc?.setup_score_breakdown && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs text-text-secondary">
          <span>Trend: {mc.setup_score_breakdown.trend}/25</span>
          <span>Loc: {mc.setup_score_breakdown.location}/25</span>
          <span>Mom: {mc.setup_score_breakdown.momentum}/20</span>
          <span>Deriv: {mc.setup_score_breakdown.derivatives}/15</span>
          <span>Geom: {mc.setup_score_breakdown.geometry}/15</span>
          {mc.setup_score_breakdown.penalties < 0 && (
            <span className="text-short">Pen: {mc.setup_score_breakdown.penalties}</span>
          )}
        </div>
      )}

      {/* Entry trigger conditions */}
      {mc?.entry_trigger_result && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className={mc.entry_trigger_result.passed ? 'text-long' : 'text-short'}>
            Trigger: {mc.entry_trigger_result.score}/4
          </span>
          <span className={mc.entry_trigger_result.conditions?.pullback_zone ? 'text-long' : 'text-neutral'}>PB</span>
          <span className={mc.entry_trigger_result.conditions?.candle_reclaim ? 'text-long' : 'text-neutral'}>Reclaim</span>
          <span className={mc.entry_trigger_result.conditions?.reversal_volume ? 'text-long' : 'text-neutral'}>Vol</span>
          <span className={mc.entry_trigger_result.conditions?.distance_from_trigger ? 'text-long' : 'text-neutral'}>Dist</span>
        </div>
      )}

      {/* Info row */}
      <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
        <span className="text-text-secondary">Leverage: <span className="text-text-primary font-mono">{active?.leverage ?? signal.leverage}x</span></span>
        {active && (
          <>
            <span className="text-text-secondary">Позиция: <span className="text-text-primary font-mono">{active.positionPct}%</span></span>
            <span className="text-text-secondary">R:R: <span className="text-text-primary font-mono">1:{active.riskReward}</span></span>
          </>
        )}
        {signal.amount > 0 && (
          <span className="text-text-secondary">Размер: <span className="text-text-primary font-mono">${signal.amount}</span></span>
        )}
        {signal.closedPct > 0 && (
          <span className="text-text-secondary">Закрыто: <span className="text-text-primary font-mono">{signal.closedPct}%</span></span>
        )}
        {signal.marketContext && (() => {
          const r = (signal.marketContext as any)?.regime
          const label = typeof r === 'string' ? r : r?.regime || ''
          return label ? <span className="text-text-secondary">Режим: <span className="text-text-primary">{label}</span></span> : null
        })()}
      </div>

      {/* Market context badges: funding / OI delta / liquidations / L:S ratio */}
      {signal.marketContext && (() => {
        const mc = signal.marketContext as any
        const funding = mc.funding
        const oi = mc.oi
        const liq = mc.liquidations
        const lsr = mc.lsr
        const fundingPct = funding?.fundingRate ? funding.fundingRate * 100 : 0
        const fundingHot = Math.abs(fundingPct) > 0.05
        const longShare = lsr?.buyRatio ? lsr.buyRatio * 100 : null
        const lsrExtreme = longShare != null && (longShare > 70 || longShare < 30)
        const oiDelta = oi?.oiChangePct1h ?? 0
        const oiSig = Math.abs(oiDelta) > 1
        const liqUsd = liq?.totalUsd ?? 0
        const liqK = Math.round(liqUsd / 1000)
        const showAnything = fundingPct !== 0 || oi || liq || lsr
        if (!showAnything) return null

        return (
          <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
            {funding && (
              <span
                title={`Funding rate за 8h. ${fundingPct > 0 ? 'Лонги платят шортам' : 'Шорты платят лонгам'}`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  fundingHot
                    ? fundingPct > 0
                      ? 'bg-short/10 text-short border-short/30'
                      : 'bg-long/10 text-long border-long/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                Fund {fundingPct > 0 ? '+' : ''}{fundingPct.toFixed(3)}%
              </span>
            )}
            {oi && (
              <span
                title={`Open Interest 1h: ${oiDelta.toFixed(2)}%, 4h: ${(oi.oiChangePct4h ?? 0).toFixed(2)}%`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  oiSig
                    ? oiDelta > 0
                      ? 'bg-long/10 text-long border-long/30'
                      : 'bg-short/10 text-short border-short/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                OI {oiDelta > 0 ? '+' : ''}{oiDelta.toFixed(2)}%
              </span>
            )}
            {liq && liqUsd > 0 && (
              <span
                title={`Ликвидации за ${liq.windowMinutes}m: лонги $${(liq.longsLiqUsd / 1000).toFixed(0)}k, шорты $${(liq.shortsLiqUsd / 1000).toFixed(0)}k`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  liqUsd > 500_000
                    ? 'bg-accent/15 text-accent border-accent/40'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                🔥 ${liqK}k liq
                {liq.longsLiqUsd > liq.shortsLiqUsd ? ' L↓' : ' S↓'}
              </span>
            )}
            {lsr && longShare != null && (
              <span
                title={`Long/Short account ratio (1h)`}
                className={`px-1.5 py-0.5 rounded font-mono border ${
                  lsrExtreme
                    ? longShare > 70
                      ? 'bg-long/10 text-long border-long/30'
                      : 'bg-short/10 text-short border-short/30'
                    : 'bg-input text-text-secondary border-card'
                }`}
              >
                L:S {longShare.toFixed(0)}/{(100 - longShare).toFixed(0)}
              </span>
            )}
          </div>
        )
      })()}

      {/* Closes history */}
      {closes.length > 0 && (
        <div className="mb-3 space-y-1">
          <div className="text-xs text-text-secondary mb-1">Закрытия:</div>
          {closes.map((c, i) => (
            <div key={i} className="flex items-center gap-3 text-xs bg-input rounded-lg px-3 py-1.5">
              <span className="font-mono text-text-primary">${c.price}</span>
              <span className="text-text-secondary">{c.percent}%</span>
              <span className={`font-mono font-bold ${c.pnl > 0 ? 'text-long' : c.pnl < 0 ? 'text-short' : 'text-text-secondary'}`}>
                {fmt2Signed(c.pnl)}$ ({fmt2Signed(c.pnlPercent)}%)
              </span>
              {c.isSL && <span className="text-short">SL</span>}
              <span className="text-text-secondary ml-auto">{formatDate(c.closedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI Analysis */}
      {signal.aiAnalysis && signal.aiAnalysis !== 'GPT фільтр отключен\n\nРиски: \nУровни: ' && (
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-text-secondary hover:text-accent transition-colors mb-2">
          {expanded ? '▾ Скрыть GPT анализ' : '▸ GPT-5.4 анализ'}
        </button>
      )}
      {expanded && signal.aiAnalysis && (
        <AiAnalysisBlock text={signal.aiAnalysis} />
      )}

      {/* Take Form */}
      {showTakeForm && (
        <div className="bg-input rounded-lg p-3 mb-3 space-y-2">
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-xs text-text-secondary mb-1">Размер (USDT)</div>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="w-24">
              <div className="text-xs text-text-secondary mb-1">Leverage</div>
              <input
                type="number"
                value={customLeverage || (active?.leverage ?? signal.leverage)}
                onChange={e => {
                  setCustomLeverage(e.target.value)
                  const calc = calcSignalRiskAmount(Number(e.target.value) || undefined)
                  if (calc) setAmount(calc)
                }}
                min={1} max={125}
                className="w-full bg-card text-text-primary rounded px-3 py-1.5 text-sm font-mono border border-card focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>
          {/* Order type toggle */}
          <div>
            <div className="text-xs text-text-secondary mb-1">Тип входа</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOrderType('market')}
                className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'market' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
                Market <span className="opacity-70">(taker)</span>
              </button>
              <button type="button" onClick={() => setOrderType('limit')}
                className={`flex-1 py-1.5 rounded text-xs font-medium ${orderType === 'limit' ? 'bg-accent/15 text-accent border border-accent/40' : 'bg-card text-text-secondary border border-card'}`}>
                Limit <span className="opacity-70">(maker)</span>
              </button>
            </div>
          </div>
          {amount && (() => {
            const lev = Number(customLeverage) || active?.leverage || signal.leverage
            const sl = active?.slPercent || (Math.abs((signal.stopLoss - signal.entry) / signal.entry) * 100)
            const position = Number(amount) * lev
            const riskUsd = Number(amount) * (sl / 100) * lev
            const feeRate = orderType === 'limit' ? 0.0002 : 0.00055
            const entryFee = position * feeRate
            return (
              <div className="text-xs text-text-secondary space-y-0.5">
                <div>Позиция: <span className="text-text-primary font-mono">${position}</span></div>
                <div>Риск: <span className="text-short font-mono">${fmt2(riskUsd)}</span>
                  {balance > 0 && <span className="ml-1">({(riskUsd / balance * 100).toFixed(2)}% депо)</span>}
                </div>
                <div>Entry fee: <span className="text-text-primary font-mono">${fmt2(entryFee)}</span> ({orderType})</div>
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={handleTake} disabled={loading || !amount} className="px-3 py-1.5 text-sm rounded bg-long/20 text-long hover:bg-long/30 disabled:opacity-50">
              {loading ? '...' : 'Подтвердить'}
            </button>
            <button onClick={() => setShowTakeForm(false)} className="px-3 py-1.5 text-sm rounded bg-neutral/10 text-neutral">Отмена</button>
          </div>
        </div>
      )}

      {/* Footer: time + actions */}
      <div className="flex items-center justify-between border-t border-card pt-2">
        <span className="text-xs text-text-secondary">
          {formatDate(signal.createdAt)}
          {signal.takenAt && <span> · взят {formatDate(signal.takenAt)}</span>}
        </span>

        <div className="flex gap-1">
          {signal.status === 'NEW' && !showTakeForm && (
            <>
              <button onClick={openSignalTakeForm} className="px-2 py-1 text-xs rounded bg-long/10 text-long hover:bg-long/20">Взять</button>
              <button onClick={handleSkip} className="px-2 py-1 text-xs rounded bg-neutral/10 text-neutral hover:bg-neutral/20">Пропустить</button>
            </>
          )}

          <button
            onClick={() => onDelete(signal.id)}
            className="px-2 py-1 text-xs rounded bg-short/5 text-text-secondary hover:text-short hover:bg-short/10 transition-colors"
            title="Удалить"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
