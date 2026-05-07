/**
 * Ladder backtester — closes a position in stages at successive structural levels.
 *
 * For each signal, the strategy provides:
 *   - side, entry price
 *   - SL price (from opposite-side level)
 *   - tpLadder: array of TP prices in direction of trade (sorted nearest-first)
 *
 * Behavior per bar:
 *   1) Check SL hit (intra-bar wick) — if hit, close remaining position at SL price
 *   2) Check ladder TPs in order (nearest first):
 *      - 'wick' mode: TP hits when bar wick reaches level
 *        - if subsequent close stays beyond level → break-through (don't fill, hold for next TP)
 *        - if close returns below (LONG) / above (SHORT) → reaction, fill the partial
 *      - 'close' mode: TP hits only when bar CLOSES at-or-beyond level (simpler, slightly later fills)
 *   3) On each TP fill, advance trailing SL:
 *      - After TP1 → SL = entry (BE)
 *      - After TPn (n>1) → SL = TP(n-1)
 *   4) Position size: caller supplies ladder split (e.g. 0.5 / 0.3 / 0.2). If ladder
 *      has fewer levels than splits, redistribute the remainder to the last TP.
 *      If ladder has MORE levels than splits, ignore extra TPs (close everything at last splittable TP).
 *
 * P&L is reported in R = entry_to_initial_SL distance. Each partial contributes
 * (fillPrice - entry) * frac / R for LONG, mirrored for SHORT.
 */

import { OHLCV } from '../services/market'

export type LadderSide = 'BUY' | 'SELL'
export type LadderExitMode = 'wick' | 'close'
export type LadderExitReason = 'SL' | 'LADDER_DONE' | 'MAX_HOLD' | 'EOD'

export interface LadderSignal {
  side: LadderSide
  entryTime: number
  entryPrice: number
  sl: number
  tpLadder: number[] // sorted nearest-first in trade direction
  reason?: string
}

export type LadderGenerator = (i: number) => LadderSignal | null

export interface LadderConfig {
  feesRoundTrip: number
  slippagePerSide: number
  splits: number[] // e.g. [0.5, 0.3, 0.2]
  exitMode: LadderExitMode
  /** After TP1, move SL to entry; after TPn, move SL to TP(n-1). */
  trailing: boolean
  /**
   * Trailing mode (only relevant if trailing=true):
   *   'full'   — TP1→BE, TP2→TP1, TP3→TP2 (default, classic trailing)
   *   'tp1Only' — TP1→BE only, TP2/TP3 do NOT move SL further (let runners run)
   */
  trailingMode?: 'full' | 'tp1Only'
  maxHoldBars: number // 0 = no limit
  /**
   * Override: if set, ignore `splits` and close 100% of position on this TP index.
   * 0 = TP1 only, 1 = TP2 only, 2 = TP3 only.
   * No trailing applied — full close on first hit of that TP.
   */
  singleTpIdx?: number
}

export const DEFAULT_LADDER: LadderConfig = {
  feesRoundTrip: 0.0008, // approx maker round-trip; per-side adjusted in pnl
  slippagePerSide: 0,
  splits: [0.5, 0.3, 0.2],
  exitMode: 'wick',
  trailing: true,
  maxHoldBars: 0,
}

export interface LadderTrade {
  side: LadderSide
  entryTime: number
  entryPrice: number
  fillPrice: number
  initialSL: number
  riskPerUnit: number
  exitTime: number
  exitReason: LadderExitReason
  /** TPs that were filled, in order. Each: { idx, price, frac, rContrib } */
  fills: Array<{ idx: number; price: number; frac: number; rContrib: number }>
  pnlR: number
  grossR: number
  durationCandles: number
  ladderLength: number
  finalSL: number
}

export interface LadderResult {
  trades: LadderTrade[]
  signalsGenerated: number
}

interface OpenPos {
  sig: LadderSignal
  fillPrice: number
  initialSL: number
  trailingSL: number
  risk: number
  openIdx: number
  /** ladder ptr — next TP idx to be filled (0..ladder.length) */
  nextTpIdx: number
  /** remaining position fraction (1.0 → 0) */
  remainingFrac: number
  /** distributed split amounts aligned with ladder (length = min(ladder, splits)) */
  splitsForThis: number[]
  fills: Array<{ idx: number; price: number; frac: number; rContrib: number }>
}

/**
 * Build splits for "close 100% at single TP idx" mode.
 * Result: 0% on all TPs except `tpIdx`, which gets 100%.
 * If `tpIdx` >= ladderLen, redirects to last available TP.
 */
function buildSingleTpSplits(ladderLen: number, tpIdx: number): number[] {
  if (ladderLen <= 0) return []
  const out = new Array(ladderLen).fill(0)
  const idx = Math.min(tpIdx, ladderLen - 1)
  out[idx] = 1.0
  return out
}

function alignSplits(ladderLen: number, splits: number[]): number[] {
  if (ladderLen <= 0) return []
  if (ladderLen >= splits.length) return [...splits, ...new Array(ladderLen - splits.length).fill(0)].slice(0, ladderLen).map((v, i, arr) => {
    // last entry takes the leftover
    if (i === ladderLen - 1) {
      const used = arr.slice(0, -1).reduce((a, b) => a + b, 0)
      return Math.max(0, 1 - used)
    }
    return v
  })
  // ladder shorter than splits: take first N splits and dump remainder onto last
  const out = splits.slice(0, ladderLen)
  const used = out.slice(0, -1).reduce((a, b) => a + b, 0)
  out[out.length - 1] = Math.max(0, 1 - used)
  return out
}

export function runLadderBacktest(
  candles: OHLCV[],
  gen: LadderGenerator,
  cfg: LadderConfig = DEFAULT_LADDER,
): LadderResult {
  const trades: LadderTrade[] = []
  let pos: OpenPos | null = null
  let signalCount = 0

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]

    if (pos) {
      const isLong = pos.sig.side === 'BUY'

      // 1) SL check (intra-bar)
      const slHit = isLong ? c.low <= pos.trailingSL : c.high >= pos.trailingSL
      if (slHit) {
        // Close remaining at SL
        const exitFill = isLong ? pos.trailingSL * (1 - cfg.slippagePerSide) : pos.trailingSL * (1 + cfg.slippagePerSide)
        const rContrib = (isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac / pos.risk
        pos.fills.push({ idx: -1, price: exitFill, frac: pos.remainingFrac, rContrib })
        pos.remainingFrac = 0
        trades.push(closeTrade(pos, c.time, 'SL', i, cfg))
        pos = null
        continue
      }

      // 2) Ladder TPs
      let progressed = true
      while (pos && progressed && pos.nextTpIdx < pos.sig.tpLadder.length && pos.remainingFrac > 1e-9) {
        progressed = false
        const tpIdx = pos.nextTpIdx
        const tp = pos.sig.tpLadder[tpIdx]

        // wick reach
        const wickReached = isLong ? c.high >= tp : c.low <= tp
        // close reach
        const closeReached = isLong ? c.close >= tp : c.close <= tp

        let fill = false
        if (cfg.exitMode === 'close') {
          fill = closeReached
        } else {
          // wick mode: fill if wick reaches AND (close didn't push beyond OR this is the last TP)
          // The intuition from user's chart: if close pushes through, hold for next TP; otherwise fill.
          if (wickReached) {
            const isLastTp = tpIdx === pos.sig.tpLadder.length - 1
            const closeBeyond = isLong ? c.close > tp : c.close < tp
            if (!closeBeyond || isLastTp) fill = true
            // If closeBeyond and not last → don't fill here; the wick might have reached the NEXT tp too. Loop again.
          }
        }

        if (fill) {
          const frac = pos.splitsForThis[tpIdx] ?? 0
          if (frac > 0) {
            const exitFill = isLong ? tp * (1 - cfg.slippagePerSide) : tp * (1 + cfg.slippagePerSide)
            const rContrib = (isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * frac / pos.risk
            pos.fills.push({ idx: tpIdx, price: exitFill, frac, rContrib })
            pos.remainingFrac = Math.max(0, pos.remainingFrac - frac)

            // Trailing SL
            if (cfg.trailing) {
              const mode = cfg.trailingMode ?? 'full'
              if (tpIdx === 0) {
                pos.trailingSL = pos.fillPrice // BE — applies to both modes
              } else if (mode === 'full') {
                pos.trailingSL = pos.sig.tpLadder[tpIdx - 1]
              }
              // tp1Only: do NOT move SL further after TP1
            }
          }
          pos.nextTpIdx++
          progressed = true

          if (pos.remainingFrac <= 1e-9) {
            trades.push(closeTrade(pos, c.time, 'LADDER_DONE', i, cfg))
            pos = null
            break
          }
        } else if (cfg.exitMode === 'wick' && wickReached) {
          // Bar pushed through this TP without filling — advance ptr to check next TP same bar
          pos.nextTpIdx++
          progressed = true
        }
      }
      if (!pos) continue

      // 3) Max hold
      if (cfg.maxHoldBars > 0 && i - pos.openIdx >= cfg.maxHoldBars) {
        const exitFill = isLong ? c.close * (1 - cfg.slippagePerSide) : c.close * (1 + cfg.slippagePerSide)
        const rContrib = (isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac / pos.risk
        pos.fills.push({ idx: -1, price: exitFill, frac: pos.remainingFrac, rContrib })
        pos.remainingFrac = 0
        trades.push(closeTrade(pos, c.time, 'MAX_HOLD', i, cfg))
        pos = null
      }
      continue
    }

    const sig = gen(i)
    if (!sig) continue
    signalCount++
    if (sig.tpLadder.length === 0) continue

    const isLong = sig.side === 'BUY'
    const entryFill = isLong ? sig.entryPrice * (1 + cfg.slippagePerSide) : sig.entryPrice * (1 - cfg.slippagePerSide)
    const risk = Math.abs(entryFill - sig.sl)
    if (risk <= 0) continue
    if (isLong && sig.sl >= entryFill) continue
    if (!isLong && sig.sl <= entryFill) continue
    // Sanity: tpLadder must be on correct side and beyond entry
    const validLadder = sig.tpLadder.every((p) => isLong ? p > entryFill : p < entryFill)
    if (!validLadder) continue

    pos = {
      sig,
      fillPrice: entryFill,
      initialSL: sig.sl,
      trailingSL: sig.sl,
      risk,
      openIdx: i,
      nextTpIdx: 0,
      remainingFrac: 1,
      splitsForThis: cfg.singleTpIdx !== undefined
        ? buildSingleTpSplits(sig.tpLadder.length, cfg.singleTpIdx)
        : alignSplits(sig.tpLadder.length, cfg.splits),
      fills: [],
    }
  }

  if (pos) {
    const last = candles[candles.length - 1]
    const isLong = pos.sig.side === 'BUY'
    const exitFill = isLong ? last.close * (1 - cfg.slippagePerSide) : last.close * (1 + cfg.slippagePerSide)
    const rContrib = (isLong ? exitFill - pos.fillPrice : pos.fillPrice - exitFill) * pos.remainingFrac / pos.risk
    pos.fills.push({ idx: -1, price: exitFill, frac: pos.remainingFrac, rContrib })
    pos.remainingFrac = 0
    trades.push(closeTrade(pos, last.time, 'EOD', candles.length - 1, DEFAULT_LADDER))
  }

  return { trades, signalsGenerated: signalCount }
}

function closeTrade(pos: OpenPos, exitTime: number, reason: LadderExitReason, i: number, cfg: LadderConfig): LadderTrade {
  const grossR = pos.fills.reduce((s, f) => s + f.rContrib, 0)
  const feeAbs = pos.fillPrice * cfg.feesRoundTrip
  const feeR = feeAbs / pos.risk
  const pnlR = grossR - feeR
  return {
    side: pos.sig.side,
    entryTime: pos.sig.entryTime,
    entryPrice: pos.sig.entryPrice,
    fillPrice: pos.fillPrice,
    initialSL: pos.initialSL,
    riskPerUnit: pos.risk,
    exitTime,
    exitReason: reason,
    fills: pos.fills,
    pnlR: Math.round(pnlR * 10000) / 10000,
    grossR: Math.round(grossR * 10000) / 10000,
    durationCandles: i - pos.openIdx,
    ladderLength: pos.sig.tpLadder.length,
    finalSL: pos.trailingSL,
  }
}

// ===== Metrics =====

export interface LadderMetrics {
  totalTrades: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  expectancyR: number
  totalR: number
  avgWinR: number
  avgLossR: number
  profitFactor: number
  maxDrawdownR: number
  longCount: number
  shortCount: number
  longWR: number
  shortWR: number
  exitReasons: Record<string, number>
  avgDurationCandles: number
  feesPaidR: number
  /** average # of TPs filled per trade (0..N) */
  avgFillsPerTrade: number
  /** # of trades that filled at least TP1 (a partial win) */
  reachedTp1: number
  /** # of trades that filled all ladder TPs */
  fullLadder: number
}

export function ladderMetrics(trades: LadderTrade[]): LadderMetrics {
  const n = trades.length
  if (n === 0) return emptyM()
  let wins = 0, losses = 0, be = 0, sumWin = 0, sumLoss = 0, totalR = 0, durSum = 0, fees = 0
  let totalFills = 0, reachedTp1 = 0, fullLadder = 0
  const exits: Record<string, number> = {}
  for (const t of trades) {
    totalR += t.pnlR
    durSum += t.durationCandles
    fees += t.grossR - t.pnlR
    exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1
    const tpFills = t.fills.filter((f) => f.idx >= 0).length
    totalFills += tpFills
    if (tpFills >= 1) reachedTp1++
    if (tpFills >= t.ladderLength) fullLadder++
    if (t.pnlR > 0.001) { wins++; sumWin += t.pnlR }
    else if (t.pnlR < -0.001) { losses++; sumLoss += t.pnlR }
    else be++
  }
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) {
    eq += t.pnlR
    if (eq > peak) peak = eq
    const dd = peak - eq
    if (dd > maxDD) maxDD = dd
  }
  const longs = trades.filter((t) => t.side === 'BUY')
  const shorts = trades.filter((t) => t.side === 'SELL')
  const lW = longs.filter((t) => t.pnlR > 0.001).length
  const sW = shorts.filter((t) => t.pnlR > 0.001).length
  return {
    totalTrades: n,
    wins, losses, breakeven: be,
    winRate: r4(wins / n),
    expectancyR: r4(totalR / n),
    totalR: r4(totalR),
    avgWinR: wins > 0 ? r4(sumWin / wins) : 0,
    avgLossR: losses > 0 ? r4(sumLoss / losses) : 0,
    profitFactor: sumLoss < 0 ? r4(sumWin / -sumLoss) : sumWin > 0 ? 999 : 0,
    maxDrawdownR: r4(maxDD),
    longCount: longs.length, shortCount: shorts.length,
    longWR: longs.length > 0 ? r4(lW / longs.length) : 0,
    shortWR: shorts.length > 0 ? r4(sW / shorts.length) : 0,
    exitReasons: exits,
    avgDurationCandles: r4(durSum / n),
    feesPaidR: r4(fees),
    avgFillsPerTrade: r4(totalFills / n),
    reachedTp1, fullLadder,
  }
}
function emptyM(): LadderMetrics {
  return {
    totalTrades: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, expectancyR: 0, totalR: 0,
    avgWinR: 0, avgLossR: 0, profitFactor: 0, maxDrawdownR: 0,
    longCount: 0, shortCount: 0, longWR: 0, shortWR: 0,
    exitReasons: {}, avgDurationCandles: 0, feesPaidR: 0,
    avgFillsPerTrade: 0, reachedTp1: 0, fullLadder: 0,
  }
}
function r4(v: number) { return Math.round(v * 10000) / 10000 }

export function formatLadder(m: LadderMetrics, label: string): string {
  if (m.totalTrades === 0) return `[${label}] No trades.`
  return [
    `=== ${label} ===`,
    `Trades:        ${m.totalTrades}  (long ${m.longCount} / short ${m.shortCount})`,
    `Win rate:      ${(m.winRate * 100).toFixed(1)}%   (long ${(m.longWR * 100).toFixed(1)}% / short ${(m.shortWR * 100).toFixed(1)}%)`,
    `Expectancy:    ${m.expectancyR >= 0 ? '+' : ''}${m.expectancyR.toFixed(3)}R per trade`,
    `Total return:  ${m.totalR >= 0 ? '+' : ''}${m.totalR.toFixed(2)}R`,
    `Avg win/loss:  +${m.avgWinR.toFixed(3)}R / ${m.avgLossR.toFixed(3)}R   (BE: ${m.breakeven})`,
    `Profit factor: ${m.profitFactor.toFixed(2)}`,
    `Max drawdown:  ${m.maxDrawdownR.toFixed(2)}R`,
    `Avg fills/tr:  ${m.avgFillsPerTrade.toFixed(2)} (TP1+: ${m.reachedTp1}, full: ${m.fullLadder})`,
    `Avg duration:  ${m.avgDurationCandles.toFixed(1)} bars`,
    `Exit reasons:  ${JSON.stringify(m.exitReasons)}`,
    `Fees paid:     ${m.feesPaidR.toFixed(2)}R`,
  ].join('\n')
}
