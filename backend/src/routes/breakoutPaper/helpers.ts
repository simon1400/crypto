/**
 * Shared helpers for the breakout paper router family.
 *
 * All functions are variant-agnostic except where they receive a model/variant
 * parameter. They contain the math that previously lived inline inside route
 * handlers and was duplicated across endpoints (unrealized PnL, stats curve,
 * manual close, fee recompute, deposit recompute).
 */

import { loadHistorical } from '../../scalper/historicalLoader'
import { fetchPricesBatch } from '../../services/market'
import { syncSignalStatus } from '../../services/dailyBreakoutPaper'
import { getLiveSnapshot } from '../../services/dailyBreakoutLiveC'
import { BreakoutVariant } from '../../services/breakoutVariant'

export { CLOSED_STATUSES, ACTIVE_STATUSES } from '../../services/breakoutCommon/constants'
// Re-import for local use:
import { CLOSED_STATUSES } from '../../services/breakoutCommon/constants'

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const candles = await loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
    if (candles.length === 0) return null
    return candles[candles.length - 1].close
  } catch { return null }
}

/**
 * Recompute feesPaidUsd + netPnlUsd for a trade based on its closes array.
 * Used after PUT /trades/:id edits that touch fees, position, or closes.
 */
export function recalcFees(
  trade: any,
  feeRatePct: number,
  realRates?: { takerPct: number; makerPct: number } | null,
): { feesPaidUsd: number; netPnlUsd: number } {
  const closes = ((trade.closes as any[]) ?? []) as Array<{ price: number; percent: number; reason?: string }>
  let feesPaidUsd = 0
  // Entry fee — realistic model only. Charges taker rate on actual entry notional.
  if (realRates) {
    const entryNotional = (trade.positionUnits ?? 0) * (trade.entryPrice ?? 0)
    feesPaidUsd += entryNotional * (realRates.takerPct / 100)
  }
  for (const c of closes) {
    const notional = (trade.positionUnits ?? 0) * c.price * (c.percent / 100)
    if (realRates) {
      const isMaker = c.reason === 'TP1' || c.reason === 'TP2' || c.reason === 'TP3'
      const rate = isMaker ? realRates.makerPct : realRates.takerPct
      feesPaidUsd += notional * (rate / 100)
    } else {
      feesPaidUsd += notional * (feeRatePct / 100)
    }
  }
  const netPnlUsd = (trade.realizedPnlUsd ?? 0) - feesPaidUsd
  return { feesPaidUsd, netPnlUsd }
}

interface UnrealizedRow {
  id: number
  status: string
  currentPrice: number | null
  unrealizedPnl: number
  unrealizedPnlPct: number
  remainingUnrealizedPnl?: number
  remainingUnrealizedPnlPct?: number
}

/**
 * Compute the unrealized PnL view for a list of active trades. If variant ==='LIVE'
 * we prefer the Binance account snapshot (matches what the user sees on the
 * exchange UI exactly). Otherwise we use the ticker batch + an exit-fee estimate.
 */
export async function computeUnrealizedForTrades(
  trades: any[],
  variant: BreakoutVariant,
): Promise<UnrealizedRow[]> {
  if (trades.length === 0) return []

  const snapshot = variant === 'LIVE' ? await getLiveSnapshot() : null
  const snapshotBySymbol = new Map<string, { markPrice: number; unRealizedProfit: number }>()
  if (snapshot) {
    for (const p of snapshot.positions) {
      snapshotBySymbol.set(p.symbol, { markPrice: p.markPrice, unRealizedProfit: p.unRealizedProfit })
    }
  }

  const symbols: string[] = trades
    .map((t: any) => String(t.symbol))
    .filter((s: string) => !snapshotBySymbol.has(s))
  const prices = symbols.length > 0 ? await fetchPricesBatch(symbols) : {}

  return Promise.all(trades.map(async (t: any) => {
    const snap = snapshotBySymbol.get(t.symbol)
    const price: number | null = snap?.markPrice ?? prices[t.symbol] ?? null
    if (price == null) {
      return { id: t.id, status: t.status, currentPrice: null, unrealizedPnl: 0, unrealizedPnlPct: 0 }
    }
    const fills = (t.closes as any[]) ?? []
    const closedPctSoFar = fills.reduce((a: number, c: any) => a + (c.percent ?? 0), 0)
    const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
    if (remainingFrac < 1e-6) {
      return { id: t.id, status: t.status, currentPrice: price, unrealizedPnl: 0, unrealizedPnlPct: 0, remainingUnrealizedPnl: 0, remainingUnrealizedPnlPct: 0 }
    }

    let remainingUnrealized: number
    if (snap) {
      // Use Binance's own unrealizedProfit on the position. It's already
      // (markPrice − entry) × positionAmt, signed by side. No exit fee
      // deduction — match exactly what the exchange UI shows.
      remainingUnrealized = snap.unRealizedProfit
    } else {
      // Exit fee estimate: under realistic model the remaining position would
      // be closed via market on SL/EXPIRED — taker rate. Use trade override
      // first, then config defaults, then fall back to legacy flat.
      const isLong = t.side === 'BUY'
      const fillUnits = t.positionUnits * remainingFrac
      const unrealizedGross = (isLong ? price - t.entryPrice : t.entryPrice - price) * fillUnits
      const takerPct = t.feeTakerPct ?? null
      const feeRatePct = takerPct ?? t.feesRoundTripPct ?? 0.08
      const exitFeesIfClosedNow = t.positionUnits * price * remainingFrac * (feeRatePct / 100)
      // unrealizedPnl — только по нереализованному остатку. Реализованная часть
      // (realizedPnlUsd − feesPaidUsd) уже зачислена в currentDepositUsd через
      // applyDepositDelta в момент TP1/TP2 hit, повторно её прибавлять нельзя —
      // иначе equityWithOpen и плашка "+$X unrealized" задваивают TP1 partial closes.
      remainingUnrealized = unrealizedGross - exitFeesIfClosedNow
    }
    const remainingUnrealizedPnlPct = t.depositAtEntryUsd > 0
      ? (remainingUnrealized / t.depositAtEntryUsd) * 100 : 0
    return {
      id: t.id, status: t.status, currentPrice: price,
      unrealizedPnl: Math.round(remainingUnrealized * 100) / 100,
      unrealizedPnlPct: Math.round(remainingUnrealizedPnlPct * 100) / 100,
      remainingUnrealizedPnl: Math.round(remainingUnrealized * 100) / 100,
      remainingUnrealizedPnlPct: Math.round(remainingUnrealizedPnlPct * 100) / 100,
    }
  }))
}

/**
 * Build the stats payload (config, winRate, returnPct, bySymbol, equityCurve).
 * Used by both /stats route and the live router's shared handler.
 */
export async function computeStatsResponse(cm: any, tm: any, variant?: BreakoutVariant) {
  const cfg = await cm.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  const closed = await tm.findMany({
    where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
    select: { netPnlUsd: true, openedAt: true, closedAt: true, symbol: true },
  })
  const wins = closed.filter((t: any) => t.netPnlUsd > 0).length
  const losses = closed.filter((t: any) => t.netPnlUsd < 0).length
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0

  // Берём ВСЕ полностью или частично закрытые сделки и распределяем netPnl
  // (уже включает realistic taker/maker fees + slip, так как считался в
  // trackOnePaper) пропорционально по дням закрытий. Это согласовано с
  // currentDepositUsd, который инкрементируется через applyDepositDelta из
  // тех же netPnlUsd. Старый расчёт по legacy feesRoundTripPct давал расхождение
  // в $1+ на 30+ сделках (entry fees + slip пропускались).
  const allWithCloses = await tm.findMany({
    where: { NOT: { closes: { equals: [] } } },
    select: {
      symbol: true, status: true, closes: true,
      netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true,
      openedAt: true,
    },
  })

  const byDay: Record<string, number> = {}
  const bySymbolPnl: Record<string, number> = {}
  for (const t of allWithCloses) {
    const closesArr = ((t.closes as any[]) ?? []) as Array<{ price: number; percent: number; pnlUsd: number; closedAt: string; reason?: string }>
    // Total realized-net для сделки на текущий момент:
    //  - финализированная: netPnlUsd (учитывает entry fee + все exit fees + slip)
    //  - частичная (TP1_HIT/TP2_HIT): realizedPnlUsd - feesPaidUsd (то же самое, что считает applyDepositDelta для активных)
    const totalNet = CLOSED_STATUSES.has(t.status)
      ? t.netPnlUsd
      : (t.realizedPnlUsd - t.feesPaidUsd)
    // Распределяем totalNet между closes пропорционально их pnlUsd-вкладу.
    // Это нужно чтобы equity curve по дням совпала с фактическим депозитом —
    // entry fee и slip раскидываются между fills тем же весом, что P&L.
    const grossSum = closesArr.reduce((a, c) => a + (c.pnlUsd ?? 0), 0)
    for (const c of closesArr) {
      const weight = grossSum !== 0 ? (c.pnlUsd ?? 0) / grossSum : 1 / closesArr.length
      const netShare = totalNet * weight
      const day = (c.closedAt ? new Date(c.closedAt) : t.openedAt).toISOString().slice(0, 10)
      byDay[day] = (byDay[day] ?? 0) + netShare
      bySymbolPnl[t.symbol] = (bySymbolPnl[t.symbol] ?? 0) + netShare
    }
  }

  const equityCurve: Array<{ date: string; pnl: number; equity: number }> = []
  let running = cfg.startingDepositUsd
  for (const date of Object.keys(byDay).sort()) {
    running += byDay[date]
    equityCurve.push({ date, pnl: byDay[date], equity: running })
  }

  // For LIVE the curve should anchor to the actual Binance walletBalance so
  // the "Сейчас" figure on the equity panel matches the "Депозит" stat at the
  // top of the page. The wallet already includes entry-fees of currently open
  // positions and accrued funding ("прочее ...$"), neither of which is a
  // realized close — so by-day attribution from closes[] would otherwise drift
  // above wallet by exactly that amount. Book the residual (wallet − baseline
  // − Σ realized) as today's "other" P&L so the running total converges.
  if (variant === 'LIVE' && cfg.startingDepositUsd > 0) {
    try {
      const { getLiveSnapshot } = await import('../../services/dailyBreakoutLiveC')
      const snap = await getLiveSnapshot()
      if (snap && snap.total > 0) {
        const totalRealized = Object.values(byDay).reduce((a, b) => a + b, 0)
        const residual = snap.total - cfg.startingDepositUsd - totalRealized
        if (Math.abs(residual) > 0.005) {
          const today = new Date().toISOString().slice(0, 10)
          const todayHasCloses = byDay[today] !== undefined
          const lastIdx = equityCurve.findIndex((p) => p.date === today)
          if (lastIdx >= 0) {
            // У today есть реальные closes — residual это дрейф wallet от
            // суммы closes (entry fees ещё открытых позиций + funding). Кладём
            // его в pnl дня — это часть фактического движения капитала.
            equityCurve[lastIdx] = {
              date: today,
              pnl: equityCurve[lastIdx].pnl + residual,
              equity: equityCurve[lastIdx].equity + residual,
            }
            for (let i = lastIdx + 1; i < equityCurve.length; i++) {
              equityCurve[i] = { ...equityCurve[i], equity: equityCurve[i].equity + residual }
            }
          } else if (todayHasCloses) {
            // closes сегодня есть, но в кривую попали как «дрейф» прошлых
            // дней — добавим today отдельно, чтобы P&L дня отражал residual.
            equityCurve.push({
              date: today,
              pnl: residual,
              equity: cfg.startingDepositUsd + totalRealized + residual,
            })
          }
          // else: реализованных closes за today UTC нет — это entry fees
          // ещё-открытых позиций и funding по живым. Не создаём фейковую
          // строку «P&L today = residual$». "Сейчас" в шапке покажет
          // baseline+Σrealized, а разница с walletBalance — это unrealized
          // открытых позиций, не P&L дня.
        }
      }
    } catch (e: any) {
      console.warn(`[Stats] LIVE curve wallet-anchor skipped: ${e?.message ?? e}`)
    }
  }

  const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {}
  for (const t of closed) {
    bySymbol[t.symbol] = bySymbol[t.symbol] ?? { trades: 0, wins: 0, pnl: 0 }
    bySymbol[t.symbol].trades++
    if (t.netPnlUsd > 0) bySymbol[t.symbol].wins++
  }
  for (const sym of Object.keys(bySymbolPnl)) {
    bySymbol[sym] = bySymbol[sym] ?? { trades: 0, wins: 0, pnl: 0 }
    bySymbol[sym].pnl = bySymbolPnl[sym]
  }
  return {
    config: cfg, winRate,
    returnPct: cfg.startingDepositUsd > 0 ? ((cfg.currentDepositUsd - cfg.startingDepositUsd) / cfg.startingDepositUsd) * 100 : 0,
    bySymbol, equityCurve,
  }
}

/** Recompute deposit/peak/DD + total trade counters from closed trades. */
export async function recomputeDepositAndStats(cm: any, tm: any): Promise<void> {
  const cfg = await cm.findUnique({ where: { id: 1 } })
  if (!cfg) return
  const trades = await tm.findMany({
    where: {
      OR: [
        { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
        { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] }, NOT: { closes: { equals: [] } } },
      ],
    },
    select: { status: true, netPnlUsd: true, realizedPnlUsd: true, feesPaidUsd: true },
  })
  const closedOnly = trades.filter((t: any) => CLOSED_STATUSES.has(t.status))
  const totalTrades = closedOnly.length
  const totalWins = closedOnly.filter((t: any) => t.netPnlUsd > 0).length
  const totalLosses = closedOnly.filter((t: any) => t.netPnlUsd < 0).length
  const totalPnLUsd = trades.reduce((a: number, t: any) => {
    const realizedNet = CLOSED_STATUSES.has(t.status) ? t.netPnlUsd : (t.realizedPnlUsd - t.feesPaidUsd)
    return a + realizedNet
  }, 0)
  const newDeposit = cfg.startingDepositUsd + totalPnLUsd
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0
  await cm.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit, peakDepositUsd: newPeak, maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}

/**
 * Apply a taker-style close (manual market close, bulk close, or user-supplied
 * price) to a trade. Builds the fill entry, computes pnlR/pnlUsd/fees/slip and
 * the new status. Does NOT persist — caller is responsible for tm.update().
 *
 * Shared between POST /trades/:id/close-market, POST /trades/close-all-market,
 * and POST /trades/:id/close-manual (with applySlip=false).
 */
export interface TakerCloseInput {
  trade: any
  cfg: any
  /** Reference price (ticker or user input). */
  refPrice: number
  /** Fraction of remaining position to close, 0..1. Defaults to full remaining. */
  closeFrac?: number
  /** Apply slipTakerPct from trade/cfg as adverse slip on refPrice. */
  applySlip: boolean
}

export interface TakerCloseResult {
  fills: any[]
  status: string
  realizedR: number
  realizedPnlUsd: number
  feesPaidUsd: number
  slipPaidUsd: number
  netPnlUsd: number
  fillPrice: number
}

export function buildTakerClose(input: TakerCloseInput): TakerCloseResult | null {
  const { trade, cfg, refPrice, applySlip } = input
  const fills = ((trade.closes as any[]) ?? []) as any[]
  const closedPctSoFar = fills.reduce((a, c) => a + (c.percent ?? 0), 0)
  const remainingFrac = Math.max(0, 1 - closedPctSoFar / 100)
  if (remainingFrac < 1e-6) return null

  const isLong = trade.side === 'BUY'
  const closeFrac = input.closeFrac != null ? Math.min(input.closeFrac, remainingFrac) : remainingFrac

  const takerPct = trade.feeTakerPct ?? cfg?.feeTakerPct ?? null
  const slipPct = applySlip ? (trade.slipTakerPct ?? cfg?.slipTakerPct ?? null) : null
  const slipFrac = (slipPct ?? 0) / 100
  const price = slipFrac > 0
    ? (isLong ? refPrice * (1 - slipFrac) : refPrice * (1 + slipFrac))
    : refPrice

  const initialRisk = Math.abs(trade.entryPrice - trade.initialStop)
  const pnlR = ((isLong ? price - trade.entryPrice : trade.entryPrice - price) / initialRisk) * closeFrac
  const fillUnits = trade.positionUnits * closeFrac
  const pnlUsd = (isLong ? price - trade.entryPrice : trade.entryPrice - price) * fillUnits
  const slipUsdNew = applySlip ? fillUnits * Math.abs(price - refPrice) : 0

  fills.push({
    price, percent: closeFrac * 100, pnlR, pnlUsd,
    closedAt: new Date().toISOString(), reason: 'MANUAL',
  })

  // Fee — taker rate (realistic), or legacy flat fallback.
  const notional = fillUnits * price
  const newFeeUsd = takerPct != null
    ? notional * (takerPct / 100)
    : notional * ((trade.feesRoundTripPct ?? cfg?.feesRoundTripPct ?? 0) / 100)
  const totalFeesUsd = trade.feesPaidUsd + newFeeUsd
  const totalSlipUsd = (trade.slipPaidUsd ?? 0) + slipUsdNew
  const realizedPnlUsd = trade.realizedPnlUsd + pnlUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd
  const realizedR = trade.realizedR + pnlR
  const newRemaining = remainingFrac - closeFrac
  const status = newRemaining < 1e-6 ? 'CLOSED' : trade.status

  return {
    fills, status, realizedR, realizedPnlUsd,
    feesPaidUsd: totalFeesUsd, slipPaidUsd: totalSlipUsd, netPnlUsd, fillPrice: price,
  }
}

/** Mirror trade closure back to the shared BreakoutSignal (variant A only). */
export async function mirrorToSignal(
  variant: BreakoutVariant,
  trade: any,
  status: string,
  realizedR: number,
  fillPrice: number,
  fills: any[],
): Promise<void> {
  if (variant !== 'A' || !trade.signalId) return
  const isTerminal = CLOSED_STATUSES.has(status)
  await syncSignalStatus(
    trade.signalId,
    status as any,
    realizedR,
    fillPrice,
    isTerminal ? new Date() : null,
    fills,
  )
}

/**
 * Overlay this variant's paper outcome onto a shared BreakoutSignal row.
 * For A we keep the canonical columns; for B/C we read the suffixed columns
 * (paperStatusB/paperStatusC, …) and rewrite them under the generic field
 * names the UI reads.
 */
export function applySignalOverlay(signal: any, variant: BreakoutVariant, trade: any | null): any {
  const extra = trade
    ? { _tradeStatus: trade.status, _tradeRealizedR: trade.realizedR, _tradeNetPnlUsd: trade.netPnlUsd }
    : {}
  if (variant === 'A') {
    return { ...signal, ...extra }
  }
  const s = signal as any
  const ps = variant === 'B' ? s.paperStatusB : s.paperStatusC
  const pr = variant === 'B' ? s.paperReasonB : s.paperReasonC
  const pu = variant === 'B' ? s.paperUpdatedAtB : s.paperUpdatedAtC
  return { ...signal, paperStatus: ps, paperReason: pr, paperUpdatedAt: pu, ...extra }
}
