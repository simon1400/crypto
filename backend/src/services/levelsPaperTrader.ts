/**
 * Levels Paper Trader — virtual ($) trading engine that mirrors live signals.
 *
 * Two cycles run in parallel:
 *   - Slow (every 5 min): opens new paper trades, replays 5m klines for TP/SL/expiry.
 *     Catches wicks (high/low) that fast cycle's last-price can't see.
 *   - Fast (every 2 sec): polls last-price via Bybit batch endpoint, applies
 *     TP/SL on synthetic single-tick candle. Sub-second latency in normal flow.
 *
 * No Telegram notifications — only DB writes. UI displays everything.
 */

import { prisma } from '../db/prisma'
import { OHLCV, fetchPricesBatch } from './market'
import { loadHistorical } from '../scalper/historicalLoader'

const SPLITS = [0.5, 0.3, 0.2] // must match production tracker

interface PaperConfig {
  id: number
  enabled: boolean
  startingDepositUsd: number
  currentDepositUsd: number
  riskPctPerTrade: number
  feesRoundTripPct: number
  autoTrailingSL: boolean
  dailyLossLimitPct: number
  weeklyLossLimitPct: number
  maxConcurrentPositions: number
  maxPositionsPerSymbol: number
  totalTrades: number
  totalWins: number
  totalLosses: number
  totalPnLUsd: number
  peakDepositUsd: number
  maxDrawdownPct: number
}

interface CloseRecord {
  price: number
  percent: number
  pnlR: number
  pnlUsd: number
  closedAt: string
  reason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED'
}

async function getOrCreateConfig(): Promise<PaperConfig | null> {
  try {
    const c = await prisma.levelsPaperConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    })
    return c as PaperConfig
  } catch (e: any) {
    // Table doesn't exist yet (migration not applied) — just return null,
    // paper service will skip until DB is ready.
    if (e?.message?.includes('does not exist')) {
      return null
    }
    throw e
  }
}

async function loadRecent5m(symbol: string): Promise<OHLCV[]> {
  return loadHistorical(symbol, '5m', 1, 'bybit', 'linear')
}

/**
 * Compute position size:
 *   riskUsd = deposit * riskPct%
 *   slDistance = |entry - sl|
 *   positionUnits = riskUsd / slDistance
 *   positionSizeUsd = entry * positionUnits  (notional)
 *
 * positionUnits is the base coin amount (e.g. BTC).
 */
function calcPosition(
  deposit: number, riskPct: number, entry: number, sl: number,
): { riskUsd: number; positionUnits: number; positionSizeUsd: number } {
  const riskUsd = (deposit * riskPct) / 100
  const slDist = Math.abs(entry - sl)
  if (slDist <= 0) return { riskUsd, positionUnits: 0, positionSizeUsd: 0 }
  const positionUnits = riskUsd / slDist
  const positionSizeUsd = entry * positionUnits
  return { riskUsd, positionUnits, positionSizeUsd }
}

/**
 * Open paper trades for new LevelsSignal that are missing in LevelsPaperTrade.
 * Skips entirely if circuit breakers are active.
 */
async function openNewPaperTrades(cfg: PaperConfig): Promise<number> {
  // Find recent signals (last 24h) that don't yet have a paper trade.
  // Includes signals that are still OPEN (NEW / ACTIVE / TP1_HIT / TP2_HIT) — backfill
  // so when user enables paper mode, they immediately see virtual versions of live trades.
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const signals = await prisma.levelsSignal.findMany({
    where: {
      createdAt: { gte: since },
      // Skip signals that are already terminal — no point opening a virtual trade for a closed one
      status: { in: ['NEW', 'ACTIVE', 'TP1_HIT', 'TP2_HIT'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (signals.length === 0) return 0

  const existingTrades = await prisma.levelsPaperTrade.findMany({
    where: { signalId: { in: signals.map((s) => s.id) } },
    select: { signalId: true },
  })
  const existingIds = new Set(existingTrades.map((t) => t.signalId))

  // Circuit breakers disabled (2026-05-06) — user wants every signal taken
  let opened = 0
  for (const sig of signals) {
    if (existingIds.has(sig.id)) continue

    // No concurrent / per-symbol caps — user opted in to take every signal (2026-05-06)
    const pos = calcPosition(cfg.currentDepositUsd, cfg.riskPctPerTrade, sig.entryPrice, sig.stopLoss)
    if (pos.positionUnits <= 0) continue

    // Use signal's openedAt (createdAt) as the entry timestamp so the tracker
    // replays from the moment the signal originally fired — backfilling any
    // already-happened TP/SL hits.
    // For LIMIT-mode signals: use entryFilledAt (when limit actually filled) so the
    // tracker doesn't replay TP/SL hits that happened during the PENDING phase.
    const entryAt = (sig as any).entryFilledAt
      ? new Date((sig as any).entryFilledAt)
      : new Date(sig.createdAt)
    await prisma.levelsPaperTrade.create({
      data: {
        signalId: sig.id,
        symbol: sig.symbol,
        market: sig.market,
        side: sig.side,
        entryPrice: sig.entryPrice,
        stopLoss: sig.stopLoss,
        initialStop: sig.initialStop,
        currentStop: sig.currentStop,
        tpLadder: sig.tpLadder as any,
        openedAt: entryAt,
        depositAtEntryUsd: cfg.currentDepositUsd,
        riskUsd: pos.riskUsd,
        positionSizeUsd: pos.positionSizeUsd,
        positionUnits: pos.positionUnits,
        // Snapshot config defaults — user can override per-trade later
        feesRoundTripPct: cfg.feesRoundTripPct,
        autoTrailingSL: cfg.autoTrailingSL,
        status: 'OPEN',
        expiresAt: sig.expiresAt,
      },
    })
    opened++
    console.log(`[Paper] opened virtual trade for sig ${sig.id} ${sig.symbol} ${sig.side} risk $${pos.riskUsd.toFixed(2)} pos $${pos.positionSizeUsd.toFixed(2)}`)
  }
  return opened
}

async function checkDailyLimit(cfg: PaperConfig): Promise<boolean> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)
  const closedToday = await prisma.levelsPaperTrade.findMany({
    where: { closedAt: { gte: startOfDay } },
    select: { netPnlUsd: true },
  })
  const dayPnL = closedToday.reduce((a, t) => a + t.netPnlUsd, 0)
  const dayPct = (dayPnL / cfg.currentDepositUsd) * 100
  return dayPct > -cfg.dailyLossLimitPct
}

async function checkWeeklyLimit(cfg: PaperConfig): Promise<boolean> {
  const d = new Date()
  const dow = d.getUTCDay()
  const monMs = d.getTime() - ((dow + 6) % 7) * 86400_000 - d.getUTCHours() * 3600_000 - d.getUTCMinutes() * 60_000
  const startOfWeek = new Date(monMs)
  const closedThisWeek = await prisma.levelsPaperTrade.findMany({
    where: { closedAt: { gte: startOfWeek } },
    select: { netPnlUsd: true },
  })
  const weekPnL = closedThisWeek.reduce((a, t) => a + t.netPnlUsd, 0)
  const weekPct = (weekPnL / cfg.currentDepositUsd) * 100
  return weekPct > -cfg.weeklyLossLimitPct
}

/**
 * Replay recent candles for one open paper trade and apply TP/SL logic + USD P&L.
 */
async function trackOnePaper(trade: any, candles: OHLCV[], cfg: PaperConfig): Promise<{ pnlDelta: number; statusChanged: boolean }> {
  const sinceMs = trade.lastPriceCheckAt
    ? new Date(trade.lastPriceCheckAt).getTime()
    : new Date(trade.openedAt).getTime()
  const newCandles = candles.filter((c) => c.time > sinceMs)
  if (newCandles.length === 0) return { pnlDelta: 0, statusChanged: false }

  const tpLadder: number[] = (trade.tpLadder as any[]) ?? []
  const isLong = trade.side === 'BUY'
  const entry = trade.entryPrice
  const initialRisk = Math.abs(entry - trade.initialStop)

  let nextTpIdx = 0
  let remainingFrac = 1
  const fills: CloseRecord[] = ((trade.closes as any[]) ?? []).map((c) => c as CloseRecord)
  for (const f of fills) {
    remainingFrac -= f.percent / 100
    if (f.reason === 'TP1') nextTpIdx = Math.max(nextTpIdx, 1)
    else if (f.reason === 'TP2') nextTpIdx = Math.max(nextTpIdx, 2)
    else if (f.reason === 'TP3') nextTpIdx = Math.max(nextTpIdx, 3)
  }
  if (remainingFrac < 1e-6) return { pnlDelta: 0, statusChanged: false }

  let currentStop: number = trade.currentStop
  let realizedR: number = trade.realizedR ?? 0
  let realizedPnlUsd: number = trade.realizedPnlUsd ?? 0
  let status: string = trade.status
  const positionUnits: number = trade.positionUnits

  let totalPnlDeltaUsd = 0
  let statusChanged = false

  for (const c of newCandles) {
    // SL check
    const slHit = isLong ? c.low <= currentStop : c.high >= currentStop
    if (slHit) {
      const pnlR = ((isLong ? currentStop - entry : entry - currentStop) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? currentStop - entry : entry - currentStop) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      fills.push({
        price: currentStop, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(),
        reason: 'SL',
      })
      remainingFrac = 0
      status = nextTpIdx === 0 ? 'SL_HIT' : 'CLOSED'
      statusChanged = true
      break
    }

    // TPs in order
    while (nextTpIdx < tpLadder.length && remainingFrac > 1e-6) {
      const tp = tpLadder[nextTpIdx]
      const tpHit = isLong ? c.high >= tp : c.low <= tp
      if (!tpHit) break

      const splitFrac = SPLITS[nextTpIdx] ?? remainingFrac
      const fillFrac = Math.min(splitFrac, remainingFrac)
      const pnlR = ((isLong ? tp - entry : entry - tp) / initialRisk) * fillFrac
      const fillUnits = positionUnits * fillFrac
      const pnlUsd = (isLong ? tp - entry : entry - tp) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      const tpName = (`TP${nextTpIdx + 1}`) as 'TP1' | 'TP2' | 'TP3'
      fills.push({
        price: tp, percent: fillFrac * 100, pnlR, pnlUsd,
        closedAt: new Date(c.time).toISOString(),
        reason: tpName,
      })
      remainingFrac -= fillFrac
      // BE-only trailing — only if enabled (per-trade override falls back to config default).
      // After TP1 move SL to entry (BE). After TP2/TP3 leave SL at BE — no further trailing.
      const trailEnabled = trade.autoTrailingSL ?? cfg.autoTrailingSL
      if (trailEnabled && nextTpIdx === 0) {
        currentStop = entry
      }
      status = nextTpIdx === 0 ? 'TP1_HIT' : nextTpIdx === 1 ? 'TP2_HIT' : 'TP3_HIT'
      statusChanged = true
      nextTpIdx++

      if (remainingFrac <= 1e-6) {
        status = 'CLOSED'
        break
      }
    }
    if (status === 'CLOSED' || status === 'SL_HIT') break
  }

  // Expiry
  if (status !== 'CLOSED' && status !== 'SL_HIT' && trade.expiresAt && new Date(trade.expiresAt) < new Date()) {
    if (remainingFrac > 1e-6) {
      const lastPrice = newCandles[newCandles.length - 1].close
      const pnlR = ((isLong ? lastPrice - entry : entry - lastPrice) / initialRisk) * remainingFrac
      const fillUnits = positionUnits * remainingFrac
      const pnlUsd = (isLong ? lastPrice - entry : entry - lastPrice) * fillUnits
      realizedR += pnlR
      realizedPnlUsd += pnlUsd
      totalPnlDeltaUsd += pnlUsd
      fills.push({
        price: lastPrice, percent: remainingFrac * 100, pnlR, pnlUsd,
        closedAt: new Date().toISOString(), reason: 'EXPIRED',
      })
    }
    status = 'EXPIRED'
    statusChanged = true
  }

  // Deduct fees on each fill that happened in this cycle.
  // Fee rate: per-trade override → fallback to config default.
  const feeRatePct = trade.feesRoundTripPct ?? cfg.feesRoundTripPct
  const newFills = fills.slice((trade.closes as any[]).length)
  let newFeesUsd = 0
  for (const f of newFills) {
    const notional = positionUnits * f.price * (f.percent / 100)
    newFeesUsd += notional * (feeRatePct / 100)
  }
  const totalFeesUsd = (trade.feesPaidUsd ?? 0) + newFeesUsd
  const netPnlUsd = realizedPnlUsd - totalFeesUsd

  const lastCandle = newCandles[newCandles.length - 1]
  await prisma.levelsPaperTrade.update({
    where: { id: trade.id },
    data: {
      status,
      currentStop,
      realizedR,
      realizedPnlUsd,
      feesPaidUsd: totalFeesUsd,
      netPnlUsd,
      closes: fills as any,
      lastPriceCheck: lastCandle.close,
      lastPriceCheckAt: new Date(lastCandle.time),
      ...(status === 'CLOSED' || status === 'SL_HIT' || status === 'EXPIRED' ? { closedAt: new Date() } : {}),
    },
  })

  return { pnlDelta: totalPnlDeltaUsd - newFeesUsd, statusChanged }
}

async function trackOpenPaperTrades(cfg: PaperConfig): Promise<{ updated: number; depositDelta: number }> {
  const open = await prisma.levelsPaperTrade.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return { updated: 0, depositDelta: 0 }

  const bySymbol = new Map<string, any[]>()
  for (const t of open) {
    const list = bySymbol.get(t.symbol) ?? []
    list.push(t); bySymbol.set(t.symbol, list)
  }

  let totalDelta = 0
  let updated = 0
  for (const [symbol, trades] of bySymbol) {
    try {
      const candles = await loadRecent5m(symbol)
      for (const tr of trades) {
        const r = await trackOnePaper(tr, candles, cfg)
        totalDelta += r.pnlDelta
        if (r.statusChanged) updated++
      }
    } catch (e: any) {
      console.warn(`[Paper] track ${symbol} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta }
}

/**
 * FAST tracker — runs every 2 seconds. Uses last-price (single batch call)
 * instead of 5m klines.
 *
 * Synthesizes a 1-tick candle (high=low=close=price) so we can reuse
 * trackOnePaper's TP/SL/trailing logic. Wicks beyond price won't be detected
 * here, but the slow tracker (5m, every 5 min) will catch any missed wicks
 * because it replays full klines with high/low.
 */
async function trackOpenPaperTradesFast(cfg: PaperConfig): Promise<{ updated: number; depositDelta: number }> {
  const open = await prisma.levelsPaperTrade.findMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
  })
  if (open.length === 0) return { updated: 0, depositDelta: 0 }

  const symbols = [...new Set(open.map((t) => t.symbol))]
  const prices = await fetchPricesBatch(symbols)

  const now = Date.now()
  let totalDelta = 0
  let updated = 0
  for (const tr of open) {
    const price = prices[tr.symbol]
    if (!price || price <= 0) continue
    // Single synthetic tick — high/low/close all equal current price.
    // This covers the common case (price crosses TP/SL between cycles).
    // Wick-only spikes will be picked up by the slow 5m replay.
    const tick: OHLCV = { time: now, open: price, high: price, low: price, close: price, volume: 0 }
    try {
      const r = await trackOnePaper(tr, [tick], cfg)
      totalDelta += r.pnlDelta
      if (r.statusChanged) updated++
    } catch (e: any) {
      console.warn(`[PaperFast] track ${tr.symbol}#${tr.id} failed: ${e.message}`)
    }
  }
  return { updated, depositDelta: totalDelta }
}

async function applyDepositDelta(cfg: PaperConfig, delta: number): Promise<void> {
  if (delta === 0) return
  const newDeposit = cfg.currentDepositUsd + delta
  const newPeak = Math.max(cfg.peakDepositUsd, newDeposit)
  const newDD = newPeak > 0 ? Math.max(cfg.maxDrawdownPct, ((newPeak - newDeposit) / newPeak) * 100) : 0

  // Recompute total trades / wins / losses from DB (authoritative)
  const closed = await prisma.levelsPaperTrade.findMany({
    where: { status: { in: ['CLOSED', 'SL_HIT', 'EXPIRED'] } },
    select: { netPnlUsd: true },
  })
  const totalTrades = closed.length
  const totalWins = closed.filter((t) => t.netPnlUsd > 0).length
  const totalLosses = closed.filter((t) => t.netPnlUsd < 0).length
  const totalPnLUsd = closed.reduce((a, t) => a + t.netPnlUsd, 0)

  await prisma.levelsPaperConfig.update({
    where: { id: 1 },
    data: {
      currentDepositUsd: newDeposit,
      peakDepositUsd: newPeak,
      maxDrawdownPct: newDD,
      totalTrades, totalWins, totalLosses, totalPnLUsd,
    },
  })
}

export async function runPaperCycle(): Promise<{ opened: number; updated: number; depositDelta: number; deposit: number }> {
  const cfg = await getOrCreateConfig()
  if (!cfg) return { opened: 0, updated: 0, depositDelta: 0, deposit: 0 }
  if (!cfg.enabled) return { opened: 0, updated: 0, depositDelta: 0, deposit: cfg.currentDepositUsd }

  const opened = await openNewPaperTrades(cfg)
  const updated = await trackOpenPaperTrades(cfg)
  if (updated.depositDelta !== 0) await applyDepositDelta(cfg, updated.depositDelta)

  const final = await getOrCreateConfig()
  return { opened, updated: updated.updated, depositDelta: updated.depositDelta, deposit: final?.currentDepositUsd ?? 0 }
}

/** Fast cycle — CRYPTO-only TP/SL tracking via last-price. No open/expiry. */
export async function runPaperCycleFast(): Promise<{ updated: number; depositDelta: number }> {
  const cfg = await getOrCreateConfig()
  if (!cfg || !cfg.enabled) return { updated: 0, depositDelta: 0 }

  const r = await trackOpenPaperTradesFast(cfg)
  if (r.depositDelta !== 0) await applyDepositDelta(cfg, r.depositDelta)
  return r
}

export async function resetPaperAccount(newStartingDeposit?: number): Promise<PaperConfig> {
  const cfg = await getOrCreateConfig()
  if (!cfg) throw new Error('Paper config table missing — migration not applied yet')
  const start = newStartingDeposit ?? cfg.startingDepositUsd
  // Mark all open trades as cancelled
  await prisma.levelsPaperTrade.updateMany({
    where: { status: { in: ['OPEN', 'TP1_HIT', 'TP2_HIT'] } },
    data: { status: 'EXPIRED', closedAt: new Date() },
  })
  const updated = await prisma.levelsPaperConfig.update({
    where: { id: 1 },
    data: {
      startingDepositUsd: start,
      currentDepositUsd: start,
      peakDepositUsd: start,
      maxDrawdownPct: 0,
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      totalPnLUsd: 0,
      resetAt: new Date(),
    },
  })
  return updated as PaperConfig
}

let paperInterval: NodeJS.Timeout | null = null
let paperFastInterval: NodeJS.Timeout | null = null
export function startLevelsPaperTrader(): void {
  if (paperInterval) return
  const slowTick = async () => {
    try {
      const r = await runPaperCycle()
      if (r.opened > 0 || r.updated > 0) {
        console.log(`[Paper] slow: opened=${r.opened} updated=${r.updated} delta=${r.depositDelta.toFixed(2)} depo=$${r.deposit.toFixed(2)}`)
      }
    } catch (e: any) {
      console.error('[Paper] slow tick error:', e.message)
    }
  }
  const fastTick = async () => {
    try {
      const r = await runPaperCycleFast()
      if (r.updated > 0) {
        console.log(`[Paper] fast: updated=${r.updated} delta=${r.depositDelta.toFixed(2)}`)
      }
    } catch (e: any) {
      console.error('[Paper] fast tick error:', e.message)
    }
  }
  setTimeout(slowTick, 90_000) // 90s after boot — after live tracker has had a chance to run
  paperInterval = setInterval(slowTick, 5 * 60_000)
  paperFastInterval = setInterval(fastTick, 2_000)
  console.log('[Paper] started (slow=5min, fast=2s for CRYPTO)')
}
export function stopLevelsPaperTrader(): void {
  if (paperInterval) { clearInterval(paperInterval); paperInterval = null }
  if (paperFastInterval) { clearInterval(paperFastInterval); paperFastInterval = null }
}
