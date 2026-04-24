import { useState, useEffect, useMemo } from 'react'
import { getMt5Balance } from '../api/client'

// quoteKind:
//   'usd_quote' — quote currency = USD (e.g. EURUSD, XAUUSD) → loss_usd_per_lot = stop_price * contractSize
//   'usd_base'  — base currency  = USD (e.g. USDJPY, USDCAD) → loss_usd_per_lot = (stop_price * contractSize) / entry
//   'jpy_quote' — quote currency = JPY cross (e.g. EURJPY)   → loss_usd_per_lot = (stop_price * contractSize) / entry (approximation)
//   'other'     — other cross (rare)                         → loss_usd_per_lot = (stop_price * contractSize) / entry  (approximation)
export interface Mt5Instrument {
  symbol: string
  name: string
  group: 'Metals' | 'Majors' | 'JPY pairs' | 'Crosses' | 'Minors' | 'Indices' | 'Crypto'
  contractSize: number
  pipSize: number
  quoteKind: 'usd_quote' | 'usd_base' | 'jpy_quote' | 'other'
  decimals: number
}

export const MT5_INSTRUMENTS: Mt5Instrument[] = [
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

  // Indices
  { symbol: 'US30',    name: 'Dow Jones 30',    group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'NAS100',  name: 'Nasdaq 100',      group: 'Indices', contractSize: 1, pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'SPX500',  name: 'S&P 500',         group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'GER40',   name: 'DAX 40',          group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'UK100',   name: 'FTSE 100',        group: 'Indices', contractSize: 1, pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },

  // Crypto
  { symbol: 'BTCUSD', name: 'Bitcoin',  group: 'Crypto', contractSize: 1,  pipSize: 1,    quoteKind: 'usd_quote', decimals: 2 },
  { symbol: 'ETHUSD', name: 'Ethereum', group: 'Crypto', contractSize: 1,  pipSize: 0.1,  quoteKind: 'usd_quote', decimals: 2 },
]

export function findInstrument(symbol: string): Mt5Instrument | undefined {
  return MT5_INSTRUMENTS.find((i) => i.symbol === symbol)
}

export function lossPerLotUsd(instr: Mt5Instrument, entry: number, stopPrice: number): number {
  const stop = Math.abs(entry - stopPrice)
  const raw = stop * instr.contractSize
  if (instr.quoteKind === 'usd_quote') return raw
  return raw / entry
}

function round(n: number, decimals = 2): number {
  const m = Math.pow(10, decimals)
  return Math.round(n * m) / m
}

export interface Mt5PositionCalcResult {
  direction: 'BUY' | 'SELL'
  stopPriceDist: number
  stopInPips: number
  riskAmount: number
  lossPerLot: number
  totalLots: number
  perSplitLots: number
  positionValueUsd: number
}

export function computeMt5Position(
  instr: Mt5Instrument,
  entry: number,
  sl: number,
  balance: number,
  riskPct: number,
  splits: number,
): Mt5PositionCalcResult | null {
  if (!(entry > 0) || !(sl > 0) || entry === sl || !(balance > 0) || !(riskPct > 0)) return null

  const direction: 'BUY' | 'SELL' = sl < entry ? 'BUY' : 'SELL'
  const stopPriceDist = Math.abs(entry - sl)
  const stopInPips = stopPriceDist / instr.pipSize
  const riskAmount = balance * riskPct / 100
  const lossPerLot = lossPerLotUsd(instr, entry, sl)
  const totalLots = lossPerLot > 0 ? riskAmount / lossPerLot : 0
  const perSplitLots = totalLots / Math.max(1, splits)
  const positionValueUsd = instr.quoteKind === 'usd_quote'
    ? entry * instr.contractSize * totalLots
    : instr.contractSize * totalLots

  return { direction, stopPriceDist, stopInPips, riskAmount, lossPerLot, totalLots, perSplitLots, positionValueUsd }
}

interface Props {
  // Optional overrides — if provided, the component runs in read-only mode (no instrument picker).
  instrument?: string
  entry?: number
  sl?: number
  splits?: number
  // When true, show the instrument/entry/SL inputs so user can edit
  editable?: boolean
}

/**
 * Reusable MT5 position calculator.
 * - If `instrument`, `entry`, `sl` are provided and `editable` is false → compact readonly card (for signal modals).
 * - If `editable` is true → full interactive calculator (for /calculator page).
 */
export default function Mt5PositionCalc({
  instrument: instrumentProp,
  entry: entryProp,
  sl: slProp,
  splits: splitsProp = 1,
  editable = false,
}: Props) {
  const [balance, setBalance] = useState<number | null>(null)
  const [riskPct, setRiskPct] = useState<number>(2)

  useEffect(() => {
    getMt5Balance().then((r) => {
      if (r.balance !== null && r.balance !== undefined) setBalance(r.balance)
      setRiskPct(r.riskPct)
    }).catch(() => {})
  }, [])

  // Editable inputs
  const [instrSymbol, setInstrSymbol] = useState<string>(instrumentProp || 'XAUUSD')
  const [entryStr, setEntryStr] = useState<string>(entryProp != null ? String(entryProp) : '')
  const [slStr, setSlStr] = useState<string>(slProp != null ? String(slProp) : '')
  const [splitsStr, setSplitsStr] = useState<string>(String(splitsProp))

  // Sync when props change (signal switch)
  useEffect(() => {
    if (instrumentProp) setInstrSymbol(instrumentProp)
  }, [instrumentProp])
  useEffect(() => {
    if (entryProp != null) setEntryStr(String(entryProp))
  }, [entryProp])
  useEffect(() => {
    if (slProp != null) setSlStr(String(slProp))
  }, [slProp])

  const instr = useMemo(() => findInstrument(instrSymbol) || MT5_INSTRUMENTS[0], [instrSymbol])
  const entryNum = Number(entryStr)
  const slNum = Number(slStr)
  const splitsNum = Math.max(1, Math.floor(Number(splitsStr) || 1))

  const result = useMemo(() => {
    if (balance == null) return null
    return computeMt5Position(instr, entryNum, slNum, balance, riskPct, splitsNum)
  }, [instr, entryNum, slNum, balance, riskPct, splitsNum])

  const MIN_LOT = 0.01
  const roundedTotal = result ? Math.floor(result.totalLots * 100) / 100 : 0
  const roundedPer = result ? Math.floor(result.perSplitLots * 100) / 100 : 0

  if (balance == null || balance <= 0) {
    return (
      <div className="bg-card rounded-lg p-3 text-xs text-text-secondary">
        Депозит MT5 не задан. Открой <span className="text-accent">Калькулятор</span> и сохрани баланс, чтобы увидеть размер позиции.
      </div>
    )
  }

  return (
    <div className="bg-card rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">MT5 калькулятор</span>
        <span className="text-[10px] text-text-secondary font-mono">
          Депо ${balance.toFixed(0)} · Риск {riskPct}%
        </span>
      </div>

      {editable && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-text-secondary block mb-0.5">Инструмент</label>
            <select
              value={instrSymbol}
              onChange={(e) => setInstrSymbol(e.target.value)}
              className="w-full bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
            >
              {MT5_INSTRUMENTS.map((i) => (
                <option key={i.symbol} value={i.symbol}>
                  {i.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-secondary block mb-0.5">Вход</label>
            <input
              type="number"
              value={entryStr}
              onChange={(e) => setEntryStr(e.target.value)}
              step={instr.pipSize}
              className="w-full bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-text-secondary block mb-0.5">SL</label>
            <input
              type="number"
              value={slStr}
              onChange={(e) => setSlStr(e.target.value)}
              step={instr.pipSize}
              className="w-full bg-input text-text-primary font-mono text-xs rounded px-2 py-1.5 outline-none"
            />
          </div>
        </div>
      )}

      {result ? (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${result.direction === 'BUY' ? 'bg-long/20 text-long' : 'bg-short/20 text-short'}`}>
              {result.direction}
            </span>
            <span className="text-text-secondary">
              SL: <span className="font-mono text-text-primary">{round(result.stopPriceDist, instr.decimals)}</span>
              {' · '}
              <span className="font-mono text-text-primary">{round(result.stopInPips, 1)}</span> пипс
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-text-secondary">Риск при SL</span>
            <span className="font-mono text-short">${round(result.riskAmount, 2)}</span>

            <span className="text-text-secondary">Убыток / 1 лот</span>
            <span className="font-mono text-text-primary">${round(result.lossPerLot, 2)}</span>

            <span className="text-text-secondary">Объём позиции</span>
            <span className="font-mono text-accent">
              {round(result.totalLots, 2)} лот
              {roundedTotal !== round(result.totalLots, 2) && (
                <span className="text-text-secondary text-[10px] ml-1">(~{round(result.totalLots, 4)})</span>
              )}
            </span>

            {splitsNum > 1 && (
              <>
                <span className="text-text-secondary">На сплит ({splitsNum})</span>
                <span className="font-mono text-accent">
                  {round(result.perSplitLots, 2)} лот
                  {roundedPer !== round(result.perSplitLots, 2) && (
                    <span className="text-text-secondary text-[10px] ml-1">(~{round(result.perSplitLots, 4)})</span>
                  )}
                </span>
              </>
            )}
          </div>

          {result.totalLots < MIN_LOT && (
            <div className="text-[10px] text-short">
              ⚠️ Объём меньше мин. лота 0.01. Минимум депо: $
              {round((MIN_LOT * result.lossPerLot) / (riskPct / 100), 0)}
            </div>
          )}

          {instr.quoteKind !== 'usd_quote' && (
            <p className="text-[10px] text-text-secondary">
              ⚠️ {instr.symbol}: убыток рассчитан приблизительно (±1–3%).
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-text-secondary">Задай вход и SL чтобы увидеть лоты.</p>
      )}

      {editable && (
        <div className="flex items-center gap-2 pt-1 border-t border-input">
          <label className="text-[10px] text-text-secondary">Делить на TP:</label>
          <input
            type="number"
            value={splitsStr}
            onChange={(e) => setSplitsStr(e.target.value)}
            min={1}
            max={10}
            className="w-16 bg-input text-text-primary font-mono text-xs rounded px-2 py-1 outline-none"
          />
        </div>
      )}
    </div>
  )
}
