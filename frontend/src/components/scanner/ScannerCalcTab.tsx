import { useState } from 'react'

interface ScannerCalcTabProps {
  balance: number
  riskPct: number
}

export default function ScannerCalcTab({ balance, riskPct }: ScannerCalcTabProps) {
  const [calcEntry, setCalcEntry] = useState('')
  const [calcSL, setCalcSL] = useState('')
  const [calcLeverage, setCalcLeverage] = useState('10')
  const [calcEntry2, setCalcEntry2] = useState('')
  const [calcShowEntry2, setCalcShowEntry2] = useState(false)

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-text-secondary text-sm">
        Депо: <span className="text-text-primary font-mono">${balance || '—'}</span> | Риск: <span className="text-text-primary font-mono">{riskPct}%</span> = <span className="text-accent font-mono">${balance && riskPct ? Math.floor(balance * riskPct / 100) : '—'}</span>
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Вход 1</label>
          <input
            type="number"
            value={calcEntry}
            onChange={e => setCalcEntry(e.target.value)}
            placeholder="0.00"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Stop Loss</label>
          <input
            type="number"
            value={calcSL}
            onChange={e => setCalcSL(e.target.value)}
            placeholder="0.00"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Leverage</label>
          <input
            type="number"
            value={calcLeverage}
            onChange={e => setCalcLeverage(e.target.value)}
            placeholder="10"
            min={1}
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <button
        onClick={() => { setCalcShowEntry2(!calcShowEntry2); if (calcShowEntry2) setCalcEntry2('') }}
        className={`text-xs px-3 py-1 rounded transition-colors ${calcShowEntry2 ? 'bg-accent/20 text-accent' : 'bg-input text-text-secondary hover:text-text-primary'}`}
      >
        {calcShowEntry2 ? '— Убрать докупку' : '+ Докупка (вход 2)'}
      </button>

      {calcShowEntry2 && (
        <div className="max-w-[calc(33.333%-0.5rem)]">
          <label className="text-xs text-text-secondary block mb-1">Вход 2 (докупка)</label>
          <input
            type="number"
            value={calcEntry2}
            onChange={e => setCalcEntry2(e.target.value)}
            placeholder="0.00"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}

      {(() => {
        const entry = Number(calcEntry)
        const sl = Number(calcSL)
        const lev = Number(calcLeverage)
        if (!entry || !sl || !lev || !balance || !riskPct) return null

        const slPct = Math.abs((entry - sl) / entry) * 100
        const riskAmount = balance * riskPct / 100
        const margin = Math.floor(riskAmount / (slPct / 100 * lev))
        const direction = sl < entry ? 'LONG' : 'SHORT'

        const entry2 = Number(calcEntry2)
        const hasEntry2 = calcShowEntry2 && entry2 > 0

        let margin1 = margin
        let margin2 = 0
        if (hasEntry2) {
          margin1 = Math.floor(margin / 2)
          margin2 = margin - margin1
        }

        return (
          <div className="bg-card rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction === 'LONG' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
                {direction}
              </span>
              <span className="text-text-secondary text-xs">SL: {slPct.toFixed(2)}%</span>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div className="text-text-secondary">Риск (потеря при SL)</div>
              <div className="font-mono text-short">${riskAmount.toFixed(2)}</div>

              <div className="text-text-secondary">Маржа на вход</div>
              <div className="font-mono text-accent text-lg">${margin}</div>

              <div className="text-text-secondary">Размер позиции</div>
              <div className="font-mono text-text-primary">${margin * lev}</div>
            </div>

            {hasEntry2 && (
              <>
                <div className="border-t border-input pt-3 mt-2">
                  <p className="text-xs text-text-secondary mb-2">Разделение маржи (50/50):</p>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                    <div className="text-text-secondary"></div>
                    <div className="text-text-secondary text-xs">Маржа</div>
                    <div className="text-text-secondary text-xs">Позиция</div>

                    <div className="text-text-secondary">Вход 1 — ${entry}</div>
                    <div className="font-mono text-accent">${margin1}</div>
                    <div className="font-mono text-text-primary">${margin1 * lev}</div>

                    <div className="text-text-secondary">Вход 2 — ${entry2}</div>
                    <div className="font-mono text-accent">${margin2}</div>
                    <div className="font-mono text-text-primary">${margin2 * lev}</div>
                  </div>
                </div>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
