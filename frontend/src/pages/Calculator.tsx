import { useState, useEffect, useMemo } from 'react'
import { getBudget, getMt5Balance, setMt5Balance as apiSetMt5Balance } from '../api/client'

// ===================== Crypto tab state keys =====================
const LS_BALANCE = 'calc_balance'
const LS_RISK = 'calc_risk'
const LS_ACTIVE_TAB = 'calc_active_tab'
const LS_MT5_INSTRUMENT = 'calc_mt5_instrument'
const LS_MT5_SPLITS = 'calc_mt5_splits'

type CalcTab = 'mt5' | 'crypto'

// ===================== MT5 instruments catalog =====================
// quoteKind:
//   'usd_quote' — quote currency = USD (e.g. EURUSD, XAUUSD) → loss_usd_per_lot = stop_price * contractSize
//   'usd_base'  — base currency  = USD (e.g. USDJPY, USDCAD) → loss_usd_per_lot = (stop_price * contractSize) / entry
//   'jpy_quote' — quote currency = JPY cross (e.g. EURJPY)   → loss_usd_per_lot = (stop_price * contractSize) / entry (approximation: treats entry as JPY/USD proxy)
//   'other'     — other cross (rare)                         → loss_usd_per_lot = (stop_price * contractSize) / entry  (approximation)
interface Mt5Instrument {
  symbol: string
  name: string
  group: 'Metals' | 'Majors' | 'JPY pairs' | 'Crosses' | 'Minors' | 'Indices' | 'Crypto'
  contractSize: number           // units per 1 lot
  pipSize: number                // price increment considered "1 pip" — used only for display / stop in pips
  quoteKind: 'usd_quote' | 'usd_base' | 'jpy_quote' | 'other'
  decimals: number               // price decimals
}

const INSTRUMENTS: Mt5Instrument[] = [
  // Metals
  { symbol: 'XAUUSD', name: 'Gold vs USD',   group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'XAGUSD', name: 'Silver vs USD', group: 'Metals', contractSize: 5000,   pipSize: 0.001,  quoteKind: 'usd_quote', decimals: 3 },
  { symbol: 'XPTUSD', name: 'Platinum',      group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'XPDUSD', name: 'Palladium',     group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2 },

  // Majors (USD quoted)
  { symbol: 'EURUSD', name: 'Euro / USD',       group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5 },
  { symbol: 'GBPUSD', name: 'Pound / USD',      group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5 },
  { symbol: 'AUDUSD', name: 'Aussie / USD',     group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5 },
  { symbol: 'NZDUSD', name: 'Kiwi / USD',       group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5 },

  // USD-base pairs
  { symbol: 'USDJPY', name: 'USD / Yen',   group: 'Majors', contractSize: 100000, pipSize: 0.01,   quoteKind: 'usd_base',  decimals: 3 },
  { symbol: 'USDCHF', name: 'USD / Franc', group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },
  { symbol: 'USDCAD', name: 'USD / CAD',   group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },

  // JPY crosses
  { symbol: 'EURJPY', name: 'EUR / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },
  { symbol: 'GBPJPY', name: 'GBP / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },
  { symbol: 'AUDJPY', name: 'AUD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },
  { symbol: 'CADJPY', name: 'CAD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },
  { symbol: 'CHFJPY', name: 'CHF / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },
  { symbol: 'NZDJPY', name: 'NZD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3 },

  // Other crosses (approximation)
  { symbol: 'EURGBP', name: 'EUR / GBP', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'EURAUD', name: 'EUR / AUD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'EURCHF', name: 'EUR / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'EURCAD', name: 'EUR / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'EURNZD', name: 'EUR / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'GBPAUD', name: 'GBP / AUD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'GBPCHF', name: 'GBP / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'GBPCAD', name: 'GBP / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'GBPNZD', name: 'GBP / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'AUDCAD', name: 'AUD / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'AUDCHF', name: 'AUD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'AUDNZD', name: 'AUD / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'NZDCAD', name: 'NZD / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'NZDCHF', name: 'NZD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },
  { symbol: 'CADCHF', name: 'CAD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5 },

  // Exotic majors
  { symbol: 'USDSEK', name: 'USD / SEK', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },
  { symbol: 'USDNOK', name: 'USD / NOK', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },
  { symbol: 'USDZAR', name: 'USD / ZAR', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },
  { symbol: 'USDMXN', name: 'USD / MXN', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },
  { symbol: 'USDTRY', name: 'USD / TRY', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5 },

  // Indices (approximate — typically 1 contract = 1 index point)
  { symbol: 'US30',    name: 'Dow Jones 30',    group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'NAS100',  name: 'Nasdaq 100',      group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'SPX500',  name: 'S&P 500',         group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'GER40',   name: 'DAX 40',          group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'UK100',   name: 'FTSE 100',        group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },

  // Crypto (via MT5 brokers)
  { symbol: 'BTCUSD', name: 'Bitcoin',  group: 'Crypto', contractSize: 1,  pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'ETHUSD', name: 'Ethereum', group: 'Crypto', contractSize: 1,  pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
]

function lossPerLotUsd(instr: Mt5Instrument, entry: number, stopPrice: number): number {
  const stop = Math.abs(entry - stopPrice)
  const raw = stop * instr.contractSize
  if (instr.quoteKind === 'usd_quote') return raw
  // For usd_base / jpy_quote / other we approximate by dividing by entry.
  // Exact for USD-base pairs. For JPY-crosses and other crosses this is a close approximation
  // when USD is not directly involved — sufficient for position sizing.
  return raw / entry
}

function round(n: number, decimals = 2): number {
  const m = Math.pow(10, decimals)
  return Math.round(n * m) / m
}

export default function Calculator() {
  const [activeTab, setActiveTab] = useState<CalcTab>(
    () => (localStorage.getItem(LS_ACTIVE_TAB) as CalcTab) || 'mt5',
  )
  useEffect(() => { localStorage.setItem(LS_ACTIVE_TAB, activeTab) }, [activeTab])

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-text-primary">Калькулятор позиции</h1>

      <div className="flex gap-2 border-b border-input">
        <button
          onClick={() => setActiveTab('mt5')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'mt5'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          MT5 (Forex / Gold)
        </button>
        <button
          onClick={() => setActiveTab('crypto')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'crypto'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Crypto (Futures)
        </button>
      </div>

      {activeTab === 'mt5' ? <Mt5Calculator /> : <CryptoCalculator />}
    </div>
  )
}

// ===================== MT5 Calculator =====================

function Mt5Calculator() {
  const [balance, setBalance] = useState<string>('')
  const [riskPct, setRiskPct] = useState<string>('2')
  const [savedBalance, setSavedBalance] = useState<number | null>(null)
  const [savedRisk, setSavedRisk] = useState<number>(2)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')

  const [instrument, setInstrument] = useState<string>(
    () => localStorage.getItem(LS_MT5_INSTRUMENT) || 'XAUUSD',
  )
  const [entry, setEntry] = useState('')
  const [sl, setSl] = useState('')
  const [splits, setSplits] = useState<string>(
    () => localStorage.getItem(LS_MT5_SPLITS) || '4',
  )

  useEffect(() => { localStorage.setItem(LS_MT5_INSTRUMENT, instrument) }, [instrument])
  useEffect(() => { localStorage.setItem(LS_MT5_SPLITS, splits) }, [splits])

  useEffect(() => {
    getMt5Balance().then(r => {
      if (r.balance !== null && r.balance !== undefined) {
        setBalance(String(r.balance))
        setSavedBalance(r.balance)
      }
      setRiskPct(String(r.riskPct))
      setSavedRisk(r.riskPct)
    }).catch(() => {})
  }, [])

  const balanceNum = Number(balance)
  const riskNum = Number(riskPct)
  const splitsNum = Math.max(1, Math.floor(Number(splits) || 1))
  const instr = useMemo(() => INSTRUMENTS.find(i => i.symbol === instrument) || INSTRUMENTS[0], [instrument])

  const isDirty = (balanceNum !== savedBalance) || (riskNum !== savedRisk)
  const canSave = balanceNum > 0 && riskNum > 0 && riskNum <= 100 && isDirty

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setErrorMsg('')
    try {
      const r = await apiSetMt5Balance({ balance: balanceNum, riskPct: riskNum })
      setSavedBalance(r.balance)
      setSavedRisk(r.riskPct)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err: any) {
      setErrorMsg(err.message || 'Ошибка сохранения')
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  // Group instruments for select
  const grouped = useMemo(() => {
    const groups: Record<string, Mt5Instrument[]> = {}
    for (const i of INSTRUMENTS) {
      if (!groups[i.group]) groups[i.group] = []
      groups[i.group].push(i)
    }
    return groups
  }, [])

  const entryNum = Number(entry)
  const slNum = Number(sl)
  const haveTrade = entryNum > 0 && slNum > 0 && entryNum !== slNum && balanceNum > 0 && riskNum > 0

  let result: {
    direction: 'BUY' | 'SELL'
    stopPriceDist: number
    stopInPips: number
    riskAmount: number
    lossPerLot: number
    totalLots: number
    perSplitLots: number
    positionValueUsd: number
  } | null = null

  if (haveTrade) {
    const direction: 'BUY' | 'SELL' = slNum < entryNum ? 'BUY' : 'SELL'
    const stopPriceDist = Math.abs(entryNum - slNum)
    const stopInPips = stopPriceDist / instr.pipSize
    const riskAmount = balanceNum * riskNum / 100
    const lossPerLot = lossPerLotUsd(instr, entryNum, slNum)
    const totalLots = lossPerLot > 0 ? riskAmount / lossPerLot : 0
    const perSplitLots = totalLots / splitsNum
    const positionValueUsd = instr.quoteKind === 'usd_quote'
      ? entryNum * instr.contractSize * totalLots
      : instr.contractSize * totalLots // for USD-base / crosses, notional in USD ≈ contractSize × lots
    result = { direction, stopPriceDist, stopInPips, riskAmount, lossPerLot, totalLots, perSplitLots, positionValueUsd }
  }

  // Lot rounding: brokers typically require min 0.01 step. Show both raw and rounded-down.
  const roundedTotal = result ? Math.floor(result.totalLots * 100) / 100 : 0
  const roundedPer = result ? Math.floor(result.perSplitLots * 100) / 100 : 0

  return (
    <div className="space-y-4">
      {/* Depo + risk card */}
      <div className="bg-card rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">Депозит МТ5</h2>
          {saveStatus === 'saved' && (
            <span className="text-xs text-long">✓ Сохранено</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-short">{errorMsg}</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Депозит ($)</label>
            <input
              type="number"
              value={balance}
              onChange={e => setBalance(e.target.value)}
              placeholder="1000"
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Риск (%)</label>
            <input
              type="number"
              value={riskPct}
              onChange={e => setRiskPct(e.target.value)}
              placeholder="2"
              step="0.1"
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-text-secondary text-xs">
            {savedBalance !== null
              ? <>Сохранено: <span className="text-text-primary font-mono">${savedBalance}</span> / <span className="text-text-primary font-mono">{savedRisk}%</span></>
              : <span className="text-short">Депо не сохранено</span>
            }
            {balanceNum > 0 && riskNum > 0 && (
              <> • Риск: <span className="text-accent font-mono">${round(balanceNum * riskNum / 100, 2)}</span></>
            )}
          </p>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="text-xs px-3 py-1.5 rounded bg-accent text-primary font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/90 transition-colors"
          >
            {saving ? '...' : 'Сохранить'}
          </button>
        </div>
      </div>

      {/* Trade inputs */}
      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Инструмент</label>
          <select
            value={instrument}
            onChange={e => setInstrument(e.target.value)}
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          >
            {Object.entries(grouped).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map(i => (
                  <option key={i.symbol} value={i.symbol}>
                    {i.symbol} — {i.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Вход</label>
            <input
              type="number"
              value={entry}
              onChange={e => setEntry(e.target.value)}
              placeholder="0.00"
              step={instr.pipSize}
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Stop Loss</label>
            <input
              type="number"
              value={sl}
              onChange={e => setSl(e.target.value)}
              placeholder="0.00"
              step={instr.pipSize}
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Делить на (TP)</label>
            <input
              type="number"
              value={splits}
              onChange={e => setSplits(e.target.value)}
              placeholder="4"
              min={1}
              max={10}
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-card rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${result.direction === 'BUY' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
              {result.direction}
            </span>
            <span className="text-text-secondary text-xs">
              Стоп: <span className="text-text-primary font-mono">{round(result.stopPriceDist, instr.decimals)}</span>
              {' '}(<span className="font-mono">{round(result.stopInPips, 1)}</span> пипс)
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="text-text-secondary">Риск (потеря при SL)</div>
            <div className="font-mono text-short">${round(result.riskAmount, 2)}</div>

            <div className="text-text-secondary">Убыток с 1 лота</div>
            <div className="font-mono text-text-primary">${round(result.lossPerLot, 2)}</div>

            <div className="text-text-secondary">Объём позиции</div>
            <div className="font-mono text-accent text-lg">
              {round(result.totalLots, 2)} лот
              {roundedTotal !== round(result.totalLots, 2) && (
                <span className="text-text-secondary text-xs ml-2">
                  (≈ {round(result.totalLots, 4)})
                </span>
              )}
            </div>

            <div className="text-text-secondary">Размер позиции (notional)</div>
            <div className="font-mono text-text-primary">${round(result.positionValueUsd, 0)}</div>
          </div>

          {splitsNum > 1 && (
            <div className="border-t border-input pt-3 mt-2">
              <p className="text-xs text-text-secondary mb-2">
                Разделить на <span className="text-text-primary">{splitsNum}</span> позиции (по TP):
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="text-text-secondary">На каждую сделку</div>
                <div className="font-mono text-accent">
                  {round(result.perSplitLots, 2)} лот
                  {roundedPer !== round(result.perSplitLots, 2) && (
                    <span className="text-text-secondary text-xs ml-2">
                      (≈ {round(result.perSplitLots, 4)})
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {(() => {
            const MIN_LOT = 0.01
            const totalBelowMin = result.totalLots < MIN_LOT
            const perSplitBelowMin = splitsNum > 1 && result.perSplitLots < MIN_LOT
            if (!totalBelowMin && !perSplitBelowMin) return null

            // Actual risk with minimum lot 0.01
            const actualLots = MIN_LOT * (perSplitBelowMin ? splitsNum : 1)
            const actualLossUsd = actualLots * result.lossPerLot
            const actualRiskPct = balanceNum > 0 ? actualLossUsd / balanceNum * 100 : 0

            // Min deposit to hit target risk% with min 0.01 lot (single position)
            // risk_$ = balance * riskPct/100 = MIN_LOT * lossPerLot
            // balance_min = MIN_LOT * lossPerLot / (riskPct / 100)
            const minBalanceSingle = (MIN_LOT * result.lossPerLot) / (riskNum / 100)
            // For N splits: each split needs min 0.01 lot
            const minBalanceSplit = (MIN_LOT * splitsNum * result.lossPerLot) / (riskNum / 100)

            return (
              <div className="border-t border-input pt-3 mt-2 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-short text-sm mt-0.5">⚠️</span>
                  <div className="text-xs text-text-secondary space-y-2 flex-1">
                    <p>
                      {perSplitBelowMin && !totalBelowMin
                        ? <>Позиция на каждый сплит меньше минимального лота <span className="text-text-primary font-mono">0.01</span>.</>
                        : <>Расчётный объём меньше минимального лота <span className="text-text-primary font-mono">0.01</span>. Сделку с заданным риском открыть нельзя.</>
                      }
                    </p>

                    <div className="bg-primary/40 rounded p-2 space-y-1">
                      <p className="text-text-secondary">Минимальный депозит для риска {riskNum}%:</p>
                      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 font-mono">
                        <span className="text-text-secondary">• 1 позиция (0.01 лот)</span>
                        <span className="text-text-primary">${round(minBalanceSingle, 0)}</span>
                        {splitsNum > 1 && (
                          <>
                            <span className="text-text-secondary">• {splitsNum} позиции (0.01 лот × {splitsNum})</span>
                            <span className="text-text-primary">${round(minBalanceSplit, 0)}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="bg-primary/40 rounded p-2 space-y-1">
                      <p className="text-text-secondary">
                        Если взять <span className="text-text-primary font-mono">{round(actualLots, 2)} лот</span>
                        {perSplitBelowMin && <> ({splitsNum} × 0.01)</>}:
                      </p>
                      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 font-mono">
                        <span className="text-text-secondary">Реальный убыток при SL</span>
                        <span className="text-short">${round(actualLossUsd, 2)}</span>
                        <span className="text-text-secondary">Реальный риск от депо</span>
                        <span className={actualRiskPct > riskNum * 2 ? 'text-short' : 'text-accent'}>
                          {round(actualRiskPct, 2)}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {instr.quoteKind !== 'usd_quote' && (
            <p className="text-xs text-text-secondary pt-2 border-t border-input">
              ⚠️ Для {instr.symbol} убыток с 1 лота рассчитан приблизительно через курс входа.
              Точность ±1–3% — достаточно для расчёта позиции.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ===================== Crypto Calculator (existing logic) =====================

function CryptoCalculator() {
  const [balance, setBalance] = useState<string>(() => localStorage.getItem(LS_BALANCE) || '')
  const [riskPct, setRiskPct] = useState<string>(() => localStorage.getItem(LS_RISK) || '2')
  const [calcEntry, setCalcEntry] = useState('')
  const [calcSL, setCalcSL] = useState('')
  const [calcLeverage, setCalcLeverage] = useState('10')
  const [calcEntry2, setCalcEntry2] = useState('')
  const [calcShowEntry2, setCalcShowEntry2] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(LS_BALANCE)) {
      getBudget().then(r => {
        if (r.balance) setBalance(String(Math.floor(r.balance)))
      }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(LS_BALANCE, balance)
  }, [balance])

  useEffect(() => {
    localStorage.setItem(LS_RISK, riskPct)
  }, [riskPct])

  const balanceNum = Number(balance)
  const riskNum = Number(riskPct)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Депозит ($)</label>
          <input
            type="number"
            value={balance}
            onChange={e => setBalance(e.target.value)}
            placeholder="1000"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Риск (%)</label>
          <input
            type="number"
            value={riskPct}
            onChange={e => setRiskPct(e.target.value)}
            placeholder="2"
            step="0.1"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <p className="text-text-secondary text-sm">
        Депо: <span className="text-text-primary font-mono">${balanceNum || '—'}</span> | Риск: <span className="text-text-primary font-mono">{riskNum || '—'}%</span> = <span className="text-accent font-mono">${balanceNum && riskNum ? Math.floor(balanceNum * riskNum / 100) : '—'}</span>
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
        if (!entry || !sl || !lev || !balanceNum || !riskNum) return null

        const slPct = Math.abs((entry - sl) / entry) * 100
        const riskAmount = balanceNum * riskNum / 100
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
            )}
          </div>
        )
      })()}
    </div>
  )
}
