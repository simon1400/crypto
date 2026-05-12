import { useState, useEffect, useMemo } from 'react'
import { getMt5Balance, setMt5Balance as apiSetMt5Balance } from '../api/client'
import { getBreakoutPaperConfig } from '../api/breakoutPaper'

// ===================== Crypto tab state keys =====================
const LS_BALANCE = 'calc_balance'
const LS_RISK = 'calc_risk'
const LS_ACTIVE_TAB = 'calc_active_tab'
const LS_MT5_INSTRUMENT = 'calc_mt5_instrument'
const LS_MT5_SPLITS = 'calc_mt5_splits'
const LS_SLCALC_CRYPTO_DIR = 'slcalc_crypto_dir'
const LS_SLCALC_MT5_INSTR = 'slcalc_mt5_instr'
const LS_SLCALC_MT5_DIR = 'slcalc_mt5_dir'

type CalcTab = 'mt5' | 'crypto' | 'sl-crypto' | 'sl-mt5'

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
  typicalSpreadPips: number      // typical Vantage Standard STP spread in pips (round-turn cost — paid once at open)
}

// Typical spreads — Vantage Standard STP (April 2026). При новостях/азиатской сессии спред может быть в 2-3 раза шире.
const INSTRUMENTS: Mt5Instrument[] = [
  // Metals
  { symbol: 'XAUUSD', name: 'Gold vs USD',   group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 25 },
  { symbol: 'XAGUSD', name: 'Silver vs USD', group: 'Metals', contractSize: 5000,   pipSize: 0.001,  quoteKind: 'usd_quote', decimals: 3, typicalSpreadPips: 25 },
  { symbol: 'XPTUSD', name: 'Platinum',      group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 400 },
  { symbol: 'XPDUSD', name: 'Palladium',     group: 'Metals', contractSize: 100,    pipSize: 0.01,   quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 800 },

  // Majors (USD quoted)
  { symbol: 'EURUSD', name: 'Euro / USD',       group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5, typicalSpreadPips: 1.2 },
  { symbol: 'GBPUSD', name: 'Pound / USD',      group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5, typicalSpreadPips: 1.6 },
  { symbol: 'AUDUSD', name: 'Aussie / USD',     group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5, typicalSpreadPips: 1.4 },
  { symbol: 'NZDUSD', name: 'Kiwi / USD',       group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_quote', decimals: 5, typicalSpreadPips: 1.8 },

  // USD-base pairs
  { symbol: 'USDJPY', name: 'USD / Yen',   group: 'Majors', contractSize: 100000, pipSize: 0.01,   quoteKind: 'usd_base',  decimals: 3, typicalSpreadPips: 1.4 },
  { symbol: 'USDCHF', name: 'USD / Franc', group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 1.8 },
  { symbol: 'USDCAD', name: 'USD / CAD',   group: 'Majors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 1.7 },

  // JPY crosses
  { symbol: 'EURJPY', name: 'EUR / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.0 },
  { symbol: 'GBPJPY', name: 'GBP / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.8 },
  { symbol: 'AUDJPY', name: 'AUD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.2 },
  { symbol: 'CADJPY', name: 'CAD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.5 },
  { symbol: 'CHFJPY', name: 'CHF / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.8 },
  { symbol: 'NZDJPY', name: 'NZD / JPY', group: 'JPY pairs', contractSize: 100000, pipSize: 0.01, quoteKind: 'jpy_quote', decimals: 3, typicalSpreadPips: 2.8 },

  // Other crosses (approximation)
  { symbol: 'EURGBP', name: 'EUR / GBP', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 1.6 },
  { symbol: 'EURAUD', name: 'EUR / AUD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.5 },
  { symbol: 'EURCHF', name: 'EUR / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.0 },
  { symbol: 'EURCAD', name: 'EUR / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.5 },
  { symbol: 'EURNZD', name: 'EUR / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.5 },
  { symbol: 'GBPAUD', name: 'GBP / AUD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.0 },
  { symbol: 'GBPCHF', name: 'GBP / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.0 },
  { symbol: 'GBPCAD', name: 'GBP / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.5 },
  { symbol: 'GBPNZD', name: 'GBP / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 4.5 },
  { symbol: 'AUDCAD', name: 'AUD / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.5 },
  { symbol: 'AUDCHF', name: 'AUD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.5 },
  { symbol: 'AUDNZD', name: 'AUD / NZD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.0 },
  { symbol: 'NZDCAD', name: 'NZD / CAD', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.5 },
  { symbol: 'NZDCHF', name: 'NZD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 3.5 },
  { symbol: 'CADCHF', name: 'CAD / CHF', group: 'Crosses', contractSize: 100000, pipSize: 0.0001, quoteKind: 'other', decimals: 5, typicalSpreadPips: 2.5 },

  // Exotic majors
  { symbol: 'USDSEK', name: 'USD / SEK', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 50 },
  { symbol: 'USDNOK', name: 'USD / NOK', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 60 },
  { symbol: 'USDZAR', name: 'USD / ZAR', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 200 },
  { symbol: 'USDMXN', name: 'USD / MXN', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 250 },
  { symbol: 'USDTRY', name: 'USD / TRY', group: 'Minors', contractSize: 100000, pipSize: 0.0001, quoteKind: 'usd_base',  decimals: 5, typicalSpreadPips: 500 },

  // Indices (approximate — typically 1 contract = 1 index point)
  { symbol: 'US30',    name: 'Dow Jones 30',    group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 2 },
  { symbol: 'NAS100',  name: 'Nasdaq 100',      group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 2 },
  { symbol: 'SPX500',  name: 'S&P 500',         group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 6 },
  { symbol: 'GER40',   name: 'DAX 40',          group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 15 },
  { symbol: 'UK100',   name: 'FTSE 100',        group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 15 },

  // Crypto (via MT5 brokers)
  { symbol: 'BTCUSD', name: 'Bitcoin',  group: 'Crypto', contractSize: 1,  pipSize: 1,    quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 35 },
  { symbol: 'ETHUSD', name: 'Ethereum', group: 'Crypto', contractSize: 1,  pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2, typicalSpreadPips: 30 },
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

// Цена-сдвиг для break-even от комиссии (round-turn $/лот).
// USD-quote: priceShift = commission / contractSize
// USD-base / cross: priceShift = commission * entry / contractSize (обратная формула к lossPerLotUsd)
function commissionPriceShift(instr: Mt5Instrument, entry: number, commissionPerLot: number): number {
  if (commissionPerLot <= 0 || instr.contractSize <= 0) return 0
  if (instr.quoteKind === 'usd_quote') return commissionPerLot / instr.contractSize
  return (commissionPerLot * entry) / instr.contractSize
}

// Цена-сдвиг от спреда: при открытии входишь по Ask, выйти можешь только по Bid → теряешь спред сразу.
// Поэтому шаг по цене = spread в пипсах × pipSize (НЕ умножаем на 2).
function spreadPriceShift(instr: Mt5Instrument): number {
  return instr.typicalSpreadPips * instr.pipSize
}

// USD-стоимость спреда на N лотов — для отображения в результате.
function spreadCostUsd(instr: Mt5Instrument, entry: number, lots: number): number {
  const priceShift = spreadPriceShift(instr)
  const raw = priceShift * instr.contractSize * lots
  if (instr.quoteKind === 'usd_quote') return raw
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

  const tabBtn = (key: CalcTab, label: string) => (
    <button
      key={key}
      onClick={() => setActiveTab(key)}
      className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
        activeTab === key
          ? 'border-accent text-accent'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-text-primary">Калькулятор позиции</h1>

      <div className="flex gap-2 border-b border-input overflow-x-auto">
        {tabBtn('mt5', 'MT5 (Forex / Gold)')}
        {tabBtn('crypto', 'Crypto (Futures)')}
        {tabBtn('sl-crypto', 'SL Crypto')}
        {tabBtn('sl-mt5', 'SL MT5')}
      </div>

      {activeTab === 'mt5' && <Mt5Calculator />}
      {activeTab === 'crypto' && <CryptoCalculator />}
      {activeTab === 'sl-crypto' && <SlCryptoCalculator />}
      {activeTab === 'sl-mt5' && <SlMt5Calculator />}
    </div>
  )
}

// ===================== MT5 Calculator =====================

function Mt5Calculator() {
  const [balance, setBalance] = useState<string>('')
  const [riskPct, setRiskPct] = useState<string>('2')
  const [commission, setCommission] = useState<string>('0')
  const [savedBalance, setSavedBalance] = useState<number | null>(null)
  const [savedRisk, setSavedRisk] = useState<number>(2)
  const [savedCommission, setSavedCommission] = useState<number>(0)
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
      setCommission(String(r.commissionPerLot ?? 0))
      setSavedCommission(r.commissionPerLot ?? 0)
    }).catch(() => {})
  }, [])

  const balanceNum = Number(balance)
  const riskNum = Number(riskPct)
  const commissionNum = Math.max(0, Number(commission) || 0)
  const splitsNum = Math.max(1, Math.floor(Number(splits) || 1))
  const instr = useMemo(() => INSTRUMENTS.find(i => i.symbol === instrument) || INSTRUMENTS[0], [instrument])

  const isDirty = (balanceNum !== savedBalance) || (riskNum !== savedRisk) || (commissionNum !== savedCommission)
  const canSave = balanceNum > 0 && riskNum > 0 && riskNum <= 100 && commissionNum >= 0 && commissionNum <= 200 && isDirty

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setErrorMsg('')
    try {
      const r = await apiSetMt5Balance({ balance: balanceNum, riskPct: riskNum, commissionPerLot: commissionNum })
      setSavedBalance(r.balance)
      setSavedRisk(r.riskPct)
      setSavedCommission(r.commissionPerLot ?? 0)
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

        <div className="grid grid-cols-3 gap-3">
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
          <div>
            <label className="text-xs text-text-secondary block mb-1" title="Round-turn = open + close. Vantage Standard STP = 0, Raw ECN ≈ 6.">
              Комиссия ($/лот)
            </label>
            <input
              type="number"
              value={commission}
              onChange={e => setCommission(e.target.value)}
              placeholder="0"
              step="0.5"
              min={0}
              className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-text-secondary text-xs">
            {savedBalance !== null
              ? <>Сохранено: <span className="text-text-primary font-mono">${savedBalance}</span> / <span className="text-text-primary font-mono">{savedRisk}%</span> / комиссия <span className="text-text-primary font-mono">${savedCommission}</span>/лот</>
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
            const commShift = commissionPriceShift(instr, entryNum, commissionNum)
            const sprShift = spreadPriceShift(instr)
            const totalShift = commShift + sprShift
            if (totalShift <= 0) return null

            const bePrice = result.direction === 'BUY' ? entryNum + totalShift : entryNum - totalShift
            const beInPips = totalShift / instr.pipSize
            const totalCommissionUsd = commissionNum * result.totalLots
            const totalSpreadUsd = spreadCostUsd(instr, entryNum, result.totalLots)
            const totalCostUsd = totalCommissionUsd + totalSpreadUsd

            return (
              <div className="border-t border-input pt-3 mt-2 space-y-2">
                <p className="text-xs text-text-secondary">
                  Безубыток (с учётом издержек)
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  {commissionNum > 0 && (
                    <>
                      <div className="text-text-secondary">Комиссия (round-turn)</div>
                      <div className="font-mono text-text-primary">
                        ${round(totalCommissionUsd, 2)}
                        <span className="text-text-secondary text-xs ml-2">
                          (${commissionNum}/лот × {round(result.totalLots, 2)})
                        </span>
                      </div>
                    </>
                  )}

                  <div className="text-text-secondary">Спред ({instr.typicalSpreadPips} пипс)</div>
                  <div className="font-mono text-text-primary">
                    ${round(totalSpreadUsd, 2)}
                  </div>

                  <div className="text-text-secondary">Итого издержки</div>
                  <div className="font-mono text-short">
                    ${round(totalCostUsd, 2)}
                  </div>

                  <div className="text-text-secondary">SL в безубыток</div>
                  <div className="font-mono text-accent">
                    {bePrice.toFixed(instr.decimals)}
                    <span className="text-text-secondary text-xs ml-2">
                      ({round(beInPips, 1)} пипс от входа)
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-text-secondary">
                  💡 После TP1 переноси SL не на цену входа, а сюда — иначе закрытие "в ноль" даст реальный минус ${round(totalCostUsd, 2)}.
                  Спред — типичный для Vantage Standard STP, при новостях/азиате может быть в 2-3 раза шире.
                </p>
              </div>
            )
          })()}

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
      getBreakoutPaperConfig('A').then(cfg => {
        if (cfg.currentDepositUsd) setBalance(String(Math.floor(cfg.currentDepositUsd)))
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

// ===================== SL Crypto Calculator =====================
// Задача: задаёшь вход + размер позиции (маржа × плечо) + риск% → калькулятор говорит,
// на какой цене ставить SL чтобы потерять ровно X% депо.
//
// Формула:
//   risk_$       = balance * riskPct/100
//   notional     = margin * leverage
//   slPct        = risk_$ / notional             (доля от цены входа)
//   slDist       = entry * slPct
//   slPrice      = LONG  → entry - slDist
//                  SHORT → entry + slDist

function SlCryptoCalculator() {
  const [balance, setBalance] = useState<string>(() => localStorage.getItem(LS_BALANCE) || '')
  const [riskPct, setRiskPct] = useState<string>(() => localStorage.getItem(LS_RISK) || '2')
  const [entry, setEntry] = useState('')
  const [margin, setMargin] = useState('')
  const [leverage, setLeverage] = useState('10')
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>(
    () => (localStorage.getItem(LS_SLCALC_CRYPTO_DIR) as 'LONG' | 'SHORT') || 'LONG',
  )

  useEffect(() => {
    if (!localStorage.getItem(LS_BALANCE)) {
      getBreakoutPaperConfig('A').then(cfg => {
        if (cfg.currentDepositUsd) setBalance(String(Math.floor(cfg.currentDepositUsd)))
      }).catch(() => {})
    }
  }, [])

  useEffect(() => { localStorage.setItem(LS_BALANCE, balance) }, [balance])
  useEffect(() => { localStorage.setItem(LS_RISK, riskPct) }, [riskPct])
  useEffect(() => { localStorage.setItem(LS_SLCALC_CRYPTO_DIR, direction) }, [direction])

  const balanceNum = Number(balance)
  const riskNum = Number(riskPct)
  const entryNum = Number(entry)
  const marginNum = Number(margin)
  const levNum = Number(leverage)

  const haveTrade = balanceNum > 0 && riskNum > 0 && entryNum > 0 && marginNum > 0 && levNum > 0

  let result: {
    riskAmount: number
    notional: number
    slPct: number
    slDist: number
    slPrice: number
    liqPct: number
    liqPrice: number
    slBeforeLiq: boolean
  } | null = null

  if (haveTrade) {
    const riskAmount = balanceNum * riskNum / 100
    const notional = marginNum * levNum
    const slPct = (riskAmount / notional) * 100   // % от цены входа
    const slDist = entryNum * slPct / 100
    const slPrice = direction === 'LONG' ? entryNum - slDist : entryNum + slDist
    // Грубая ликвидация (без учёта maintenance margin) — 100% / leverage
    const liqPct = 100 / levNum
    const liqPrice = direction === 'LONG'
      ? entryNum * (1 - liqPct / 100)
      : entryNum * (1 + liqPct / 100)
    const slBeforeLiq = slPct < liqPct
    result = { riskAmount, notional, slPct, slDist, slPrice, liqPct, liqPrice, slBeforeLiq }
  }

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

      <div>
        <label className="text-xs text-text-secondary block mb-1">Направление</label>
        <div className="flex gap-2">
          <button
            onClick={() => setDirection('LONG')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded transition-colors ${
              direction === 'LONG' ? 'bg-long/20 text-long ring-1 ring-long' : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            LONG
          </button>
          <button
            onClick={() => setDirection('SHORT')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded transition-colors ${
              direction === 'SHORT' ? 'bg-short/20 text-short ring-1 ring-short' : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            SHORT
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Вход</label>
          <input
            type="number"
            value={entry}
            onChange={e => setEntry(e.target.value)}
            placeholder="0.00"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Маржа ($)</label>
          <input
            type="number"
            value={margin}
            onChange={e => setMargin(e.target.value)}
            placeholder="100"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Leverage</label>
          <input
            type="number"
            value={leverage}
            onChange={e => setLeverage(e.target.value)}
            placeholder="10"
            min={1}
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {result && (
        <div className="bg-card rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction === 'LONG' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
              {direction}
            </span>
            <span className="text-text-secondary text-xs">
              SL: <span className="text-text-primary font-mono">{result.slPct.toFixed(2)}%</span> от входа
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="text-text-secondary">Риск (потеря при SL)</div>
            <div className="font-mono text-short">${round(result.riskAmount, 2)}</div>

            <div className="text-text-secondary">Размер позиции</div>
            <div className="font-mono text-text-primary">${round(result.notional, 2)}</div>

            <div className="text-text-secondary">Цена SL</div>
            <div className="font-mono text-accent text-lg">
              {result.slPrice > 0 ? round(result.slPrice, 6) : '—'}
            </div>

            <div className="text-text-secondary">Дистанция до SL</div>
            <div className="font-mono text-text-primary">
              {round(result.slDist, 6)} ({result.slPct.toFixed(2)}%)
            </div>
          </div>

          <div className="border-t border-input pt-3 mt-2 space-y-2">
            <p className="text-xs text-text-secondary">Ликвидация (без maintenance margin)</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div className="text-text-secondary">Цена ликвидации</div>
              <div className="font-mono text-short">{round(result.liqPrice, 6)}</div>
              <div className="text-text-secondary">Дистанция до ликвидации</div>
              <div className="font-mono text-text-primary">{result.liqPct.toFixed(2)}%</div>
            </div>
            {!result.slBeforeLiq && (
              <p className="text-xs text-short">
                ⚠️ SL ({result.slPct.toFixed(2)}%) дальше ликвидации ({result.liqPct.toFixed(2)}%) —
                позицию вынесет ликвой раньше. Уменьши плечо или маржу.
              </p>
            )}
            {result.slBeforeLiq && result.slPct > result.liqPct * 0.7 && (
              <p className="text-xs text-accent">
                ⚠️ SL близко к ликвидации ({(result.slPct / result.liqPct * 100).toFixed(0)}% от ликвы) —
                любое проскальзывание может задеть ликву.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ===================== SL MT5 Calculator =====================
// Задача: задаёшь вход + лоты + инструмент + риск% → калькулятор говорит цену SL.
//
// Формула:
//   risk_$       = balance * riskPct/100
//   loss_per_lot_at_unit_dist:
//     usd_quote → contractSize
//     usd_base / cross → contractSize / entry
//   slDist       = risk_$ / (lots * loss_per_lot_at_unit_dist)
//   slPrice      = BUY  → entry - slDist
//                  SELL → entry + slDist

function SlMt5Calculator() {
  const [balance, setBalance] = useState<string>('')
  const [riskPct, setRiskPct] = useState<string>('2')
  const [savedLoaded, setSavedLoaded] = useState(false)

  const [instrument, setInstrument] = useState<string>(
    () => localStorage.getItem(LS_SLCALC_MT5_INSTR) || 'XAUUSD',
  )
  const [direction, setDirection] = useState<'BUY' | 'SELL'>(
    () => (localStorage.getItem(LS_SLCALC_MT5_DIR) as 'BUY' | 'SELL') || 'BUY',
  )
  const [entry, setEntry] = useState('')
  const [lots, setLots] = useState('')

  useEffect(() => { localStorage.setItem(LS_SLCALC_MT5_INSTR, instrument) }, [instrument])
  useEffect(() => { localStorage.setItem(LS_SLCALC_MT5_DIR, direction) }, [direction])

  useEffect(() => {
    getMt5Balance().then(r => {
      if (r.balance !== null && r.balance !== undefined) setBalance(String(r.balance))
      setRiskPct(String(r.riskPct))
      setSavedLoaded(true)
    }).catch(() => { setSavedLoaded(true) })
  }, [])

  const balanceNum = Number(balance)
  const riskNum = Number(riskPct)
  const entryNum = Number(entry)
  const lotsNum = Number(lots)
  const instr = useMemo(() => INSTRUMENTS.find(i => i.symbol === instrument) || INSTRUMENTS[0], [instrument])

  const grouped = useMemo(() => {
    const groups: Record<string, Mt5Instrument[]> = {}
    for (const i of INSTRUMENTS) {
      if (!groups[i.group]) groups[i.group] = []
      groups[i.group].push(i)
    }
    return groups
  }, [])

  const haveTrade = balanceNum > 0 && riskNum > 0 && entryNum > 0 && lotsNum > 0

  let result: {
    riskAmount: number
    lossPerLotAtUnitDist: number
    slDist: number
    slPips: number
    slPrice: number
    notional: number
  } | null = null

  if (haveTrade) {
    const riskAmount = balanceNum * riskNum / 100
    // loss per 1 lot for 1.0 unit price move
    const lossPerLotAtUnitDist = instr.quoteKind === 'usd_quote'
      ? instr.contractSize
      : instr.contractSize / entryNum
    const slDist = riskAmount / (lotsNum * lossPerLotAtUnitDist)
    const slPips = slDist / instr.pipSize
    const slPrice = direction === 'BUY' ? entryNum - slDist : entryNum + slDist
    const notional = instr.quoteKind === 'usd_quote'
      ? entryNum * instr.contractSize * lotsNum
      : instr.contractSize * lotsNum
    result = { riskAmount, lossPerLotAtUnitDist, slDist, slPips, slPrice, notional }
  }

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

      <p className="text-text-secondary text-xs">
        {savedLoaded
          ? <>Депо/риск подгружены из MT5-настроек. Изменения здесь не сохраняются — правь во вкладке MT5.</>
          : <>Загрузка...</>
        }
        {balanceNum > 0 && riskNum > 0 && (
          <> • Риск: <span className="text-accent font-mono">${round(balanceNum * riskNum / 100, 2)}</span></>
        )}
      </p>

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

      <div>
        <label className="text-xs text-text-secondary block mb-1">Направление</label>
        <div className="flex gap-2">
          <button
            onClick={() => setDirection('BUY')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded transition-colors ${
              direction === 'BUY' ? 'bg-long/20 text-long ring-1 ring-long' : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            BUY
          </button>
          <button
            onClick={() => setDirection('SELL')}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded transition-colors ${
              direction === 'SELL' ? 'bg-short/20 text-short ring-1 ring-short' : 'bg-input text-text-secondary hover:text-text-primary'
            }`}
          >
            SELL
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
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
          <label className="text-xs text-text-secondary block mb-1">Объём (лоты)</label>
          <input
            type="number"
            value={lots}
            onChange={e => setLots(e.target.value)}
            placeholder="0.10"
            step="0.01"
            min="0.01"
            className="w-full bg-input text-text-primary font-mono text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {result && (
        <div className="bg-card rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction === 'BUY' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
              {direction}
            </span>
            <span className="text-text-secondary text-xs">
              {instr.symbol} • {round(lotsNum, 2)} лот
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="text-text-secondary">Риск (потеря при SL)</div>
            <div className="font-mono text-short">${round(result.riskAmount, 2)}</div>

            <div className="text-text-secondary">Цена SL</div>
            <div className="font-mono text-accent text-lg">
              {result.slPrice > 0 ? result.slPrice.toFixed(instr.decimals) : '—'}
            </div>

            <div className="text-text-secondary">Дистанция до SL</div>
            <div className="font-mono text-text-primary">
              {round(result.slDist, instr.decimals)} ({round(result.slPips, 1)} пипс)
            </div>

            <div className="text-text-secondary">Размер позиции (notional)</div>
            <div className="font-mono text-text-primary">${round(result.notional, 0)}</div>
          </div>

          {result.slPrice <= 0 && (
            <p className="text-xs text-short pt-2 border-t border-input">
              ⚠️ Расчётный SL ушёл ниже нуля — слишком большой объём для заданного риска.
              Уменьши лоты или подними риск%.
            </p>
          )}

          {instr.quoteKind !== 'usd_quote' && (
            <p className="text-xs text-text-secondary pt-2 border-t border-input">
              ⚠️ Для {instr.symbol} расчёт через курс входа — точность ±1–3%.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
