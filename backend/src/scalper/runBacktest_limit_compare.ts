/**
 * Compare entry modes: MARKET (close-confirmation) vs LIMIT_CONFIRMED (entry=level price).
 *
 * Both modes use the same signal stream from generateSignalV2 (i.e. signal fires only
 * on a confirmed REACTION/BREAKOUT_RETEST bar). Difference:
 *   - MARKET: entry = bar close (current behavior, taker)
 *   - LIMIT_CONFIRMED: entry = level price (assume limit order at level was filled
 *     intra-bar; the same bar's close confirmed the reaction so we keep the position).
 *     TP ladder distances vs entry remain natural (TP prices are absolute level prices),
 *     SL stays the same absolute price, but R is now larger (entry is closer to SL? no —
 *     LIMIT entry is at level which is FARTHER from current price for a long, but R is
 *     measured entry−SL: for BUY, SL is below level, entry=level, so R = level−SL).
 *
 * Critical: in MARKET mode entry=close (above level for BUY reaction), so R_market > R_limit
 *   for the same SL. With LIMIT, R is smaller → win in R-units gets bigger from same TP price.
 *   This is the whole point — better fill = bigger R per trade.
 *
 * fees per round-trip:
 *   - MARKET: 0.08% taker (Bybit linear)
 *   - LIMIT: 0.02% maker (entry=maker, exit=taker on TP wicks → ~half)
 *     We use 0.04% as conservative blended estimate.
 *
 * Run: cd backend && npx tsx src/scalper/runBacktest_limit_compare.ts
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { OHLCV } from '../services/market'
import { loadHistorical } from './historicalLoader'
import {
  precomputeLevelsV2, generateSignalV2, newSignalState, aggregateDailyToWeekly,
  DEFAULT_LEVELS_V2, LevelsV2Config,
} from './levelsEngine2'
import {
  runLadderBacktest, DEFAULT_LADDER, LadderConfig, LadderSignal,
} from './ladderBacktester'

const DAYS_BACK = 365
const BUFFER_DAYS = 60
const MONTHS_BACK = 14

type Side = 'BUY' | 'SELL' | 'BOTH'
type EntryMode = 'MARKET' | 'LIMIT_CONFIRMED'

interface RunCase {
  symbol: string
  side: Side
  /** Per-symbol tpMinAtr from prior sweep (DEFAULT_SETUPS production). */
  tpMinAtr?: number
}

// Same as production DEFAULT_SETUPS in levelsLiveScanner.ts
const CASES: RunCase[] = [
  { symbol: 'BTCUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
  { symbol: 'XRPUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'SEIUSDT',      side: 'SELL' },
  { symbol: 'WIFUSDT',      side: 'SELL', tpMinAtr: 2.0 },
  { symbol: 'SOLUSDT',      side: 'SELL', tpMinAtr: 1.0 },
  { symbol: 'ARBUSDT',      side: 'SELL' },
  { symbol: 'AVAXUSDT',     side: 'SELL', tpMinAtr: 1.0 },
  { symbol: '1000PEPEUSDT', side: 'SELL' },
  { symbol: 'ETHUSDT',      side: 'SELL' },
  { symbol: 'HYPEUSDT',     side: 'BUY',  tpMinAtr: 0.5 },
  { symbol: 'ENAUSDT',      side: 'BOTH', tpMinAtr: 1.5 },
]

function buildCfg(tpMinAtr: number): LevelsV2Config {
  return {
    ...DEFAULT_LEVELS_V2,
    fractalLeft: 3, fractalRight: 3,
    fractalLeftM15: 3, fractalRightM15: 3,
    fractalLeftH1: 3, fractalRightH1: 3,
    minSeparationAtr: 0.8, minTouchesBeforeSignal: 2,
    cooldownBars: 12,
    allowRangePlay: false,
    fiboMode: 'filter',
    fiboZoneFrom: 0.5, fiboZoneTo: 0.618,
    fiboImpulseLookback: 100, fiboImpulseMinAtr: 8,
    tpMinAtr,
  }
}

function sliceLastDays(arr: OHLCV[], days: number): OHLCV[] {
  const cutoff = Date.now() - (days + BUFFER_DAYS) * 24 * 60 * 60_000
  return arr.filter((c) => c.time >= cutoff)
}

interface Result {
  symbol: string
  side: Side
  mode: EntryMode
  trades: number
  totalR: number
  rPerTrade: number
  winRate: number
  pf: number
  avgRiskUnits: number  // average $-distance entry to SL — for sanity
}

interface LoadedData { m5: OHLCV[]; m15: OHLCV[]; h1: OHLCV[]; d1: OHLCV[] }

async function loadAll(symbol: string): Promise<LoadedData | null> {
  try {
    const m5  = await loadHistorical(symbol, '5m',  MONTHS_BACK, 'bybit', 'linear')
    const m15 = await loadHistorical(symbol, '15m', MONTHS_BACK, 'bybit', 'linear')
    const h1  = await loadHistorical(symbol, '1h',  MONTHS_BACK, 'bybit', 'linear')
    const d1  = await loadHistorical(symbol, '1d',  MONTHS_BACK, 'bybit', 'linear')
    return { m5, m15, h1, d1 }
  } catch (e: any) {
    console.warn(`[${symbol}] load failed: ${e.message}`)
    return null
  }
}

function runOne(data: LoadedData, c: RunCase, mode: EntryMode): Result {
  const ltf = sliceLastDays(data.m5, DAYS_BACK)
  const mtf = sliceLastDays(data.m15, DAYS_BACK)
  const htf = sliceLastDays(data.h1, DAYS_BACK)
  const dly = sliceLastDays(data.d1, DAYS_BACK)
  const w1 = aggregateDailyToWeekly(dly)
  const cfg = buildCfg(c.tpMinAtr ?? 0)
  const pre = precomputeLevelsV2(ltf, dly, w1, cfg, mtf, htf)
  const cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60_000

  // Generate signals once, then transform per mode.
  const sigByIdx = new Map<number, LadderSignal>()
  const state = newSignalState()
  let totalRiskUnits = 0
  let nSig = 0

  for (let i = 0; i < ltf.length; i++) {
    if (ltf[i].time < cutoff) continue
    const s = generateSignalV2(ltf, i, cfg, pre, state)
    if (!s) continue
    if (c.side !== 'BOTH' && s.side !== c.side) continue

    let entry: number
    if (mode === 'MARKET') {
      entry = s.entryPrice  // = bar close
    } else {
      // LIMIT_CONFIRMED: entry at the level itself.
      // For REACTION the limit at level fills as wick reaches it intra-bar.
      // For BREAKOUT_RETEST the "level" is also the retest line — same logic.
      entry = s.level
    }

    // Validate: for BUY, entry must be > sl AND < closest TP. For SELL, mirrored.
    // After moving entry to level, this might break ordering for some BREAKOUT_RETEST
    // signals where the level was BEHIND the close. Skip those (would be an immediate fill at
    // worse price than market — non-sensical for limit logic).
    if (s.side === 'BUY') {
      if (entry <= s.slPrice) continue
      // For LIMIT, the entry must be at-or-below the bar close (otherwise the limit
      // never would have been touched intra-bar). For BUY we want price to dip TO level
      // → require ltf[i].low <= level.
      if (mode === 'LIMIT_CONFIRMED' && ltf[i].low > entry) continue
    } else {
      if (entry >= s.slPrice) continue
      if (mode === 'LIMIT_CONFIRMED' && ltf[i].high < entry) continue
    }

    // Filter ladder relative to NEW entry (some TPs that were valid for close-entry might
    // be on wrong side of the new entry).
    const tpLadder = mode === 'MARKET'
      ? s.tpLadder
      : s.tpLadder.filter((p) => s.side === 'BUY' ? p > entry : p < entry)
    if (tpLadder.length === 0) continue

    sigByIdx.set(i, {
      side: s.side,
      entryTime: s.entryTime,
      entryPrice: entry,
      sl: s.slPrice,
      tpLadder,
      reason: s.reason,
    })
    totalRiskUnits += Math.abs(entry - s.slPrice)
    nSig++
  }

  // Fees: MARKET = 0.08% (taker both sides). LIMIT_CONFIRMED = 0.04% (maker entry, taker exit).
  const fees = mode === 'MARKET' ? 0.0008 : 0.0004
  const ladderCfg: LadderConfig = {
    ...DEFAULT_LADDER,
    exitMode: 'wick',
    splits: [0.5, 0.3, 0.2],
    trailing: true,
    feesRoundTrip: fees,
  }
  const r = runLadderBacktest(ltf, (i) => sigByIdx.get(i) ?? null, ladderCfg)

  const wins = r.trades.filter((t) => t.pnlR > 0)
  const losses = r.trades.filter((t) => t.pnlR < 0)
  const totalWinR = wins.reduce((a, t) => a + t.pnlR, 0)
  const totalLossR = Math.abs(losses.reduce((a, t) => a + t.pnlR, 0))
  const totalR = r.trades.reduce((a, t) => a + t.pnlR, 0)
  const winRate = r.trades.length > 0 ? (wins.length / r.trades.length) * 100 : 0
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? Infinity : 0)
  const ev = r.trades.length > 0 ? totalR / r.trades.length : 0
  const avgRisk = nSig > 0 ? totalRiskUnits / nSig : 0

  return {
    symbol: c.symbol, side: c.side, mode,
    trades: r.trades.length,
    totalR, rPerTrade: ev, winRate, pf,
    avgRiskUnits: avgRisk,
  }
}

function fmtPF(pf: number): string {
  if (pf === Infinity) return '∞'
  if (pf === 0) return '0'
  return pf.toFixed(2)
}

async function main() {
  console.log(`Compare entry modes: MARKET vs LIMIT_CONFIRMED`)
  console.log(`Cases: ${CASES.length} setups (production DEFAULT_SETUPS, 365d, Bybit linear)`)
  console.log(`Fees: MARKET 0.08% RT (taker), LIMIT 0.04% RT (maker entry + taker exit)\n`)

  const allResults: Result[] = []
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.side}${c.tpMinAtr ? ` tpMinAtr=${c.tpMinAtr}` : ''} ===`)
    const data = await loadAll(c.symbol)
    if (!data) { console.warn(`SKIP`); continue }

    console.log('mode               trades  totalR    R/tr    WR    PF    avgRisk')
    console.log('-'.repeat(72))
    for (const mode of (['MARKET', 'LIMIT_CONFIRMED'] as EntryMode[])) {
      const r = runOne(data, c, mode)
      allResults.push(r)
      const totalRStr = (r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1)
      const evStr = (r.rPerTrade >= 0 ? '+' : '') + r.rPerTrade.toFixed(2)
      console.log(
        `${mode.padEnd(18)} ${r.trades.toString().padStart(6)}  ${totalRStr.padStart(7)}  ${evStr.padStart(6)}  ${r.winRate.toFixed(0).padStart(3)}%  ${fmtPF(r.pf).padStart(5)}  ${r.avgRiskUnits.toExponential(2).padStart(9)}`
      )
    }
  }

  console.log('\n\n========== SUMMARY ==========\n')
  console.log('Symbol                Side  | MARKET                 | LIMIT_CONFIRMED        | Δ R/tr   | Δ totalR')
  console.log('-'.repeat(115))

  let portfolioMarketR = 0, portfolioLimitR = 0
  let portfolioMarketTrades = 0, portfolioLimitTrades = 0

  for (const c of CASES) {
    const m = allResults.find(r => r.symbol === c.symbol && r.mode === 'MARKET')
    const l = allResults.find(r => r.symbol === c.symbol && r.mode === 'LIMIT_CONFIRMED')
    if (!m || !l) continue

    portfolioMarketR += m.totalR; portfolioMarketTrades += m.trades
    portfolioLimitR += l.totalR; portfolioLimitTrades += l.trades

    const dEv = l.rPerTrade - m.rPerTrade
    const dTotal = l.totalR - m.totalR
    const dEvStr = (dEv >= 0 ? '+' : '') + dEv.toFixed(2)
    const dTotalStr = (dTotal >= 0 ? '+' : '') + dTotal.toFixed(1)
    const mStr = `N=${m.trades.toString().padStart(3)} R/tr=${(m.rPerTrade >= 0 ? '+' : '') + m.rPerTrade.toFixed(2)} totR=${(m.totalR >= 0 ? '+' : '') + m.totalR.toFixed(0)} PF=${fmtPF(m.pf)}`
    const lStr = `N=${l.trades.toString().padStart(3)} R/tr=${(l.rPerTrade >= 0 ? '+' : '') + l.rPerTrade.toFixed(2)} totR=${(l.totalR >= 0 ? '+' : '') + l.totalR.toFixed(0)} PF=${fmtPF(l.pf)}`
    const flag = dEv > 0.05 ? ' ★' : (dEv < -0.05 ? ' ✗' : '')
    console.log(`${c.symbol.padEnd(20)} ${c.side.padEnd(5)} | ${mStr.padEnd(22)} | ${lStr.padEnd(22)} | ${dEvStr.padStart(7)} | ${dTotalStr.padStart(7)}${flag}`)
  }

  console.log('-'.repeat(115))
  console.log(`PORTFOLIO TOTAL                | N=${portfolioMarketTrades.toString().padStart(4)} totR=${(portfolioMarketR >= 0 ? '+' : '') + portfolioMarketR.toFixed(0)}             | N=${portfolioLimitTrades.toString().padStart(4)} totR=${(portfolioLimitR >= 0 ? '+' : '') + portfolioLimitR.toFixed(0)}             | Δ totR = ${(portfolioLimitR - portfolioMarketR >= 0 ? '+' : '') + (portfolioLimitR - portfolioMarketR).toFixed(1)}`)

  const outDir = path.join(__dirname, '../../data/backtest')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `limit_compare_${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults }, null, 2))
  console.log(`\nSaved to ${outFile}`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
